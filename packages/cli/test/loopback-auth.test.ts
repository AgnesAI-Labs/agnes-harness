import { createServer, request, type Server } from 'node:http'
import { describe, expect, it } from 'vitest'
import { startLoopbackAuthorization } from '../src/onboarding/loopback.js'

type HttpResult = { status: number; body: string } | { error: Error }

function get(url: string): Promise<HttpResult> {
  return new Promise((resolve) => {
    const req = request(url, { method: 'GET' }, (res) => {
      res.setEncoding('utf8')
      let body = ''
      res.on('data', (chunk: string) => {
        body += chunk
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', (error) => resolve({ error }))
    req.end()
  })
}

function expectHttp(result: HttpResult): asserts result is { status: number; body: string } {
  expect('error' in result ? result.error : undefined).toBeUndefined()
}

async function listenOnSameAddress(port: number): Promise<void> {
  const server: Server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port }, resolve)
  })
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
}

describe('loopback authorization callback', () => {
  it('binds a random port on literal IPv4 loopback and uses an unguessable path', async () => {
    const first = await startLoopbackAuthorization({ state: 's'.repeat(43), timeoutMs: 1_000 })
    const second = await startLoopbackAuthorization({ state: 't'.repeat(43), timeoutMs: 1_000 })
    try {
      const a = new URL(first.redirectUri)
      const b = new URL(second.redirectUri)
      expect(a.hostname).toBe('127.0.0.1')
      expect(b.hostname).toBe('127.0.0.1')
      expect(Number(a.port)).toBeGreaterThan(0)
      expect(Number(b.port)).toBeGreaterThan(0)
      expect(a.pathname).toMatch(/^\/cli\/callback\/[A-Za-z0-9_-]{43}$/)
      expect(b.pathname).toMatch(/^\/cli\/callback\/[A-Za-z0-9_-]{43}$/)
      expect(a.pathname).not.toBe(b.pathname)
    } finally {
      await Promise.all([first.close(), second.close()])
    }
  })

  it('requires the exact path and exact state without disclosing expected or received secrets', async () => {
    const state = 'expected-state-secret'
    const code = 'single-use-code-secret'
    const callback = await startLoopbackAuthorization({ state, timeoutMs: 1_000 })
    const url = new URL(callback.redirectUri)

    const wrongPath = await get(`${url.origin}/cli/callback/wrong?state=${state}&code=${code}`)
    expectHttp(wrongPath)
    expect(wrongPath.status).toBe(404)
    expect(wrongPath.body).not.toContain(state)
    expect(wrongPath.body).not.toContain(code)

    const wrongState = await get(`${callback.redirectUri}?state=${state}-suffix&code=${code}`)
    expectHttp(wrongState)
    expect(wrongState.status).toBe(400)
    expect(wrongState.body).not.toContain(state)
    expect(wrongState.body).not.toContain(code)

    const correct = await get(
      `${callback.redirectUri}?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`,
    )
    expectHttp(correct)
    expect(correct.status).toBe(200)
    expect(correct.body).not.toContain(state)
    expect(correct.body).not.toContain(code)
    expect(correct.body).not.toMatch(/token/i)
    await expect(callback.result).resolves.toEqual({ code })
  })

  it('delivers a code once even when two valid callbacks race', async () => {
    const state = 'race-state'
    const callback = await startLoopbackAuthorization({ state, timeoutMs: 1_000 })
    const urls = ['first-code', 'second-code'].map(
      (code) => `${callback.redirectUri}?state=${state}&code=${code}`,
    )

    const responses = await Promise.all(urls.map(get))
    const successes = responses.filter(
      (response): response is { status: number; body: string } =>
        !('error' in response) && response.status === 200,
    )
    expect(successes).toHaveLength(1)
    const result = await callback.result
    expect(['first-code', 'second-code']).toContain(result.code)

    const replay = await get(`${callback.redirectUri}?state=${state}&code=${result.code}`)
    expect('error' in replay || replay.status !== 200).toBe(true)
  })

  it('fails closed on duplicate parameters and keeps waiting for one unambiguous callback', async () => {
    const state = 'one-state'
    const callback = await startLoopbackAuthorization({ state, timeoutMs: 1_000 })
    const duplicate = await get(`${callback.redirectUri}?state=${state}&state=${state}&code=a&code=b`)
    expectHttp(duplicate)
    expect(duplicate.status).toBe(400)
    expect(duplicate.body).not.toContain(state)
    expect(duplicate.body).not.toContain('code=a')

    const accepted = await get(`${callback.redirectUri}?state=${state}&code=only-code`)
    expectHttp(accepted)
    expect(accepted.status).toBe(200)
    await expect(callback.result).resolves.toEqual({ code: 'only-code' })
  })

  it('returns a static error page and never accepts tokens in the callback URL', async () => {
    const state = 'error-state-secret'
    const callback = await startLoopbackAuthorization({ state, timeoutMs: 1_000 })
    const marker = 'token-secret-marker'
    const response = await get(
      `${callback.redirectUri}?state=${state}&error=access_denied&error_description=${marker}`,
    )
    expectHttp(response)
    expect(response.status).toBe(400)
    expect(response.body).not.toContain(state)
    expect(response.body).not.toContain(marker)
    expect(response.body).not.toMatch(/token/i)
    await expect(callback.result).rejects.toMatchObject({ code: 'AUTH_CALLBACK_ERROR' })

    const tokenCallback = await startLoopbackAuthorization({ state, timeoutMs: 1_000 })
    const rejected = await get(`${tokenCallback.redirectUri}?state=${state}&access_token=${marker}`)
    expectHttp(rejected)
    expect(rejected.status).toBe(400)
    expect(rejected.body).not.toContain(marker)
    await tokenCallback.close()
  })

  it('closes the listener and removes abort handling on timeout', async () => {
    const controller = new AbortController()
    const callback = await startLoopbackAuthorization({
      state: 'timeout-state',
      timeoutMs: 20,
      signal: controller.signal,
    })
    const port = Number(new URL(callback.redirectUri).port)
    await expect(callback.result).rejects.toMatchObject({ code: 'AUTH_EXPIRED' })
    expect(callback.closed).toBe(true)
    await listenOnSameAddress(port)

    // A late abort must be detached and cannot change the settled timeout result.
    controller.abort()
    await expect(callback.result).rejects.toMatchObject({ code: 'AUTH_EXPIRED' })
  })

  it('closes the listener promptly when aborted', async () => {
    const controller = new AbortController()
    const callback = await startLoopbackAuthorization({
      state: 'abort-state',
      timeoutMs: 1_000,
      signal: controller.signal,
    })
    const port = Number(new URL(callback.redirectUri).port)
    controller.abort(new Error('must-not-leak-this-reason'))
    await expect(callback.result).rejects.toMatchObject({ code: 'AUTH_ABORTED' })
    await expect(callback.result).rejects.not.toThrow(/must-not-leak-this-reason/)
    expect(callback.closed).toBe(true)
    await listenOnSameAddress(port)
  })
})
