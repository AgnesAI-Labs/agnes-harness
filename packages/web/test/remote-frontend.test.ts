// @vitest-environment happy-dom

import { frontendPublication, remoteFrontendOrigin, withRemoteFrontend } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import { backendResourceUrl, remoteFrontendFetch, selectedRemoteOrigin } from '../src/remote-frontend.js'

it('selects an explicit backend origin and refuses credential-bearing or CSP-injecting addresses', () => {
  expect(selectedRemoteOrigin('')).toBeUndefined()
  expect(selectedRemoteOrigin('?remote=http%3A%2F%2Fcomputer-b%3A8443')).toBe('http://computer-b:8443')
  for (const value of [
    'https://user:secret@host/',
    'file:///tmp/x',
    'https://host/path',
    'https://host/?key=x',
    'https://host/#x',
    'https://host;evil',
  ])
    expect(() => remoteFrontendOrigin(value)).toThrow()
  expect(() =>
    frontendPublication({ enabled: true, access: 'public-owner', host: '0.0.0.0', port: -1 }),
  ).toThrow()
  expect(() => frontendPublication({ enabled: true, access: 'local', host: '0.0.0.0', port: 8443 })).toThrow()
  const base = 'http://localhost:4177/?remote=http%3A%2F%2Fcomputer-b%3A8443'
  expect(new URL(withRemoteFrontend('/?session=remote-session', base), base).searchParams.get('remote')).toBe(
    'http://computer-b:8443',
  )
  expect(withRemoteFrontend('https://other.example/?session=x', base)).toBe(
    'https://other.example/?session=x',
  )
  expect(withRemoteFrontend('/?session=x', 'http://localhost:4177/')).toBe('/?session=x')
})

it('routes backend HTTP, plugin assets and sockets to B while keeping A code and unrelated services intact', () => {
  const local = 'http://127.0.0.1:4177',
    remote = 'http://computer-b:8443'
  expect(backendResourceUrl('/api/accounts', remote, local)).toBe(`${remote}/api/accounts`)
  expect(backendResourceUrl('/plugins/p/client.js?v=1', remote, local)).toBe(
    `${remote}/plugins/p/client.js?v=1`,
  )
  expect(backendResourceUrl('ws://127.0.0.1:4177/_agnes/plugin-stream', remote, local)).toBe(
    'ws://computer-b:8443/_agnes/plugin-stream',
  )
  expect(backendResourceUrl('/app.js', remote, local)).toBe('/app.js')
  expect(backendResourceUrl('https://other.example/api/x', remote, local)).toBe('https://other.example/api/x')
})

it('preserves POST bodies, methods and cancellation and omits A cookies on a direct cross-origin request', async () => {
  const calls: Request[] = []
  const original = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(input as Request)
    return new Response('{}')
  }) as typeof fetch
  const forwarded = remoteFrontendFetch(original, 'http://computer-b:8443', 'http://127.0.0.1:4177')
  const abort = new AbortController()
  await forwarded('/api/upload', {
    method: 'POST',
    body: 'from A',
    signal: abort.signal,
    headers: { 'content-type': 'text/plain' },
  })
  expect(calls[0]?.url).toBe('http://computer-b:8443/api/upload')
  expect(calls[0]?.method).toBe('POST')
  expect(await calls[0]?.text()).toBe('from A')
  expect(calls[0]?.credentials).toBe('omit')
  expect(calls[0]?.redirect).toBe('error')
  abort.abort()
  expect(calls[0]?.signal.aborted).toBe(true)
  await forwarded(new Request('http://127.0.0.1:4177/api/query', { method: 'POST', body: 'request body' }))
  expect(await calls[1]?.text()).toBe('request body')
})
