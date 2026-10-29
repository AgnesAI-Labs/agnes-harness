import { createHash, randomBytes } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { extname, isAbsolute, join } from 'node:path'
import { FILE_UPLOAD_PATH } from '@agnes/protocol'
import { DELIVERABLE_PREVIEW_PATH, deliverablePreviewFrame } from './deliverable-preview-frame.js'
import { HISTORY_SEARCH_PATH, handleHistorySearch } from './history-route.js'
import type { PluginRebuiltEvent, WebServer, WebServerOptions } from './server-types.js'
import { UI_COMPONENT_MODULE_BYTES, uiComponentFrame } from './ui-component-frame.js'
import { fileUploadRoute } from './upload-route.js'
import { webhookRoute } from './webhook-route.js'
import { createWorkspacePickerRoute, handlePlanMode } from './workspace-routes.js'

export { DEFAULT_WEB_PORT, PLAN_MODE_PATH, WORKSPACE_PICKER_PATH } from './server-assets.js'
export type {
  ClientModuleAssetResolution,
  PluginRebuiltEvent,
  SkinAssetResolution,
  WebServer,
  WebServerOptions,
  WorkspacePicker,
  WorkspacePickerResult,
} from './server-types.js'

import {
  CLIENT_MODULE_MIME,
  DEFAULT_WEB_PORT,
  fileName,
  HOST,
  importMapScriptHash,
  MIME,
  PLAN_MODE_PATH,
  SKIN_MIME,
  WORKSPACE_PICKER_PATH,
} from './server-assets.js'
import { json, listen } from './server-http.js'
import {
  acceptsWebRequest,
  crossSiteWrite,
  loopbackHost,
  loopbackOrigin,
  loopbackWs,
  port,
} from './server-security.js'

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
  let wsUrl = loopbackWs(options.wsUrl)
  const surfaceNotReady = (requestUrl: string, response: ServerResponse): boolean => {
    const pathname = new URL(requestUrl, 'http://127.0.0.1').pathname
    if (options.surfaceMountsReady?.(pathname) !== false) return false
    response
      .writeHead(503, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Retry-After': '1',
      })
      .end('Surface mount table is not ready yet; retry shortly.')
    return true
  }
  // Hash the inline index.html import map body with SHA-256 and add it to CSP script-src, using a strict hash
  // without weakening the policy. Hash the exact bytes between <script type="importmap"> and </script>, as the browser does.
  // If missing or unparseable, add no hash: the browser refuses the inline map and the page loads without plugin modules (fail-closed).
  const importMapHash = await importMapScriptHash(options.root)
  // Static assets share the base policy. Each HTML response adds its own nonce for Ant Design's
  // CSS-in-JS styles; it is also inserted into that document for ConfigProvider to consume.
  const requestedPort = port(options.port ?? DEFAULT_WEB_PORT)
  const expectedOrigin = loopbackOrigin(options.origin ?? `http://${HOST}:${requestedPort}`)
  if (expectedOrigin.hostname !== HOST && expectedOrigin.hostname !== 'localhost')
    throw new Error('Web origin must use the IPv4 loopback host')
  if (requestedPort !== 0 && Number(expectedOrigin.port || 80) !== requestedPort)
    throw new Error('Web origin port does not match Web listener port')
  if (requestedPort === 0 && !expectedOrigin.port)
    throw new Error('Web origin must include the selected Web listener port')
  const policyFor = (ws: URL): string =>
    `default-src 'self'; media-src 'self' blob:; connect-src 'self' ${expectedOrigin.origin.replace(/^http/, 'ws')} ${ws.origin.replace(/^http/, 'ws')}; style-src 'self'; script-src 'self'${importMapHash ? ` 'sha256-${importMapHash}'` : ''}`
  let contentSecurityPolicy = policyFor(wsUrl)

  const handleWorkspacePicker = createWorkspacePickerRoute(expectedOrigin.origin, options)
  const changeEpoch = randomBytes(16).toString('hex')
  let changeCursor = 0
  let developmentRevision = 0
  const changes: { cursor: number; id: string; rev: string }[] = []
  const pluginEventClients = new Set<ServerResponse>()
  const developmentReloadClients = new Set<ServerResponse>()
  const watchedPluginBuilds = new Map<string, WatchedPluginBuild>()
  let pluginBuildPoller: ReturnType<typeof setInterval> | undefined
  let pluginBuildPollInFlight = false
  // Older pages must release their HTTP/1.1 connection too; current clients use finite polls.
  const boundReloadStream = (response: ServerResponse): void => {
    const timer = setTimeout(() => response.end(), 500)
    response.once('close', () => clearTimeout(timer))
  }
  const writeSseEvent = (response: ServerResponse, event: string, data: unknown): void => {
    if (!response.writableEnded)
      response.write(
        `${event === 'graph' ? 'retry: 1000\n\n' : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
      )
  }
  const emitPluginRebuilt = (event: PluginRebuiltEvent): void => {
    changes.push({ cursor: ++changeCursor, id: event.packageId, rev: event.revision })
    if (changes.length > 256) changes.shift()
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
  const handleFileUpload = fileUploadRoute(expectedOrigin.origin, options.fileUpload)
  const handleWebhook = options.triggers ? webhookRoute(expectedOrigin.origin, options.triggers) : undefined
  const server = createServer(async (request, response) => {
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Web listener is not bound')
      const host = loopbackHost(request.headers.host, `${HOST}:${address.port}`, address.port)
      // Another loopback name (a `localhost` bookmark) is sent to the one page origin every
      // route checks against; any other Host is a rebinding domain and gets nothing.
      if (host === 'alias' && (request.method === 'GET' || request.method === 'HEAD')) {
        const target = new URL(request.url ?? '/', expectedOrigin)
        response
          .writeHead(307, { Location: `${expectedOrigin.origin}${target.pathname}${target.search}` })
          .end()
        return
      }
      if (host !== 'canonical') {
        response.writeHead(403).end()
        return
      }
      if (await options.pluginStreams?.handleHttp(request, response)) return
      if (await handleWebhook?.(request, response)) return
      const requestUrl = new URL(request.url ?? '/', expectedOrigin)
      if (requestUrl.pathname === DELIVERABLE_PREVIEW_PATH) {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405).end()
          return
        }
        const frame = deliverablePreviewFrame()
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': frame.csp,
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
        })
        response.end(request.method === 'HEAD' ? undefined : frame.body)
        return
      }
      if (requestUrl.pathname === FILE_UPLOAD_PATH) {
        await handleFileUpload(request, response)
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
        await handleWorkspacePicker.handle(request, response)
        return
      }
      if (requestUrl.pathname === PLAN_MODE_PATH) {
        await handlePlanMode(request, response, expectedOrigin.origin, options)
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
            : `let revision; let stopped = false; let controller; let timer;
async function poll() {
  controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch('/__agnes/dev/revision', { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('reload poll failed');
    const next = await response.text();
    if (revision !== undefined && revision !== next) location.reload();
    revision = next;
  } catch {} finally {
    clearTimeout(timeout);
    if (!stopped) timer = setTimeout(poll, 1000);
  }
}
addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); controller?.abort(); });
addEventListener('pageshow', () => { if (stopped) { stopped = false; void poll(); } });
void poll();\n`,
        )
        return
      }
      if (request.url === '/__agnes/dev/revision') {
        if (!options.developmentReload) {
          response.writeHead(404).end()
          return
        }
        if (request.method !== 'GET') {
          response.writeHead(405, { Allow: 'GET' }).end()
          return
        }
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
        response.end(`${changeEpoch}:${developmentRevision}`)
        return
      }
      if (request.url?.split('?')[0] === '/plugins/changes') {
        if (request.method !== 'GET') {
          response.writeHead(405, { Allow: 'GET' }).end()
          return
        }
        const query = new URL(request.url, expectedOrigin).searchParams
        const rawCursor = query.get('cursor')
        const cursor = rawCursor === null ? 0 : Number(rawCursor)
        if (!Number.isSafeInteger(cursor) || cursor < 0) {
          response.writeHead(400).end()
          return
        }
        const epoch = query.get('epoch')
        const reset =
          (epoch !== null && epoch !== changeEpoch) ||
          cursor > changeCursor ||
          (rawCursor !== null && cursor < (changes[0]?.cursor ?? 1) - 1)
        json(response, 200, {
          epoch: changeEpoch,
          cursor: changeCursor,
          reset,
          events: changes.filter((event) => event.cursor > cursor),
        })
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
        boundReloadStream(response)
        developmentReloadClients.add(response)
        const close = (): void => {
          developmentReloadClients.delete(response)
        }
        request.once('aborted', close)
        response.once('close', close)
        return
      }
      // Every route above checks its own origin. From here on (admin BFF, client-module services,
      // mounted Surface APIs) no write is accepted from a page on another site.
      if (crossSiteWrite(expectedOrigin.origin, request)) {
        request.resume()
        json(response, 403, { error: { code: 'ORIGIN_REJECTED' } })
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
        boundReloadStream(response)
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
        if (acceptsWebRequest('mount-write', expectedOrigin.origin, request)) {
          if (options.mountProxy?.(request, response)) return
          // A built-in asset keeps its method refusal even while the mount query is pending.
          try {
            fileName(request.url ?? '/')
          } catch {
            if (surfaceNotReady(request.url ?? '/', response)) return
          }
        }
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
      // Client module assets follow the skin branch's exact shape: the resolver owns
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
        if (new URL(request.url ?? '/', expectedOrigin).searchParams.get('agnes_ui_frame') === '1') {
          if (
            !['.js', '.mjs'].includes(extname(named).toLowerCase()) ||
            bytes.length > UI_COMPONENT_MODULE_BYTES
          ) {
            response.writeHead(404).end()
            return
          }
          const frame = uiComponentFrame(bytes.toString('utf8'))
          response.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy': frame.csp,
            'Referrer-Policy': 'no-referrer',
            'X-Content-Type-Options': 'nosniff',
          })
          response.end(request.method === 'HEAD' ? undefined : frame.body)
          return
        }
        if (typeof resolved === 'string') await rememberPluginBuild(assetPath, resolved, bytes)
        response.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'no-store',
          'Content-Security-Policy': contentSecurityPolicy,
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
        })
        if (request.method === 'HEAD') response.end()
        else if (
          contentType === 'text/css' &&
          new URL(request.url ?? '/', expectedOrigin).searchParams.get('agnes_css_layer') === 'app'
        ) {
          // A layered import preserves the stylesheet's own relative imports and asset URLs.
          response.end(`@import url(${JSON.stringify(assetPath)}) layer(app);\n`)
        } else response.end(bytes)
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
      if (file.endsWith('.html') && options.refreshWsUrl) {
        // A daemon that was restarted advertises a new loopback address; hand the page the current one.
        try {
          const next = loopbackWs(await options.refreshWsUrl())
          if (next.href !== wsUrl.href) {
            wsUrl = next
            contentSecurityPolicy = policyFor(next)
          }
        } catch {
          // Keep the last known address: a failed refresh must not take the page itself down.
        }
      }
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
      if (missing && surfaceNotReady(request.url ?? '/', response)) return
      response.writeHead(missing ? 404 : 500).end(missing ? '' : 'web assets unavailable')
    }
  })
  server.on('upgrade', (request, socket, head) => {
    void Promise.resolve(options.pluginStreams?.handleUpgrade(request, socket, head))
      .then((claimed) => {
        if (!claimed) socket.destroy()
      })
      .catch(() => socket.destroy())
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
      developmentRevision++
      for (const response of developmentReloadClients) writeSseEvent(response, 'reload', {})
    },
    close: () =>
      (closing ??= new Promise<void>((resolve, reject) => {
        options.pluginStreams?.close()
        handleWorkspacePicker.close()
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
