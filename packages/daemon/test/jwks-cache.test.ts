import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isForbiddenJwksAddress,
  type JwksResponse,
  loadJwks,
  startJwksCache,
} from '../src/supervisor/jwks-cache.js'

const body = (value: unknown): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    yield Buffer.from(JSON.stringify(value))
  },
})
const response = (kid: string, remoteAddress = '8.8.8.8'): JwksResponse => ({
  status: 200,
  remoteAddress,
  body: body({ keys: [{ kid, kty: 'RSA' }] }),
})

describe('JWKS cache', () => {
  afterEach(() => vi.useRealTimers())

  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.1.1',
    '192.0.0.1',
    '192.0.2.1',
    '198.18.0.1',
    '198.19.255.254',
    '198.51.100.1',
    '203.0.113.1',
    '::',
    '::1',
    '0:0:0:0:0:0:0:1',
    'fc00::1',
    'fe80::1',
    'febf::1',
    'fec0::1',
    'feff::1',
    'ff02::1',
    '2001:2::1',
    '2001::1',
    '2001:db8::1',
    '2001:100::1',
    '2002:7f00:1::',
    '2002:a9fe:101::',
    '3ffe::1',
    '3fff::1',
    'fe80::1%lo0',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
  ])('rejects non-public address %s', (address) => expect(isForbiddenJwksAddress(address)).toBe(true))

  it.each(['8.8.8.8', '198.17.255.255', '198.20.0.1', '2001:3::1', '3fff:ffff::1'])(
    'accepts adjacent public address %s',
    (address) => expect(isForbiddenJwksAddress(address)).toBe(false),
  )

  it('requires HTTPS, validates DNS, and refuses connection-address drift', async () => {
    await expect(loadJwks('http://issuer.test/keys')).rejects.toThrow('credential-free HTTPS')
    await expect(
      loadJwks('https://issuer.test/keys', { resolver: async () => ['127.0.0.1'] }),
    ).rejects.toThrow('forbidden address')
    await expect(
      loadJwks('https://issuer.test/keys', {
        resolver: async () => ['8.8.8.8'],
        transport: async () => response('one', '8.8.4.4'),
      }),
    ).rejects.toThrow('address changed')
  })

  it('enforces the 1MiB limit while streaming', async () => {
    let chunksRead = 0
    const transport = async (): Promise<JwksResponse> => ({
      status: 200,
      remoteAddress: '8.8.8.8',
      body: {
        async *[Symbol.asyncIterator]() {
          for (let i = 0; i < 3; i++) {
            chunksRead++
            yield Buffer.alloc(600_000)
          }
        },
      },
    })
    await expect(
      loadJwks('https://issuer.test/keys', {
        resolver: async () => ['8.8.8.8'],
        transport,
      }),
    ).rejects.toThrow('too large')
    expect(chunksRead).toBe(2)
  })

  it('aborts a resolver that ignores its signal without waiting for it to settle', async () => {
    const controller = new AbortController()
    let resolverSignal: AbortSignal | undefined
    const loading = loadJwks('https://issuer.test/keys', {
      signal: controller.signal,
      resolver: async (_hostname, signal) => {
        resolverSignal = signal
        return new Promise<string[]>(() => undefined)
      },
    })
    controller.abort(new Error('stop'))
    await expect(loading).rejects.toThrow('stop')
    expect(resolverSignal?.aborted).toBe(true)
  })

  it('does not invoke transport for an already-aborted load', async () => {
    const controller = new AbortController()
    controller.abort(new Error('already stopped'))
    const transport = vi.fn()
    await expect(
      loadJwks('https://issuer.test/keys', {
        signal: controller.signal,
        resolver: async () => new Promise<string[]>(() => undefined),
        transport,
      }),
    ).rejects.toThrow('already stopped')
    expect(transport).not.toHaveBeenCalled()
  })

  it('bounds initial startup when DNS resolution hangs', async () => {
    vi.useFakeTimers()
    const starting = startJwksCache({
      url: 'https://issuer.test/keys',
      target: {},
      resolver: async () => new Promise<string[]>(() => undefined),
    })
    const rejected = expect(starting).rejects.toBeDefined()
    await vi.advanceTimersByTimeAsync(5_000)
    await rejected
  })

  it('single-flights refresh, retains last-good keys, and aborts/drains on stop', async () => {
    vi.useFakeTimers()
    let revision = 1
    let release: (() => void) | undefined
    const transport = vi.fn(async (_url, _address, signal): Promise<JwksResponse> => {
      if (revision === 2)
        await new Promise<void>((resolve, reject) => {
          release = resolve
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      return response(String(revision))
    })
    const target: { jwks?: Array<{ kid?: string; kty: 'RSA' | 'EC' | 'oct' }> } = {}
    const stop = await startJwksCache({
      url: 'https://issuer.test/keys',
      target,
      resolver: async () => ['8.8.8.8'],
      transport,
      intervalMs: 100,
    })
    expect(target.jwks).toEqual([{ kid: '1', kty: 'RSA' }])
    revision = 2
    await vi.advanceTimersByTimeAsync(300)
    expect(transport).toHaveBeenCalledTimes(2)
    const stopped = stop()
    await stopped
    release?.()
    expect(target.jwks).toEqual([{ kid: '1', kty: 'RSA' }])
  })
})
