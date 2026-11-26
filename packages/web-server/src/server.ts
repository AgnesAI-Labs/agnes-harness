import { createHash, randomBytes } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { extname, isAbsolute } from 'node:path'
import { type AppServerParams, FILE_UPLOAD_PATH } from '@agnes/protocol'
import { noncanonicalAssetPath } from './asset-path.js'
import { serveDeliverablePreview } from './deliverable-preview-frame.js'
import { HISTORY_SEARCH_PATH, handleHistorySearch } from './history-route.js'
import { servePdfPreview } from './pdf-preview-frame.js'
import type { PluginRebuiltEvent, WebServer, WebServerOptions } from './server-types.js'
import { serveUiComponentFrame, UI_COMPONENT_MODULE_BYTES } from './ui-component-frame.js'
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
  PLAN_MODE_PATH,
  SKIN_MIME,
  WORKSPACE_PICKER_PATH,
} from './server-assets.js'
import { createCloudFrameServer } from './server-cloud-frames.js'
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

function clientAssetNotFound(response: ServerResponse): void {
  response
    .writeHead(404, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    .end()
}

/** Start the static Web client. The daemon is intentionally outside this module's lifecycle. */
export async function createWebServer(options: WebServerOptions): Promise<WebServer> {
  if (!isAbsolute(options.root)) throw new Error('Web asset root must be absolute')
  const wsUrl = loopbackWs(options.wsUrl)
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
  const contentSecurityPolicy = policyFor(wsUrl)
  const cloudFrames = await createCloudFrameServer({
    ...options,
    origin: expectedOrigin.origin,
    wsUrl,
    policyFor,
  })
  const serveDocument = cloudFrames.serve

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
      const read = request.method === 'GET' || request.method === 'HEAD'
      if (host !== 'canonical' && !(host === 'alias' && read)) {
        response.writeHead(403).end()
        return
      }
      const requestUrl = new URL(request.url ?? '/', expectedOrigin)
      const assetPath = requestUrl.pathname
      const rawAssetPath = (request.url ?? '/').split('?', 1)[0] ?? '/'
      const pluginAsset = assetPath === '/plugins' || assetPath.startsWith('/plugins/')
      const skinAsset = assetPath === '/skins' || assetPath.startsWith('/skins/')
      if (noncanonicalAssetPath(rawAssetPath, assetPath)) {
        clientAssetNotFound(response)
        return
      }
      if (host === 'alias') {
        response
          .writeHead(307, { Location: `${expectedOrigin.origin}${assetPath}${requestUrl.search}` })
          .end()
        return
      }
      if ((pluginAsset || skinAsset) && !read) {
        response.writeHead(405, { Allow: 'GET, HEAD' }).end()
        return
      }
      if (await options.pluginStreams?.handleHttp(request, response)) return
      if (await handleWebhook?.(request, response)) return
      if (serveDeliverablePreview(request, response)) return
      if (servePdfPreview(request, response)) return
      if (serveUiComponentFrame(request, response)) return
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
      if (skinAsset) {
        const versioned = /^\/skins\/[a-f0-9]{64}\/[a-z0-9]+(?:-[a-z0-9]+)*\//u.test(assetPath)
        const resolved = versioned ? ((await options.skinAsset?.(assetPath)) ?? null) : null
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
      // This reserved namespace never falls through to a Surface or a static file.
      if (pluginAsset) {
        const source = requestUrl.search === '?agnes_ui_source=1'
        const contentType = CLIENT_MODULE_MIME[extname(assetPath).toLowerCase()]
        if (
          !options.clientModuleAsset ||
          !contentType ||
          requestUrl.searchParams.has('agnes_ui_frame') ||
          (!source && requestUrl.searchParams.has('agnes_ui_source')) ||
          (source && contentType !== 'text/javascript')
        ) {
          clientAssetNotFound(response)
          return
        }
        const purpose: AppServerParams<'_agnes/v1/clientModules.read'>['purpose'] = source
          ? 'isolated-component'
          : 'document'
        let bytes: Uint8Array
        let renderer: string | undefined
        try {
          const resolved = await options.clientModuleAsset(assetPath, purpose)
          if (resolved === null || (source && typeof resolved === 'string')) {
            clientAssetNotFound(response)
            return
          }
          if (typeof resolved === 'string') {
            const file = await readFile(resolved)
            await rememberPluginBuild(assetPath, resolved, file)
            bytes = file
          } else {
            bytes = resolved
            if (source) {
              if (bytes.byteLength > UI_COMPONENT_MODULE_BYTES) {
                clientAssetNotFound(response)
                return
              }
              renderer = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
            }
          }
        } catch {
          clientAssetNotFound(response)
          return
        }
        response.writeHead(200, {
          'Content-Type': source ? 'application/json' : contentType,
          'Cache-Control': 'no-store',
          'Content-Security-Policy': contentSecurityPolicy,
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
        })
        if (request.method === 'HEAD') response.end()
        else if (renderer !== undefined) response.end(JSON.stringify({ source: renderer }))
        else if (contentType === 'text/css' && requestUrl.searchParams.get('agnes_css_layer') === 'app') {
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
      await serveDocument(request, response)
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
  const bound = await listen(server, requestedPort).catch(async (error: unknown) => {
    server.close()
    await cloudFrames.close()
    throw error
  })
  const actualOrigin = `http://${HOST}:${bound.port}`
  if (expectedOrigin.origin !== actualOrigin) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await cloudFrames.close()
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
        void cloudFrames.close().then(() => {
          server.close((error) => (error ? reject(error) : resolve()))
        }, reject)
      })),
  }
}
