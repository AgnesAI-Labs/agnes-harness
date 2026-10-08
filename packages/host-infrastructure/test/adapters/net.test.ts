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

it('combines service cancellation with timeout and refuses redirects', async () => {
  let options: RequestInit | undefined
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    options = init
    return new Response('ok')
  })
  const ac = new AbortController()
  await createNetFetch({ signal: ac.signal, redirect: 'error' })('https://example.com', { timeoutMs: 1000 })
  expect(options?.redirect).toBe('error')
  expect(options).not.toHaveProperty('timeoutMs')
  expect(options?.signal?.aborted).toBe(false)
  ac.abort()
  expect(options?.signal?.aborted).toBe(true)
})
