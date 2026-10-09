import { createHash, randomBytes } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { extname, isAbsolute, join } from 'node:path'
import { httpRpcError, normalizeRpcError, type RpcError } from '@agnes/protocol'
import { HISTORY_SEARCH_PATH, handleHistorySearch } from './history-route.js'
import { FILE_UPLOAD_PATH } from '@agnes/protocol'
import { handleFileUpload } from './upload-route.js'
import { webhookRoute } from './webhook-route.js'
import type { PluginRebuiltEvent, WebServerOptions, WebServer } from './server-types.js'
export type {
  SkinAssetResolution,
  ClientModuleAssetResolution,
  PluginRebuiltEvent,
  WebServerOptions,
  WorkspacePickerResult,
  WorkspacePicker,
  WebServer,
} from './server-types.js'
export { DEFAULT_WEB_PORT, WORKSPACE_PICKER_PATH, PLAN_MODE_PATH } from './server-assets.js'
import {
  DEFAULT_WEB_PORT,
  WORKSPACE_PICKER_PATH,
  PLAN_MODE_PATH,
  PLAN_MODE_BODY_LIMIT,
  HOST,
  MIME,
  SKIN_MIME,
  CLIENT_MODULE_MIME,
  importMapScriptHash,
  fileName,
} from './server-assets.js'
import { loopbackOrigin, loopbackWs, port } from './server-security.js'
import { readLimitedBody, json, listen } from './server-http.js'

type WatchedPluginBuild = {
  packageId: string
  revision: string
  mtimeMs: number
  size: number
  digest: string
}
/** Start the static Web client. The daemon is intentionally outside this module's lifecycle. */
export async function createWebServer(options: WebServerOptions): Promise<WebServer> {
  if (!isAbsolute(options.root)) throw new Error('Web asset root must be absolute')
  const wsUrl = loopbackWs(options.wsUrl)
  // WC5：对 index.html 内联 import map 的脚本体计算 SHA-256，追加进 CSP script-src（严格哈希，
  // 不放宽策略）。哈希输入是 <script type="importmap"> 与 </script> 之间的精确字节（浏览器语义）。
  // 缺失或解析失败时不追加哈希：内联 import map 会被浏览器拒绝，页面退回无插件模块的现状（fail-closed）。
  const importMapHash = await importMapScriptHash(options.root)
  // Static assets share the base policy. Each HTML response adds its own nonce for Ant Design's
  // CSS-in-JS styles; it is also inserted into that document for ConfigProvider to consume.
  const contentSecurityPolicy = `default-src 'self'; connect-src 'self' ${wsUrl.origin.replace(/^http/, 'ws')}; style-src 'self'; script-src 'self'${importMapHash ? ` 'sha256-${importMapHash}'` : ''}`
  const requestedPort = port(options.port ?? DEFAULT_WEB_PORT)
  const expectedOrigin = loopbackOrigin(options.origin ?? `http://${HOST}:${requestedPort}`)
  if (expectedOrigin.hostname !== HOST && expectedOrigin.hostname !== 'localhost')
    throw new Error('Web origin must use the IPv4 loopback host')
  if (requestedPort !== 0 && Number(expectedOrigin.port || 80) !== requestedPort)
    throw new Error('Web origin port does not match Web listener port')
  if (requestedPort === 0 && !expectedOrigin.port)
    throw new Error('Web origin must include the selected Web listener port')

  let pickerPending = false
  let activePicker: AbortController | undefined
  const pluginEventClients = new Set<ServerResponse>()
  const developmentReloadClients = new Set<ServerResponse>()
  const watchedPluginBuilds = new Map<string, WatchedPluginBuild>()
  let pluginBuildPoller: ReturnType<typeof setInterval> | undefined
  let pluginBuildPollInFlight = false
  const writeSseEvent = (response: ServerResponse, event: string, data: unknown): void => {
    if (!response.writableEnded) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  const emitPluginRebuilt = (event: PluginRebuiltEvent): void => {
    for (const response of pluginEventClients)
      writeSseEvent(response, 'rebuilt', { type: 'rebuilt', id: event.packageId, rev: event.revision })
  }
  const rememberPluginBuild = async (pathname: string, file: string, bytes: Buffer): Promise<void> => {
    const segments = pathname.split('/').filter(Boolean)
    const revisionIndex = segments.findIndex((segment) =>
      /^(?:sha256-|sha512-)/.test(decodeURIComponent(segment)),
    )
    if (revisionIndex < 2) return
    const revision = decodeURIComponent(segments[revisionIndex] ?? '')
    const packageId = segments.slice(1, revisionIndex).map(decodeURIComponent).join('/')
    try {
      const metadata = await stat(file)
      watchedPluginBuilds.set(file, {
        packageId,
        revision,
        mtimeMs: metadata.mtimeMs,
        size: metadata.size,
        digest: createHash('sha256').update(bytes).digest('hex'),
      })
      if (pluginBuildPoller === undefined) {
        const interval = options.pluginBuildPollMs ?? 500
        if (!Number.isFinite(interval) || interval <= 0) throw new Error('invalid plugin build poll interval')
        pluginBuildPoller = setInterval(() => {
          if (pluginBuildPollInFlight) return
          pluginBuildPollInFlight = true
          void (async () => {
            for (const [path, previous] of watchedPluginBuilds) {
              let metadata: Awaited<ReturnType<typeof stat>>
              try {
                metadata = await stat(path)
              } catch {
                continue
              }
              if (metadata.mtimeMs === previous.mtimeMs && metadata.size === previous.size) continue
              let nextBytes: Buffer
              try {
                nextBytes = await readFile(path)
              } catch {
                continue
              }
              const digest = createHash('sha256').update(nextBytes).digest('hex')
              watchedPluginBuilds.set(path, {
                ...previous,
                mtimeMs: metadata.mtimeMs,
                size: metadata.size,
                digest,
              })
              if (digest !== previous.digest)
                emitPluginRebuilt({ packageId: previous.packageId, revision: previous.revision })
            }
          })().finally(() => {
            pluginBuildPollInFlight = false
          })
        }, interval)
        pluginBuildPoller.unref?.()
      }
    } catch {
      // A resolver may hand back bytes instead of a local file. Such an asset remains supported;
      // only file-backed development artifacts participate in stat polling.
    }
  }
  let stopPluginEvents: (() => void) | undefined
  if (options.subscribePluginEvents) {
    try {
      stopPluginEvents = await options.subscribePluginEvents((event) => {
        emitPluginRebuilt(event)
      })
    } catch {
      // Hot reload is an optional developer affordance. A temporarily unavailable daemon must not
      // prevent the ordinary page (and its normal roster invalidation channel) from starting.
    }
  }
  const handleWebhook = options.triggers ? webhookRoute(expectedOrigin.origin, options.triggers) : undefined
  const server = createServer(async (request, response) => {
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Web listener is not bound')
      const expectedHost = `${HOST}:${address.port}`
      if (request.headers.host !== expectedHost) {
        response.writeHead(403).end()
        return
      }
      if (await handleWebhook?.(request, response)) return
      const requestUrl = new URL(request.url ?? '/', expectedOrigin)
      if (requestUrl.pathname === FILE_UPLOAD_PATH) {
        await handleFileUpload(request, response, expectedOrigin.origin, options.fileUpload)
        return
      }
      if (requestUrl.pathname === HISTORY_SEARCH_PATH) {
        const result = await handleHistorySearch({
          method: request.method,
          search: requestUrl.search,
          origin: typeof request.headers.origin === 'string' ? request.headers.origin : undefined,
          site: request.headers['sec-fetch-site'],
          expectedOrigin: expectedOrigin.origin,
          ...(options.historySearch ? { searchHistory: options.historySearch } : {}),
        })
        json(response, result.status, result.body)
        return
      }
      if (requestUrl.pathname === WORKSPACE_PICKER_PATH) {
        const site = request.headers['sec-fetch-site']
        if (
          requestUrl.origin !== expectedOrigin.origin ||
          request.url !== WORKSPACE_PICKER_PATH ||
          requestUrl.search !== '' ||
          (site !== undefined && site !== 'same-origin' && site !== 'none') ||
          (request.headers.origin !== undefined && request.headers.origin !== expectedOrigin.origin)
        ) {
          json(response, 403, { error: { code: 'ORIGIN_REJECTED' } })
          return
        }
        if (request.method !== 'GET' && request.method !== 'POST') {
          response.writeHead(405, { Allow: 'GET, POST' }).end()
          return
        }
        if (request.method === 'GET') {
          const available = (await options.workspacePicker?.available().catch(() => false)) ?? false
          json(response, 200, { available })
          return
        }
        if (request.headers.origin !== expectedOrigin.origin) {
          json(response, 403, { error: { code: 'ORIGIN_REJECTED' } })
          return
        }
        if (
          request.headers['transfer-encoding'] !== undefined ||
          Number(request.headers['content-length'] ?? '0') !== 0
        ) {
          json(response, 400, { error: { code: 'INVALID_REQUEST' } })
          return
        }
        if (pickerPending) {
          json(response, 409, { error: { code: 'PICKER_BUSY' } })
          return
        }
        pickerPending = true
        const controller = new AbortController()
        activePicker = controller
        const abort = (): void => controller.abort()
        request.once('aborted', abort)
        response.once('close', abort)
        try {
          const available = (await options.workspacePicker?.available().catch(() => false)) ?? false
          if (controller.signal.aborted && !response.writableEnded) return
          if (!available || !options.workspacePicker) {
            json(response, 503, { status: 'unavailable' })
            return
          }
          const result = await options.workspacePicker
            .pick(controller.signal)
            .catch(() => ({ status: 'unavailable' }) as const)
          if (controller.signal.aborted && !response.writableEnded) return
          if (
            result.status === 'selected' &&
            (result.path.length === 0 ||
              result.path.length > 4096 ||
              result.path.includes('\0') ||
              !isAbsolute(result.path))
          ) {
            json(response, 503, { status: 'unavailable' })
            return
          }
          json(response, result.status === 'unavailable' ? 503 : 200, result)
        } finally {
          request.removeListener('aborted', abort)
          response.removeListener('close', abort)
          if (activePicker === controller) activePicker = undefined
          pickerPending = false
        }
        return
      }
      if (requestUrl.pathname === PLAN_MODE_PATH) {
        const site = request.headers['sec-fetch-site']
        if (
          requestUrl.origin !== expectedOrigin.origin ||
          request.url !== PLAN_MODE_PATH ||
          requestUrl.search !== '' ||
          (site !== undefined && site !== 'same-origin' && site !== 'none') ||
          (request.headers.origin !== undefined && request.headers.origin !== expectedOrigin.origin)
        ) {
          json(response, 403, { error: { code: 'ORIGIN_REJECTED' } })
          return
        }
        if (request.method !== 'POST') {
          response.writeHead(405, { Allow: 'POST' }).end()
          return
        }
        if (request.headers.origin !== expectedOrigin.origin) {
          json(response, 403, { error: { code: 'ORIGIN_REJECTED' } })
          return
        }
        const contentType = request.headers['content-type']
        if (
          request.headers['transfer-encoding'] !== undefined ||
          typeof contentType !== 'string' ||
          !contentType.startsWith('application/json')
        ) {
          json(response, 400, { error: { code: 'INVALID_REQUEST' } })
          return
        }
        const length = Number(request.headers['content-length'] ?? '')
        if (!Number.isInteger(length) || length < 2 || length > PLAN_MODE_BODY_LIMIT) {
          json(response, 400, { error: { code: 'INVALID_REQUEST' } })
          return
        }
        let raw: string
        try {
          raw = await readLimitedBody(request, length)
        } catch {
          if (!response.writableEnded) json(response, 400, { error: { code: 'INVALID_REQUEST' } })
          return
        }
        let parsed: { cwd?: unknown; line?: unknown }
        try {
          parsed = JSON.parse(raw) as { cwd?: unknown; line?: unknown }
        } catch {
          json(response, 400, { error: { code: 'INVALID_REQUEST' } })
          return
        }
        if (typeof parsed.cwd !== 'string' || typeof parsed.line !== 'string') {
          json(response, 400, { error: { code: 'INVALID_REQUEST' } })
          return
        }
        if (!options.planCommand) {
          json(response, 503, { error: httpRpcError(503, 'UNAVAILABLE') })
          return
        }
        try {
          json(response, 200, await options.planCommand({ cwd: parsed.cwd, line: parsed.line }))
        } catch (error) {
          const rpc = (error as { rpc?: RpcError })?.rpc
          json(response, rpc?.code === -32006 ? 403 : 400, {
            error: rpc ? normalizeRpcError(rpc) : httpRpcError(400, 'INVALID_REQUEST'),
          })
        }
        return
      }
      if (request.url === '/__agnes/dev/reload.js') {
        if (!options.developmentReload) {
          response.writeHead(404).end()
          return
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405, { Allow: 'GET, HEAD' }).end()
          return
        }
        response.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': contentSecurityPolicy,
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
        })
        response.end(
          request.method === 'HEAD'
            ? undefined
            : `const events = new EventSource('/__agnes/dev/events');\nevents.addEventListener('reload', () => location.reload());\n`,
        )
        return
      }
      if (request.url === '/__agnes/dev/events') {
        if (!options.developmentReload) {
          response.writeHead(404).end()
          return
        }
        if (request.method !== 'GET') {
          response.writeHead(405, { Allow: 'GET' }).end()
          return
        }
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'Content-Security-Policy': contentSecurityPolicy,
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
        })
        response.flushHeaders()
        developmentReloadClients.add(response)
        const close = (): void => {
          developmentReloadClients.delete(response)
        }
        request.once('aborted', close)
        response.once('close', close)
        return
      }
      if (options.handleAdmin && (await options.handleAdmin(request, response))) return
      if (request.url === '/plugins/events') {
        if (request.method !== 'GET') {
          response.writeHead(405, { Allow: 'GET' }).end()
          return
        }
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'Content-Security-Policy': contentSecurityPolicy,
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
        })
        response.flushHeaders()
        pluginEventClients.add(response)
        // A graph marker establishes the stream boundary without exposing an installed-package list.
        writeSseEvent(response, 'graph', { type: 'graph' })
        const close = (): void => {
          pluginEventClients.delete(response)
        }
        request.once('aborted', close)
        response.once('close', close)
        return
      }
      const adminPath = request.url ?? ''
      if (
        adminPath.startsWith('/admin/api/') ||
        adminPath.startsWith('/admin/plugins/api/') ||
        adminPath.startsWith('/admin/resources/api/')
      ) {
        response.writeHead(503, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        response.end(
          JSON.stringify({
            error: {
              code: 'ADMIN_UNAVAILABLE',
              message: adminPath.startsWith('/admin/plugins/api/')
                ? 'The plugin admin service is temporarily unavailable.'
                : 'The resource admin service is temporarily unavailable.',
            },
          }),
        )
        return
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        // A mounted Surface's business API writes, so a non-read request may reach mountProxy - but
        // only from this exact page origin: the Host check above cannot stop a cross-site form POST.
        // Every other non-read request keeps the plain 405 it always had.
        const site = request.headers['sec-fetch-site']
        if (
          request.headers.origin === expectedOrigin.origin &&
          (site === undefined || site === 'same-origin') &&
          options.mountProxy?.(request, response)
        )
          return
        response.writeHead(405, { Allow: 'GET, HEAD' }).end()
        return
      }
      const assetPath = new URL(request.url ?? '/', expectedOrigin).pathname
      if (options.skinAsset && assetPath.startsWith('/skins/')) {
        const resolved = await options.skinAsset(assetPath)
        // A file answers for its own extension; bytes have no path of their own, so the request
        // path names the type. Both are the same extension under this route, because the resolver
        // only ever accepts the installer's asset allowlist.
        const named = typeof resolved === 'string' ? resolved : assetPath
        const contentType = resolved === null ? undefined : SKIN_MIME[extname(named).toLowerCase()]
        if (resolved === null || contentType === undefined) {
          response.writeHead(404, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
          })
          response.end()
          return
        }
        response.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'no-store',
          'Content-Security-Policy': contentSecurityPolicy,
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
        })
        if (request.method === 'HEAD') response.end()
        else response.end(typeof resolved === 'string' ? await readFile(resolved) : resolved)
        return
      }
      // Client module assets (design WC3) follow the skin branch's exact shape: the resolver owns
      // path authority, this route owns method, MIME and headers, and a miss, an unknown suffix and
      // a refusal are the one same 404. It must sit before mountProxy so a mounted Surface can never
      // claim the reserved `/plugins` prefix.
      if (options.clientModuleAsset && assetPath.startsWith('/plugins/')) {
        const resolved = await options.clientModuleAsset(assetPath)
        const named = typeof resolved === 'string' ? resolved : assetPath
        const contentType = resolved === null ? undefined : CLIENT_MODULE_MIME[extname(named).toLowerCase()]
        if (resolved === null || contentType === undefined) {
          response.writeHead(404, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
          })
          response.end()
          return
        }
        const bytes = typeof resolved === 'string' ? await readFile(resolved) : Buffer.from(resolved)
        if (typeof resolved === 'string') await rememberPluginBuild(assetPath, resolved, bytes)
        response.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'no-store',
          'Content-Security-Policy': contentSecurityPolicy,
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
        })
        if (request.method === 'HEAD') response.end()
        else response.end(bytes)
        return
      }
      // A mounted Surface owns its whole prefix (e.g. `/demo`), so it must be consulted before the
      // static asset whitelist below -- otherwise fileName() rejects it as an unknown asset. Placed
      // last among the pre-static branches so it cannot shadow any of them (see the option's doc
      // comment); it also cannot shadow fileName()'s own `/`, `/admin/plugins` or `/admin/resources`
      // special cases, because a live Surface's mount prefix is operator-configured in the trusted
      // deploy directory (never `/`, since the mount schema requires at least one path segment) and
      // the launcher's mount-table filter refuses the reserved `/plugins`, `/admin` and `/skins`
      // prefixes (see packages/cli/launch/surface-mounts.ts).
      if (options.mountProxy?.(request, response)) return
      const file = fileName(request.url ?? '/')
      let body = await readFile(join(options.root, file))
      const documentNonce = file.endsWith('.html') ? randomBytes(16).toString('base64') : undefined
      if (file === 'index.html') {
        const html = body.toString()
        const marker = '__AGNES_WS_URL__'
        const occurrences = html.split(marker).length - 1
        if (occurrences !== 1) throw new Error('Web index is missing its connection marker')
        body = Buffer.from(html.replace(marker, wsUrl.href))
      }
      if (documentNonce) {
        const html = body.toString()
        const marker = '__AGNES_CSP_NONCE__'
        const occurrences = html.split(marker).length - 1
        if (occurrences !== 1) throw new Error('Web document is missing its CSP nonce marker')
        body = Buffer.from(html.replace(marker, documentNonce))
      }
      if (options.developmentReload && file.endsWith('.html')) {
        const html = body.toString()
        const marker = '</body>'
        if (!html.includes(marker)) throw new Error('Web document is missing its body marker')
        body = Buffer.from(
          html.replace(marker, '<script type="module" src="/__agnes/dev/reload.js"></script></body>'),
        )
      }
      // Only the workbench consumes local image/PDF resource URLs; other pages keep the base policy.
      const documentCsp =
        file === 'index.html'
          ? `${contentSecurityPolicy}; img-src 'self' blob:; frame-src 'self' blob:`
          : contentSecurityPolicy
      const responseCsp = documentNonce
        ? documentCsp.replace("style-src 'self'", `style-src 'self' 'nonce-${documentNonce}'`)
        : documentCsp
      const headers = {
        'Content-Type': `${MIME[extname(file)] ?? 'application/octet-stream'}; charset=utf-8`,
        'Cache-Control': 'no-store',
        'Content-Security-Policy': responseCsp,
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      }
      response.writeHead(200, headers)
      if (request.method === 'HEAD') response.end()
      else response.end(body)
    } catch (error) {
      const missing = error instanceof Error && error.message === 'Web asset not found'
      response.writeHead(missing ? 404 : 500).end(missing ? '' : 'web assets unavailable')
    }
  })
  const sockets = new Set<import('node:net').Socket>()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  const bound = await listen(server, requestedPort).catch((error: unknown) => {
    server.close()
    throw error
  })
  const actualOrigin = `http://${HOST}:${bound.port}`
  if (expectedOrigin.origin !== actualOrigin) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new Error(`Web listener origin mismatch: expected ${expectedOrigin.origin}`)
  }
  let closing: Promise<void> | undefined
  return {
    url: actualOrigin,
    reloadDevelopmentClients: () => {
      for (const response of developmentReloadClients) writeSseEvent(response, 'reload', {})
    },
    close: () =>
      (closing ??= new Promise<void>((resolve, reject) => {
        activePicker?.abort()
        stopPluginEvents?.()
        if (pluginBuildPoller !== undefined) clearInterval(pluginBuildPoller)
        for (const response of pluginEventClients) response.end()
        pluginEventClients.clear()
        for (const response of developmentReloadClients) response.end()
        developmentReloadClients.clear()
        for (const socket of sockets) socket.destroy()
        server.close((error) => (error ? reject(error) : resolve()))
      })),
  }
}
