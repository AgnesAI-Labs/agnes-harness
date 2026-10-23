import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
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
  const icon = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  writeFileSync(join(root, 'favicon.png'), icon)
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
    const favicon = await fetch(new URL('/favicon.ico', web.url))
    expect(favicon.status).toBe(200)
    expect(favicon.headers.get('content-type')).toBe('image/png; charset=utf-8')
    expect(Buffer.from(await favicon.arrayBuffer())).toEqual(icon)
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

// Exercise the HTTP boundary, including the order of URL, origin and method refusals.
it('characterizes every guarded route across origin, fetch-site, method and raw URL variants', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-web-security-'))
  const reservation = createServer()
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve))
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('missing synthetic port')
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  const reached: string[] = []
  const web = await createWebServer({
    root,
    wsUrl: 'ws://127.0.0.1:4312',
    port: address.port,
    workspacePicker: {
      available: async () => {
        reached.push('picker')
        return true
      },
      pick: async () => ({ status: 'cancelled' }),
    },
    planCommand: async () => {
      reached.push('plan')
      return { active: true, text: 'synthetic plan' }
    },
    fileUpload: async () => {
      reached.push('upload')
      return { offset: 0 }
    },
    historySearch: async () => {
      reached.push('history')
      return { items: [], truncated: false }
    },
    triggers: async (input) => {
      reached.push('webhook')
      if (input.action === 'list')
        return {
          snapshot: {
            config: { enabled: true, path: '/hooks/business', maxPayloadBytes: 1024 },
            rules: [],
            deliveries: [],
            secretRefs: [],
          },
        }
      return { delivery: { id: 'synthetic', at: 1, status: 'accepted' } }
    },
    mountProxy: (_request, response) => {
      reached.push('mount')
      response.writeHead(200, { 'Content-Type': 'text/plain' }).end('mounted')
      return true
    },
  })
  const routes = [
    ['picker', '/api/workspace-picker'],
    ['plan', '/api/plan-mode'],
    ['upload', '/api/attachments/upload'],
    ['history', '/api/history-search'],
    ['admin', '/api/triggers'],
    ['hook', '/hooks/business'],
    ['mount', '/demo/action'],
  ] as const
  try {
    for (const [route, path] of routes)
      for (const origin of [undefined, web.url, 'https://foreign.invalid'])
        for (const site of [undefined, 'same-origin', 'same-site', 'cross-site', 'none'])
          for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'OPTIONS', 'DELETE', 'PATCH'])
            for (const variant of ['exact', 'query', 'absolute', 'foreign-absolute']) {
              const target =
                variant === 'query'
                  ? `${path}?extra=1`
                  : variant === 'absolute'
                    ? `${web.url}${path}`
                    : variant === 'foreign-absolute'
                      ? `https://foreign.invalid${path}`
                      : path
              const optionalOrigin = origin === undefined || origin === web.url
              const optionalSite = site === undefined || site === 'same-origin' || site === 'none'
              const strictOrigin = origin === web.url && (site === undefined || site === 'same-origin')
              let status: number
              let invoked = false
              let allow: string | undefined
              if (route === 'picker' || route === 'plan') {
                if (variant !== 'exact' || !optionalOrigin || !optionalSite) status = 403
                else if (method !== 'POST' && !(route === 'picker' && method === 'GET')) {
                  status = 405
                  allow = route === 'picker' ? 'GET, POST' : 'POST'
                } else if (method === 'POST' && origin !== web.url) status = 403
                else {
                  invoked = true
                  status = 200
                }
              } else if (route === 'upload') {
                if (!optionalOrigin || !optionalSite || (method === 'POST' && origin !== web.url))
                  status = 403
                else if (method !== 'GET' && method !== 'POST') {
                  status = 405
                  allow = 'GET, POST'
                } else {
                  status = 200
                  invoked = true
                }
              } else if (route === 'history') {
                if (!optionalOrigin || !optionalSite) status = 403
                else if (method !== 'GET') status = 405
                else {
                  status = 200
                  invoked = true
                }
              } else if (route === 'admin' || route === 'hook') {
                if (route === 'admin' && variant !== 'exact') status = 404
                else if (route === 'admin' && !strictOrigin) status = 403
                else if (method !== 'POST') status = 405
                else if (route === 'hook' && variant !== 'exact') {
                  status = 404
                  invoked = true
                } else {
                  status = route === 'admin' ? 200 : 202
                  invoked = true
                }
              } else if (method === 'GET' || method === 'HEAD' || strictOrigin) {
                status = 200
                invoked = true
              } else {
                status = 405
                allow = 'GET, HEAD'
              }
              const body =
                method === 'POST'
                  ? route === 'picker'
                    ? ''
                    : route === 'plan'
                      ? '{"cwd":"/synthetic","line":"/plan"}'
                      : route === 'admin'
                        ? '{"action":"list"}'
                        : '{}'
                  : ''
              reached.length = 0
              const result = await new Promise<{ status: number; allow: string | undefined; body: string }>(
                (resolve, reject) => {
                  const request = httpRequest(
                    web.url,
                    {
                      path: target,
                      method,
                      headers: {
                        ...(origin === undefined ? {} : { origin }),
                        ...(site === undefined ? {} : { 'sec-fetch-site': site }),
                        'content-type': 'application/json',
                        'content-length': Buffer.byteLength(body),
                      },
                    },
                    (response) => {
                      let text = ''
                      response.setEncoding('utf8')
                      response.on('data', (chunk) => {
                        text += chunk
                      })
                      response.on('end', () =>
                        resolve({
                          status: response.statusCode ?? 0,
                          allow: response.headers.allow,
                          body: text,
                        }),
                      )
                    },
                  )
                  request.on('error', reject)
                  request.end(body)
                },
              )
              const context = JSON.stringify({ route, origin, site, method, variant })
              expect({ status: result.status, allow: result.allow }, context).toEqual({ status, allow })
              expect(reached.length > 0, context).toBe(invoked)
              if (method === 'HEAD') expect(result.body, context).toBe('')
              else if (status === 403)
                expect(JSON.parse(result.body), context).toMatchObject({
                  error:
                    route === 'upload'
                      ? 'UPLOAD_ORIGIN_DENIED'
                      : route === 'admin'
                        ? 'ORIGIN_REJECTED'
                        : { code: -32006, data: { code: 'ORIGIN_REJECTED' } },
                })
            }
  } finally {
    await web.close()
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
