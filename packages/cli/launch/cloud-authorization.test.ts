import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PassThrough, Readable } from 'node:stream'
import { CLOUD_AUTHORIZATION_PATH } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import { cloudAuthorizationRelay, shareCloudAuthorization } from './cloud-authorization.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it('accepts only same-origin credential references and never reflects raw daemon failures or secret-bearing responses', async () => {
  const origin = 'http://127.0.0.1:4177'
  const input = {
    origin: 'http://cloud.fixture:8443',
    credentialRef: 'secret://generic/11111111-1111-1111-1111-111111111111',
  }
  const authorization = {
    token: `zzzzzzzz.${'A'.repeat(22)}.${'B'.repeat(43)}`,
    expiresAt: Date.now() + 60_000,
  }
  let mode = 'success'
  let registered = false
  let calls = 0
  const relay = cloudAuthorizationRelay(
    origin,
    async (value) => {
      expect(value).toEqual(mode === 'discovery' ? { credentialRef: input.credentialRef } : input)
      calls++
      if (mode === 'throw') throw new Error('private-fixture-Key')
      if (mode === 'platform') return { ...authorization, trafficToken: 'business-only-secret' }
      if (mode === 'discovery')
        return {
          ...authorization,
          origin: 'https://8443-fixture.ap-shanghai.tencentags.com',
          trafficToken: 'business-only-secret',
        }
      return mode === 'echo' ? { ...authorization, key: 'private-fixture-Key' } : authorization
    },
    (target, result, binding) => {
      expect(binding).toEqual({ ...input, origin: target })
      if (mode === 'discovery') expect(target).toBe('https://8443-fixture.ap-shanghai.tencentags.com')
      registered = result.trafficToken === 'business-only-secret'
      return registered
    },
  )
  async function call(body: object, headers: Record<string, string> = {}, url = CLOUD_AUTHORIZATION_PATH) {
    const request = Object.assign(Readable.from([JSON.stringify(body)]), {
      url,
      method: 'POST',
      complete: true,
      headers: { host: new URL(origin).host, origin, 'content-type': 'application/json', ...headers },
    }) as IncomingMessage
    let status = 0
    let result = ''
    const response = Object.assign(new EventEmitter(), {
      writeHead(code: number) {
        status = code
        return this
      },
      end(text: string) {
        result = text
      },
    }) as unknown as ServerResponse
    expect(await relay(request, response)).toBe(true)
    return { status, body: JSON.parse(result) }
  }
  for (const headers of [
    { origin: 'http://foreign.test' },
    { host: 'foreign.test' },
    { 'sec-fetch-site': 'cross-site' },
  ])
    expect((await call(input, headers)).status).toBe(403)
  expect((await call({ ...input, key: 'must-not-accept-a-raw-key' })).status).toBe(400)
  expect(calls).toBe(0)
  expect(await call(input)).toEqual({ status: 200, body: authorization })
  mode = 'platform'
  expect(await call(input)).toEqual({ status: 200, body: { ...authorization, proxied: true } })
  expect(registered).toBe(true)
  mode = 'discovery'
  const discovery = await call({ credentialRef: input.credentialRef })
  expect(discovery).toEqual({
    status: 200,
    body: { ...authorization, origin: 'https://8443-fixture.ap-shanghai.tencentags.com', proxied: true },
  })
  expect(JSON.stringify(discovery)).not.toContain('business-only-secret')
  for (mode of ['throw', 'echo']) {
    const denied = await call(input)
    expect(denied.status).toBe(400)
    expect(JSON.stringify(denied)).not.toContain('private-fixture-Key')
    expect(denied.body).toEqual({ error: 'CLOUD_AUTH_UNAVAILABLE' })
  }
})

it.each(['disconnect', 'deletion'])(
  'cancels authorization after %s without registering its late grant',
  async (cause) => {
    const origin = 'http://localhost:49979'
    const input = {
      origin: 'https://8443-fixture.ap-shanghai.tencentags.com',
      credentialRef: 'secret://generic/11111111-1111-1111-1111-111111111111',
    }
    const started = deferred<AbortSignal>()
    const grant = {
      token: `zzzzzzzz.${'A'.repeat(22)}.${'B'.repeat(43)}`,
      expiresAt: Date.now() + 60_000,
      trafficToken: 'fixture-proof',
    }
    const exchanged = deferred<typeof grant>()
    const register = vi.fn(() => true)
    const invoke = vi.fn(async (_input, signal: AbortSignal) => {
      started.resolve(signal)
      return exchanged.promise
    })
    const relay = cloudAuthorizationRelay(origin, invoke, register)
    const request = Object.assign(Readable.from([JSON.stringify(input)]), {
      url: CLOUD_AUTHORIZATION_PATH,
      method: 'POST',
      headers: { host: new URL(origin).host, origin, 'content-type': 'application/json' },
      complete: true,
    }) as IncomingMessage
    const response = Object.assign(new EventEmitter(), { writeHead: vi.fn(), end: vi.fn() })
    const handling = relay(request, response as unknown as ServerResponse)
    const signal = await started.promise
    relay.revokeCredential('secret://generic/22222222-2222-2222-2222-222222222222')
    expect(signal.aborted).toBe(false)
    if (cause === 'deletion') relay.revokeCredential(input.credentialRef)
    else response.emit('close')
    expect(signal.aborted).toBe(true)
    exchanged.resolve(grant)
    await expect(handling).resolves.toBe(true)
    expect(register).not.toHaveBeenCalled()
    if (cause === 'deletion') {
      expect(response.writeHead).toHaveBeenCalledOnce()
      expect(response.writeHead).toHaveBeenCalledWith(400, expect.anything())
      expect(response.end).toHaveBeenCalledWith(JSON.stringify({ error: 'CONFIG_CREDENTIAL_NOT_FOUND' }))
    } else expect(response.writeHead).not.toHaveBeenCalled()
    response.writeHead.mockClear()

    const partial = Object.assign(new PassThrough(), {
      url: request.url,
      method: request.method,
      headers: request.headers,
      complete: false,
    }) as unknown as IncomingMessage
    const reading = relay(partial, response as unknown as ServerResponse)
    partial.emit('aborted')
    partial.destroy()
    await expect(reading).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledOnce()
    expect(response.writeHead).not.toHaveBeenCalled()
  },
)

it('shares concurrent authorization and cancels an abandoned exchange before starting another', async () => {
  const input = {
    credentialRef: 'secret://generic/11111111-1111-1111-1111-111111111111',
    origin: 'http://cloud.fixture:8443',
  }
  const grant = { token: 'fixture', expiresAt: Date.now() + 60_000 }
  const exchange = deferred<typeof grant>()
  const invoke = vi.fn(async (_input, signal: AbortSignal) => {
    const abort = new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    return Promise.race([exchange.promise, abort])
  })
  const authorize = shareCloudAuthorization(invoke)
  const first = new AbortController()
  const second = new AbortController()
  const firstResult = authorize(input, first.signal)
  const secondResult = authorize(input, second.signal)
  await Promise.resolve()
  expect(invoke).toHaveBeenCalledOnce()
  const shared = invoke.mock.calls[0]?.[1]
  first.abort()
  await expect(firstResult).rejects.toMatchObject({ name: 'AbortError' })
  expect(shared?.aborted).toBe(false)
  const retry = authorize(input, new AbortController().signal)
  second.abort()
  await expect(secondResult).rejects.toMatchObject({ name: 'AbortError' })
  expect(shared?.aborted).toBe(false)
  expect(invoke).toHaveBeenCalledOnce()
  const abandoned = new AbortController()
  const otherInput = { ...input, origin: 'http://other.fixture:8443' }
  const abandonedResult = authorize(otherInput, abandoned.signal)
  await Promise.resolve()
  abandoned.abort()
  await expect(abandonedResult).rejects.toMatchObject({ name: 'AbortError' })
  expect(invoke.mock.calls[1]?.[1].aborted).toBe(true)
  const replacement = authorize(otherInput, new AbortController().signal)
  exchange.resolve(grant)
  await expect(retry).resolves.toEqual(grant)
  await expect(replacement).resolves.toEqual(grant)
  expect(invoke).toHaveBeenCalledTimes(3)
  expect(invoke.mock.calls[2]?.[1].aborted).toBe(false)
})
