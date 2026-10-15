import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createWebServer } from '../src/server.js'

it('serves the main Web while Surface paths are retryable, then distinguishes a successful empty table', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-web-surface-ready-'))
  mkdirSync(root, { recursive: true })
  writeFileSync(
    join(root, 'index.html'),
    '<html><meta content="__AGNES_CSP_NONCE__"><script>"__AGNES_WS_URL__"</script></html>',
  )
  writeFileSync(join(root, 'app.js'), '/* synthetic Web */')
  const reservation = createServer()
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve))
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('missing synthetic port')
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  let ready = false
  const web = await createWebServer({
    root,
    wsUrl: 'ws://127.0.0.1:4312',
    port: address.port,
    mountProxy: () => false,
    surfaceMountsReady: (path) => /^\/(?:plugins|admin|skins)(?:\/|$)/.test(path) || ready,
  })
  try {
    const home = await fetch(web.url)
    expect(home.status).toBe(200)
    const csp = home.headers.get('content-security-policy')
    expect(csp).toContain(web.url.replace(/^http/, 'ws'))
    expect(csp).toContain("media-src 'self' blob:")
    expect(csp).not.toContain('*')
    expect((await fetch(new URL('/app.js', web.url))).status).toBe(200)
    const pending = await fetch(new URL('/demo/version', web.url))
    expect(pending.status).toBe(503)
    expect(pending.headers.get('retry-after')).toBe('1')
    expect(pending.headers.get('cache-control')).toBe('no-store')
    expect(await pending.text()).toContain('not ready yet; retry')
    expect(
      (
        await fetch(new URL('/demo/action', web.url), {
          method: 'POST',
          headers: { origin: new URL(web.url).origin },
        })
      ).status,
    ).toBe(503)
    // The same origin/fetch-site gate still refuses untrusted write traffic before proxy/readiness.
    expect(
      (
        await fetch(new URL('/demo/action', web.url), {
          method: 'POST',
          headers: { origin: 'https://untrusted.example' },
        })
      ).status,
    ).toBe(405)
    expect(
      (
        await fetch(new URL('/app.js', web.url), {
          method: 'POST',
          headers: { origin: new URL(web.url).origin },
        })
      ).status,
    ).toBe(405)
    expect((await fetch(new URL('/plugins/missing.js', web.url))).status).toBe(404)
    ready = true
    expect((await fetch(new URL('/demo/version', web.url))).status).toBe(404)
  } finally {
    await web.close()
    rmSync(root, { recursive: true, force: true })
  }
})
