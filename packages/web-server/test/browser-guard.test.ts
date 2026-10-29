import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createWebServer } from '../src/server.js'

async function started() {
  const root = mkdtempSync(join(tmpdir(), 'agnes-web-guard-'))
  writeFileSync(
    join(root, 'index.html'),
    '<html><meta content="__AGNES_CSP_NONCE__"><script>"__AGNES_WS_URL__"</script></html>',
  )
  const reservation = createServer()
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve))
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('missing synthetic port')
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  const admin: string[] = []
  const web = await createWebServer({
    root,
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
