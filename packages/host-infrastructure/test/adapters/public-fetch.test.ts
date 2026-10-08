import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPublicFetch } from '../../src/adapters/public-fetch/index.js'
import * as network from '../../src/adapters/public-fetch/network.js'
import { bodyFormat, fetchUrl, LIMITS } from '../../src/adapters/public-fetch/policy.js'
import type { PublicResponse, PublicTransport } from '../../src/adapters/public-fetch/transport.js'

const options = () => ({ signal: new AbortController().signal, timeoutMs: 1000 })
const response = (
  text = 'hello',
  statusCode = 200,
  headers: PublicResponse['headers'] = {},
): PublicResponse => ({
  statusCode,
  headers: { 'content-type': 'text/plain', ...headers },
  body: (async function* () {
    yield new TextEncoder().encode(text)
  })(),
  close: vi.fn(async () => {}),
})
afterEach(() => vi.restoreAllMocks())

describe('public fetch address boundary', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '0.0.0.0',
    '224.0.0.1',
    '192.168.1.1',
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:127.0.0.1',
    '64:ff9b::a00:1',
  ])('refuses non-public %s', (ip) => expect(network.isPublicIpAddress(ip)).toBe(false))
  it('accepts public addresses and rejects the entire mixed DNS set', async () => {
    expect(network.isPublicIpAddress('1.1.1.1')).toBe(true)
    expect(network.isPublicIpAddress('2606:4700:4700::1111')).toBe(true)
    await expect(
      network.resolvePublicAddresses('example.com', options().signal, async () => [
        { address: '1.1.1.1', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ]),
    ).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
  })
  it('retains only validated addresses in the connection lookup', () => {
    const callback = vi.fn()
    network.createPinnedLookup([{ address: '1.1.1.1', family: 4 }])('host.test', { all: true }, callback)
    expect(callback).toHaveBeenCalledWith(null, [{ address: '1.1.1.1', family: 4 }])
  })
  it('stops waiting for a stuck DNS query on cancellation', async () => {
    const ac = new AbortController()
    const pending = network.resolvePublicAddresses('host.test', ac.signal, () => new Promise(() => {}))
    ac.abort()
    await expect(pending).rejects.toThrow('aborted')
  })
  it.each([
    'file:///etc/passwd',
    'https://u:p@example.com',
    'https://example.com/\npath',
    '',
    `https://example.com/${'a'.repeat(2048)}`,
  ])('rejects %s without transport', async (url) => {
    const transport = vi.fn<PublicTransport>()
    await expect(createPublicFetch({}, transport)(url, options())).rejects.toThrow()
    expect(transport).not.toHaveBeenCalled()
  })
  it('normalizes fragments and decodes declared non-UTF8 text', () => {
    expect(fetchUrl('https://example.com/a#section').href).toBe('https://example.com/a')
    expect(bodyFormat('text/plain; charset=windows-1252').decoder.decode(new Uint8Array([233]))).toBe('é')
    expect(() => bodyFormat('text/plain; charset=unknown')).toThrow('charset')
  })
})

describe('bounded HTTP lifecycle', () => {
  it('propagates caller cancellation during reading and still closes the response', async () => {
    const ac = new AbortController(),
      r = response()
    const transport: PublicTransport = async (_url, signal) => ({
      ...r,
      body: (async function* () {
        const stopped = new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        )
        ac.abort(new Error('caller stopped'))
        await stopped
        yield new Uint8Array()
      })(),
    })
    await expect(
      createPublicFetch({}, transport)('https://example.com', { signal: ac.signal, timeoutMs: 1000 }),
    ).rejects.toThrow('caller stopped')
    expect(r.close).toHaveBeenCalledOnce()
  })
  it('bounds normalized URLs before transport', async () => {
    const transport = vi.fn<PublicTransport>()
    await expect(
      createPublicFetch({}, transport)(`https://example.com/${'中'.repeat(500)}`, options()),
    ).rejects.toMatchObject({ code: 'WEB_INVALID_URL' })
    expect(transport).not.toHaveBeenCalled()
  })
  it('preserves HTTP 404 as a response and closes it', async () => {
    const r = response('missing', 404)
    expect(await createPublicFetch({}, async () => r)('https://example.com', options())).toMatchObject({
      statusCode: 404,
      body: { content: 'missing' },
    })
    expect(r.close).toHaveBeenCalledOnce()
  })
  it('follows same-origin redirects and closes every response', async () => {
    const first = response('', 302, { location: '/next' }),
      last = response('done')
    const transport = vi.fn<PublicTransport>().mockResolvedValueOnce(first).mockResolvedValueOnce(last)
    expect(await createPublicFetch({}, transport)('https://example.com', options())).toMatchObject({
      url: 'https://example.com/next',
    })
    expect(first.close).toHaveBeenCalledOnce()
    expect(last.close).toHaveBeenCalledOnce()
  })
  it.each(['http://example.com', 'https://other.test', 'https://u:p@example.com'])(
    'blocks redirect %s before another request',
    async (location) => {
      const r = response('', 302, { location }),
        transport = vi.fn(async () => r)
      await expect(createPublicFetch({}, transport)('https://example.com', options())).rejects.toMatchObject({
        code: 'WEB_REDIRECT_BLOCKED',
      })
      expect(transport).toHaveBeenCalledOnce()
      expect(r.close).toHaveBeenCalledOnce()
    },
  )
  it('caps loops at five followed redirects', async () => {
    const transport = vi.fn(async () => response('', 302, { location: '/loop' }))
    await expect(createPublicFetch({}, transport)('https://example.com', options())).rejects.toMatchObject({
      code: 'WEB_REDIRECT_BLOCKED',
    })
    expect(transport).toHaveBeenCalledTimes(6)
  })
  it.each([
    { 'content-type': 'application/pdf' },
    { 'content-type': '' },
    { 'content-encoding': 'gzip' },
    { 'content-length': String(LIMITS.bytes + 1) },
  ])('rejects unsupported/oversize response and closes it', async (headers) => {
    const r = response('', 200, headers)
    await expect(createPublicFetch({}, async () => r)('https://example.com', options())).rejects.toThrow()
    expect(r.close).toHaveBeenCalledOnce()
  })
  it('distinguishes exactly-at-cap from stream overflow; caps decoded content', async () => {
    for (const extra of [0, 1]) {
      const value = await createPublicFetch({}, async () => response('a'.repeat(LIMITS.bytes + extra)))(
        'https://example.com',
        options(),
      )
      expect(value.truncation).toEqual({ bytes: extra === 1, decoded: true })
      if (value.body.kind === 'zip') throw new Error('text fetch returned ZIP')
      expect(value.body.content).toHaveLength(LIMITS.chars)
    }
  })
  it('does not cut an astral character in half', async () => {
    const result = await createPublicFetch({}, async () => response('😀'.repeat(LIMITS.chars + 1)))(
      'https://example.com',
      options(),
    )
    if (result.body.kind === 'zip') throw new Error('text fetch returned ZIP')
    expect(Array.from(result.body.content)).toHaveLength(LIMITS.chars)
    expect(result.body.content).not.toContain('�')
  })
  it('refuses proxy configuration without invoking transport', async () => {
    const transport = vi.fn<PublicTransport>()
    await expect(
      createPublicFetch({ HTTPS_PROXY: 'http://proxy', NO_PROXY: '*' }, transport)(
        'https://example.com',
        options(),
      ),
    ).rejects.toMatchObject({ code: 'WEB_PROXY_UNSUPPORTED' })
    expect(transport).not.toHaveBeenCalled()
  })
  it('returns bounded ZIP bytes only when explicitly requested', async () => {
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff])
    const zipped = (): PublicResponse => ({
      ...response(),
      headers: { 'content-type': 'application/zip' },
      body: (async function* () {
        yield bytes
      })(),
    })
    await expect(
      createPublicFetch({}, async () => zipped())('https://example.com/a.zip', options()),
    ).rejects.toMatchObject({ code: 'WEB_UNSUPPORTED_CONTENT_TYPE' })
    const result = await createPublicFetch({}, async () => zipped())('https://example.com/a.zip', {
      ...options(),
      responseType: 'zip',
    })
    expect(result.body).toEqual({ kind: 'zip', base64: bytes.toString('base64') })
    await expect(
      createPublicFetch({}, async () => response('not a zip'))('https://example.com/a.zip', {
        ...options(),
        responseType: 'zip',
      }),
    ).rejects.toMatchObject({ code: 'WEB_UNSUPPORTED_CONTENT_TYPE' })
  })
  it('deadline cancels slow body and releases resources', async () => {
    const r = response()
    const transport: PublicTransport = async (_url, signal) => ({
      ...r,
      body: (async function* () {
        await new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        )
        yield new Uint8Array()
      })(),
    })
    await expect(
      createPublicFetch({}, transport)('https://example.com', { ...options(), timeoutMs: 10 }),
    ).rejects.toMatchObject({ code: 'WEB_FETCH_TIMEOUT' })
    expect(r.close).toHaveBeenCalledOnce()
  })
  it('uses the real HTTP transport with test-only DNS replacement, no automatic redirects/decompression', async () => {
    const server = createServer((req, res) => {
      expect(req.headers['accept-encoding']).toBe('identity')
      expect(req.headers.cookie).toBeUndefined()
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('actual transport')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const resolver = vi
      .spyOn(network, 'resolvePublicAddresses')
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    try {
      const result = await createPublicFetch({})(
        `http://fixture.invalid:${(server.address() as AddressInfo).port}`,
        options(),
      )
      if (result.body.kind === 'zip') throw new Error('text fetch returned ZIP')
      expect(result.body.content).toBe('actual transport')
      expect(resolver).toHaveBeenCalledOnce()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
