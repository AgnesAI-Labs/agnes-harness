import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { DELIVERABLE_PREVIEW_PATH, deliverablePreviewFrame } from '../src/deliverable-preview-frame.js'
import { PDF_PREVIEW_PATH, pdfPreviewFrame } from '../src/pdf-preview-frame.js'
import { createWebServer, type WebServerOptions } from '../src/server.js'
import { UI_COMPONENT_FRAME_PATH } from '../src/ui-component-frame.js'

async function started(cloudGateway?: WebServerOptions['cloudGateway']) {
  const root = mkdtempSync(join(tmpdir(), 'agnes-web-guard-'))
  writeFileSync(
    join(root, 'index.html'),
    '<html><meta id="agnes-config"><meta content="__AGNES_CSP_NONCE__"><script>"__AGNES_WS_URL__"</script></html>',
  )
  const reservation = createServer()
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve))
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('missing synthetic port')
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  const admin: string[] = []
  const web = await createWebServer({
    root,
    ...(cloudGateway ? { cloudGateway } : {}),
    wsUrl: 'ws://127.0.0.1:4312',
    port: address.port,
    handleAdmin: async (request, response) => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      if (!path.startsWith('/admin/resources/api/')) return false
      request.resume()
      admin.push(`${request.method} ${path}`)
      response.writeHead(200).end('{}')
      return true
    },
  })
  return { root, web, admin, port: address.port }
}

it('serves the same isolated preview bootstraps from local and cloud page origins', async () => {
  const { root, web, admin } = await started()
  try {
    const html = await (await fetch(web.url)).text()
    expect((await fetch(web.url)).headers.get('content-security-policy')).toMatch(/connect-src [^;]*blob:/)
    writeFileSync(
      join(root, 'admin.html'),
      '<html><meta content="__AGNES_CSP_NONCE__"><script>"__AGNES_WS_URL__"</script></html>',
    )
    const adminPage = await fetch(web.url + '/admin.html')
    expect(adminPage.status).toBe(200)
    expect(adminPage.headers.get('content-security-policy')).not.toMatch(/connect-src [^;]*blob:/)
    const cloudOrigin = /data-cloud-origin="([^"]+)"/u.exec(html)?.[1]
    if (!cloudOrigin) throw Error('missing isolated origin')
    expect(adminPage.headers.get('content-security-policy')).not.toContain(cloudOrigin)
    const nonces = new Set()
    for (const origin of [web.url, cloudOrigin]) {
      for (const [path, frame] of [
        [DELIVERABLE_PREVIEW_PATH, deliverablePreviewFrame()],
        [PDF_PREVIEW_PATH, pdfPreviewFrame()],
      ] as const) {
        for (const method of ['GET', 'HEAD']) {
          const response = await fetch(origin + path, { method })
          expect(response.status, `${origin} ${method}`).toBe(200)
          expect(response.headers.get('content-security-policy')).toBe(frame.csp)
          expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
          expect(response.headers.get('cache-control')).toBe('no-store')
          expect(response.headers.get('referrer-policy')).toBe('no-referrer')
          expect(response.headers.get('x-content-type-options')).toBe('nosniff')
          expect(await response.text()).toBe(method === 'HEAD' ? '' : frame.body)
        }
      }
      for (const method of ['GET', 'HEAD']) {
        const response = await fetch(origin + UI_COMPONENT_FRAME_PATH, { method })
        expect(response.status).toBe(200)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(response.headers.get('referrer-policy')).toBe('no-referrer')
        expect(response.headers.get('x-content-type-options')).toBe('nosniff')
        const csp = response.headers.get('content-security-policy') ?? ''
        const nonce = /script-src 'nonce-([^']+)'/u.exec(csp)?.[1]
        expect(nonce).toBeTruthy()
        expect(nonces.has(nonce)).toBe(false)
        nonces.add(nonce)
        expect(csp).toBe(
          `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'; sandbox allow-scripts`,
        )
        const body = await response.text()
        if (method === 'HEAD') expect(body).toBe('')
        else {
          expect(body).toContain('agnes-ui-loaded')
          expect(body).toContain('event.source !== parent')
          expect(body).not.toMatch(/\/plugins\/|\/_agnes\/remote-frontend\//u)
        }
      }
    }
    expect((await fetch(`${cloudOrigin}/admin/api/credentials`)).status).toBe(404)
    expect((await fetch(`${cloudOrigin}/admin/resources/api/mcp/trust`)).status).toBe(404)
    expect((await fetch(cloudOrigin + DELIVERABLE_PREVIEW_PATH, { method: 'POST' })).status).toBe(403)
    expect((await fetch(web.url + DELIVERABLE_PREVIEW_PATH, { method: 'POST' })).status).toBe(405)
    expect(admin).toEqual([])
  } finally {
    await web.close()
    rmSync(root, { recursive: true, force: true })
  }
})

/** Raw HTTP so the test controls Host, as a DNS-rebinding page's browser would send it. */
function send(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; location?: string }> {
  const body = method === 'GET' || method === 'HEAD' ? '' : '{}'
  return new Promise((resolve, reject) => {
    const sent = { ...headers, 'Content-Length': String(body.length) }
    const request = httpRequest({ host: '127.0.0.1', port, method, path, headers: sent }, (response) => {
      response.resume()
      resolve({
        status: response.statusCode ?? 0,
        ...(response.headers.location ? { location: response.headers.location } : {}),
      })
    })
    request.once('error', reject)
    request.end(body)
  })
}

it('serves only loopback Host names for its port and sends aliases to the one page origin', async () => {
  const { root, web, port } = await started()
  try {
    expect((await send(port, 'GET', '/', { Host: `127.0.0.1:${port}` })).status).toBe(200)
    // An old `localhost` bookmark still lands on the workbench, at the origin every route checks.
    expect(await send(port, 'GET', '/?session=s-1', { Host: `localhost:${port}` })).toEqual({
      status: 307,
      location: `${web.url}/?session=s-1`,
    })
    // DNS rebinding: a foreign name that resolves to 127.0.0.1 gets nothing, read or write.
    expect((await send(port, 'GET', '/', { Host: `evil.example:${port}` })).status).toBe(403)
    expect((await send(port, 'GET', '/', { Host: 'evil.example' })).status).toBe(403)
    expect((await send(port, 'GET', '/', { Host: `localhost:${port + 1}` })).status).toBe(403)
    expect(
      (await send(port, 'POST', '/admin/resources/api/mcp/trust', { Host: `evil.example:${port}` })).status,
    ).toBe(403)
    // A write under an alias name is not redirected: the page never sends one.
    expect(
      (await send(port, 'POST', '/admin/resources/api/mcp/trust', { Host: `localhost:${port}` })).status,
    ).toBe(403)
  } finally {
    await web.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('refuses cross-site writes to the BFF and accepts the page itself and non-browser clients', async () => {
  const { root, web, admin, port } = await started()
  try {
    const host = { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' }
    const post = (headers: Record<string, string>, method = 'POST') =>
      send(port, method, '/admin/resources/api/mcp/trust', { ...host, ...headers })

    expect((await post({ Origin: 'http://evil.example' })).status).toBe(403)
    expect((await post({ Origin: 'http://127.0.0.1:9999' })).status).toBe(403)
    expect((await post({ Origin: 'null' })).status).toBe(403)
    expect((await post({ 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403)
    expect((await post({ 'Sec-Fetch-Site': 'same-site' })).status).toBe(403)
    expect((await post({ Origin: 'http://evil.example' }, 'DELETE')).status).toBe(403)
    expect((await post({ Origin: 'http://evil.example' }, 'PUT')).status).toBe(403)
    // A cross-site write elsewhere (for example a mounted Surface's API) is refused the same way.
    expect(
      (await send(port, 'POST', '/demo/action', { ...host, Origin: 'http://evil.example' })).status,
    ).toBe(403)
    expect(admin).toEqual([])

    expect((await post({ Origin: web.url, 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200)
    // No Origin and no Fetch Metadata: curl or another local program, out of the browser threat model.
    expect((await post({})).status).toBe(200)
    expect(admin).toEqual(['POST /admin/resources/api/mcp/trust', 'POST /admin/resources/api/mcp/trust'])
  } finally {
    await web.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('admits only the explicitly selected backend origin in a remote page CSP', async () => {
  const { root, web, admin } = await started()
  let isolatedOrigin: string | undefined
  try {
    const local = await fetch(web.url)
    expect(local.headers.get('content-security-policy')).not.toContain('computer-b')
    const selected = `/?remote=${encodeURIComponent('https://computer-b:8443')}`
    const trusted = await fetch(`${web.url}${selected}`)
    expect(trusted.headers.get('content-security-policy')).not.toContain('computer-b')
    const html = await trusted.text()
    const isolated = /data-cloud-origin="([^"]+)"/u.exec(html)?.[1]
    if (!isolated) throw Error('missing isolated origin')
    isolatedOrigin = isolated
    expect(new URL(isolated).origin).not.toBe(web.url)
    // Owner discovery/recovery fetches owner-info through this exact isolated gateway.
    // Admitting frames alone does not admit the owner's cross-origin fetch.
    for (const document of [local, trusted]) {
      const connect = /(?:^|;)\s*connect-src ([^;]+)/u
        .exec(document.headers.get('content-security-policy') ?? '')?.[1]
        ?.split(/\s+/u)
      expect(connect).toContain(isolated)
      expect(connect).not.toContain('https://computer-b:8443')
      expect(connect).not.toContain('*')
    }
    const remote = await fetch(`${isolated}${selected}`)
    expect(remote.status).toBe(200)
    const csp = remote.headers.get('content-security-policy') ?? ''
    expect(csp).toContain(
      `connect-src 'self' ${isolated.replace('http:', 'ws:')} https://computer-b:8443 wss://computer-b:8443`,
    )
    expect(csp).toContain("script-src 'self' https://computer-b:8443")
    expect(csp).not.toContain('connect-src *')
    const cloudHtml = await remote.text()
    expect(cloudHtml).toContain('data-backend-frame="cloud"')
    expect(cloudHtml).toContain(`data-parent-origin="${web.url}"`)
    expect(cloudHtml).not.toContain('ws://127.0.0.1:4312')
    expect(csp).toContain(`frame-ancestors ${web.url}`)
    expect((await fetch(`${isolated}/admin/resources/api/mcp/trust`)).status).toBe(404)
    expect((await fetch(`${isolated}/admin/api/credentials`)).status).toBe(404)
    expect((await fetch(`${isolated}/_agnes/cloud-connection/authorize`, { method: 'POST' })).status).toBe(
      403,
    )
    expect(
      (await send(Number(new URL(isolated).port), 'GET', selected, { Host: 'evil.example' })).status,
    ).toBe(403)
    expect(admin).toEqual([])
    expect(
      (
        await fetch(`${web.url}/admin/resources/api/mcp/trust`, {
          method: 'POST',
          headers: { Origin: isolated },
        })
      ).status,
    ).toBe(403)
  } finally {
    await web.close()
    rmSync(root, { recursive: true, force: true })
  }
  if (isolatedOrigin) await expect(fetch(isolatedOrigin)).rejects.toThrow()
})

it('exposes delegated sandbox traffic only on the isolated origin, preserving local owner and Host boundaries', async () => {
  const prefix = `/_agnes/remote-access/zzzzzzzz.${'A'.repeat(22)}.${'B'.repeat(43)}`
  const delegated: string[] = []
  const upgrades: string[] = []
  let closed = false
  const { root, web, admin, port } = await started({
    async handleHttp(request, response) {
      if (!request.url?.startsWith(prefix + '/')) return false
      delegated.push(request.url)
      request.resume()
      response.writeHead(200, { 'content-type': 'text/plain' }).end('B only')
      return true
    },
    async handleUpgrade(request, socket) {
      upgrades.push(request.url ?? '')
      socket.destroy()
      return request.url?.startsWith(prefix + '/') ?? false
    },
    close() {
      closed = true
    },
  })
  const remote = 'https://8443-fixture.ap-shanghai.tencentags.com'
  try {
    const main = await fetch(web.url + '/?remote=' + encodeURIComponent(remote))
    expect(main.headers.get('content-security-policy')).not.toContain(remote)
    const html = await main.text()
    const isolated = /data-cloud-origin="([^"]+)"/u.exec(html)?.[1]
    if (!isolated) throw Error('missing isolated origin')
    const child = await fetch(isolated + '/?remote=' + encodeURIComponent(remote))
    expect(child.status).toBe(200)
    const csp = child.headers.get('content-security-policy') ?? ''
    expect(csp).toContain(`connect-src 'self' ${isolated.replace('http:', 'ws:')} ${remote}`)
    expect(csp).toContain(`frame-ancestors ${web.url}`)
    expect(csp).toContain(`font-src 'self' ${remote}`)
    expect((await fetch(isolated + prefix + '/plugins/test/client.js')).status).toBe(200)
    expect(
      (
        await fetch(isolated + prefix + '/admin/resources/api/mcp/trust', {
          method: 'POST',
          headers: { origin: isolated },
          body: '{}',
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await fetch(isolated + '/admin/resources/api/mcp/trust', {
          method: 'POST',
          headers: { origin: isolated },
          body: '{}',
        })
      ).status,
    ).toBe(403)
    expect((await fetch(isolated + '/admin/resources')).status).toBe(404)
    expect((await fetch(web.url + prefix + '/api/test')).status).toBe(404)
    const isolatedPort = Number(new URL(isolated).port)
    expect(
      (await send(isolatedPort, 'GET', prefix + '/api/test', { Host: `foreign.example:${isolatedPort}` }))
        .status,
    ).toBe(403)
    expect(admin).toEqual([])
    expect(delegated).toEqual([prefix + '/plugins/test/client.js', prefix + '/admin/resources/api/mcp/trust'])
    const socket = new WebSocket(isolated.replace('http:', 'ws:') + prefix + '/_agnes/remote-frontend/ws')
    await new Promise((resolve) => {
      socket.onerror = resolve
    })
    expect(upgrades).toEqual([prefix + '/_agnes/remote-frontend/ws'])
    expect(
      (
        await send(port, 'POST', '/admin/resources/api/mcp/trust', {
          Host: new URL(web.url).host,
          Origin: web.url,
        })
      ).status,
    ).toBe(200)
    expect(admin).toEqual(['POST /admin/resources/api/mcp/trust'])
  } finally {
    await web.close()
    expect(closed).toBe(true)
    rmSync(root, { recursive: true, force: true })
  }
})
