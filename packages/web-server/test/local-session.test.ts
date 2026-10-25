import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createWebServer } from '../src/server.js'

async function started() {
  const root = mkdtempSync(join(tmpdir(), 'agnes-web-session-'))
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
  let tickets = 0
  const web = await createWebServer({
    root,
    wsUrl: 'ws://127.0.0.1:4312',
    port: address.port,
    localSession: { wsTicket: async () => `ticket-${++tickets}` },
    handleAdmin: async (request, response) => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      if (path === '/healthz' || path.startsWith('/admin/resources/api/') || path.startsWith('/oauth/')) {
        admin.push(`${request.method} ${path}`)
        response.writeHead(200).end('{}')
        return true
      }
      return false
    },
  })
  return { root, web, admin }
}

it('trades a one-time launch code for an HttpOnly SameSite=Strict cookie and strips it from the URL', async () => {
  const { root, web } = await started()
  try {
    const launch = new URL(web.launchUrl?.() ?? '')
    expect(launch.origin).toBe(web.url)
    const code = launch.searchParams.get('code')
    expect(code).toMatch(/^[A-Za-z0-9_-]{32}$/)

    // The page itself carries no secret and stays public, so a stale tab can still render.
    const page = await fetch(web.url)
    expect(page.status).toBe(200)
    expect(await page.text()).not.toContain(code)

    launch.searchParams.set('session', 's-1')
    const exchanged = await fetch(launch, { redirect: 'manual' })
    expect(exchanged.status).toBe(303)
    expect(exchanged.headers.get('location')).toBe('/?session=s-1')
    const setCookie = exchanged.headers.get('set-cookie') ?? ''
    expect(setCookie).toMatch(
      /^agnes_web_\d+=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/,
    )
    const cookie = setCookie.split(';')[0] as string

    // The code is single use: a second exchange strips it but sets nothing.
    const reused = await fetch(launch, { redirect: 'manual' })
    expect(reused.status).toBe(303)
    expect(reused.headers.get('set-cookie')).toBeNull()

    // A signed-in page gets a fresh daemon ticket for each connection.
    const ticket = (headers: Record<string, string>) =>
      fetch(new URL('/api/ws-ticket', web.url), { method: 'POST', headers })
    const first = await ticket({ Origin: web.url, Cookie: cookie })
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ ticket: 'ticket-1' })
    expect(await (await ticket({ Origin: web.url, Cookie: cookie })).json()).toEqual({ ticket: 'ticket-2' })
  } finally {
    await web.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('refuses BFF requests and tickets without the session, and keeps external callbacks open', async () => {
  const { root, web, admin } = await started()
  try {
    const exchanged = await fetch(web.launchUrl?.() ?? '', { redirect: 'manual' })
    const cookie = (exchanged.headers.get('set-cookie') ?? '').split(';')[0] as string
    const forged = cookie.replace(/=.*/, `=${'A'.repeat(43)}`)
    const post = (path: string, headers: Record<string, string>) =>
      fetch(new URL(path, web.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: '{}',
      })

    // No secret, a wrong secret, or a never-issued code: refused before any handler runs.
    expect((await post('/admin/resources/api/mcp/trust', { Origin: web.url })).status).toBe(401)
    expect((await post('/admin/resources/api/mcp/trust', { Origin: web.url, Cookie: forged })).status).toBe(
      401,
    )
    expect((await fetch(new URL('/admin/resources/api/context', web.url))).status).toBe(401)
    expect((await fetch(new URL('/oauth/demo/start', web.url))).status).toBe(401)
    expect((await post('/api/ws-ticket', { Origin: web.url })).status).toBe(401)
    expect((await post('/api/ws-ticket', { Origin: web.url, Cookie: forged })).status).toBe(401)
    const unknown = await fetch(new URL('/?code=never-issued', web.url), { redirect: 'manual' })
    expect(unknown.headers.get('set-cookie')).toBeNull()
    // Any write elsewhere (for example a mounted Surface) needs the session too.
    expect((await post('/demo/action', { Origin: web.url })).status).toBe(401)
    expect(admin).toEqual([])

    // The cookie is not enough for a cross-origin ticket request.
    expect((await post('/api/ws-ticket', { Origin: 'http://evil.example', Cookie: cookie })).status).toBe(403)

    // Signed in: the same requests reach the BFF.
    expect((await post('/admin/resources/api/mcp/trust', { Origin: web.url, Cookie: cookie })).status).toBe(
      200,
    )
    expect(
      (await fetch(new URL('/admin/resources/api/context', web.url), { headers: { Cookie: cookie } })).status,
    ).toBe(200)
    // Readiness and the external OAuth redirect carry their own proof and need no cookie.
    expect((await fetch(new URL('/healthz', web.url))).status).toBe(200)
    expect((await fetch(new URL('/oauth/demo/callback?state=x', web.url))).status).toBe(200)
    expect(admin).toEqual([
      'POST /admin/resources/api/mcp/trust',
      'GET /admin/resources/api/context',
      'GET /healthz',
      'GET /oauth/demo/callback',
    ])
  } finally {
    await web.close()
    rmSync(root, { recursive: true, force: true })
  }
})
