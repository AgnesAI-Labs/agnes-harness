import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { createNetFetch } from '../../src/adapters/net.js'

afterEach(() => vi.unstubAllGlobals())

it('preserves default fetch options and copies binary input', async () => {
  const fetch = vi.fn(async (_url: string, _opts?: RequestInit) => new Response('ok'))
  vi.stubGlobal('fetch', fetch)
  const bytes = new Uint8Array([1, 2])
  await createNetFetch()('https://example.com', { method: 'POST', body: bytes })
  const options = fetch.mock.calls[0]?.[1] as RequestInit | undefined
  expect(options).toEqual({ method: 'POST', body: bytes })
  expect(options?.body).not.toBe(bytes)
})

it.each(['service', 'caller'] as const)(
  'combines %s cancellation with timeout and refuses redirects',
  async (source) => {
    let options: RequestInit | undefined
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      options = init
      return new Response('ok')
    })
    const ac = new AbortController(),
      caller = new AbortController()
    await createNetFetch({ signal: ac.signal, redirect: 'error' })('https://example.com', {
      timeoutMs: 1000,
      signal: caller.signal,
    })
    expect(options?.redirect).toBe('error')
    expect(options).not.toHaveProperty('timeoutMs')
    expect(options?.signal?.aborted).toBe(false)
    if (source === 'service') ac.abort()
    else caller.abort()
    expect(options?.signal?.aborted).toBe(true)
  },
)

it.each(['service', 'caller'] as const)(
  'cancels an unfinished real response on %s abort and releases its connection',
  async (source) => {
    let disconnected!: () => void
    const connectionClosed = new Promise<void>((resolve) => {
      disconnected = resolve
    })
    const server = createServer((request, response) => {
      request.socket.once('close', disconnected)
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('first')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing fixture listener')
    const ac = new AbortController(),
      caller = new AbortController()
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const response = await createNetFetch({ signal: ac.signal })(`http://127.0.0.1:${address.port}`, {
        signal: caller.signal,
      })
      if (!response.body) throw new Error('Expected a streaming response body')
      reader = response.body.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('first')
      if (source === 'service') ac.abort()
      else caller.abort()
      await expect(reader.read()).rejects.toThrow()
      await connectionClosed
    } finally {
      reader?.releaseLock()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  },
)
