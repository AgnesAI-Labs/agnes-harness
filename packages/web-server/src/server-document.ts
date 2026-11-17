import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import { remoteFrontendOrigin } from '@agnes/protocol'
import { fileName, MIME } from './server-assets.js'
import { loopbackWs } from './server-security.js'

/** Public build assets only. Isolated pages receive neither local RPC addresses nor admin handlers. */
export function createWebDocumentResponder(options: {
  root: string
  origin: string
  frameOrigin: string
  wsUrl: URL
  policyFor(ws: URL): string
  refreshWsUrl?: () => Promise<string>
  developmentReload?: boolean
}) {
  const { root, origin, refreshWsUrl, developmentReload, policyFor } = options
  let wsUrl = options.wsUrl
  let contentSecurityPolicy = options.policyFor(wsUrl)
  return async (request: IncomingMessage, response: ServerResponse, isolated = false) => {
    const requestUrl = new URL(request.url ?? '/', origin)
    const file = fileName(request.url ?? '/')
    if (!isolated && file.endsWith('.html') && refreshWsUrl) {
      // A daemon that was restarted advertises a new loopback address; hand the page the current one.
      try {
        const next = loopbackWs(await refreshWsUrl())
        if (next.href !== wsUrl.href) {
          wsUrl = next
          contentSecurityPolicy = policyFor(next)
        }
      } catch {
        // Keep the last known address: a failed refresh must not take the page itself down.
      }
    }
    if (isolated && file.endsWith('.html') && file !== 'index.html') throw new Error('Web asset not found')
    if (isolated && file === 'index.html' && !requestUrl.searchParams.has('remote'))
      throw new Error('Web asset not found')
    let body = await readFile(join(root, file))
    const documentNonce = file.endsWith('.html') ? randomBytes(16).toString('base64') : undefined
    if (file === 'index.html') {
      const html = body.toString()
      const marker = '__AGNES_WS_URL__'
      const occurrences = html.split(marker).length - 1
      if (occurrences !== 1) throw new Error('Web index is missing its connection marker')
      body = Buffer.from(html.replace(marker, isolated ? 'ws://127.0.0.1/disabled' : wsUrl.href))
      if (!isolated)
        body = Buffer.from(
          body
            .toString()
            .replace(
              '<meta id="agnes-config"',
              `<meta id="agnes-config" data-cloud-origin="${options.frameOrigin}"`,
            ),
        )
      if (isolated) {
        const remote = remoteFrontendOrigin(requestUrl.searchParams.get('remote') ?? '')
        body = Buffer.from(
          body
            .toString()
            .replace(
              '<meta id="agnes-config"',
              `<meta id="agnes-config" data-backend-frame="cloud" data-parent-origin="${origin}" data-remote="${remote}"`,
            ),
        )
      }
    }
    if (documentNonce) {
      const html = body.toString()
      const marker = '__AGNES_CSP_NONCE__'
      const occurrences = html.split(marker).length - 1
      if (occurrences !== 1) throw new Error('Web document is missing its CSP nonce marker')
      body = Buffer.from(html.replace(marker, documentNonce))
    }
    if (!isolated && developmentReload && file.endsWith('.html')) {
      const html = body.toString()
      const marker = '</body>'
      if (!html.includes(marker)) throw new Error('Web document is missing its body marker')
      body = Buffer.from(
        html.replace(marker, '<script type="module" src="/__agnes/dev/reload.js"></script></body>'),
      )
    }
    // The main page admits workbench previews and the two MHS media origins. Other pages keep
    // the base policy; CDN access does not extend to scripts or API connections.
    let documentCsp =
      file === 'index.html'
        ? `${contentSecurityPolicy.replace(
            "media-src 'self' blob:",
            "media-src 'self' blob: https://cos-agent-default.agnes-ai.cn https://cos-agent-default.agnes-ai.com",
          )}; img-src 'self' blob: https://cos-agent-default.agnes-ai.cn https://cos-agent-default.agnes-ai.com; frame-src 'self' blob: ${options.frameOrigin}`
        : contentSecurityPolicy
    // This page's explicit backend selection grants only that exact HTTP(S)/WS(S) origin.
    // Local listeners and all local Host/Origin checks above retain their existing behavior.
    const remoteValue = isolated && file === 'index.html' ? requestUrl.searchParams.get('remote') : null
    if (remoteValue !== null) {
      const remote = remoteFrontendOrigin(remoteValue)
      documentCsp = documentCsp
        .replace(/connect-src [^;]+/, `connect-src 'self' ${remote} ${remote.replace(/^http/u, 'ws')}`)
        .replace(/frame-src [^;]+/, `frame-src 'self' blob: ${remote}`)
      documentCsp += `; frame-ancestors ${origin}; form-action 'none'; base-uri 'none'`
      documentCsp = documentCsp
        .replace("script-src 'self'", `script-src 'self' ${remote}`)
        .replace("style-src 'self'", `style-src 'self' ${remote}`)
        .replace("img-src 'self'", `img-src 'self' ${remote}`)
    }
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
  }
}
