// @vitest-environment happy-dom

import {
  CLOUD_AUTHORIZATION_PATH,
  frontendPublication,
  REMOTE_FRONTEND_INFO,
  REMOTE_FRONTEND_KEY_VERSION,
  REMOTE_FRONTEND_WS,
  remoteFrontendOrigin,
  remoteFrontendSessionPath,
  withRemoteFrontend,
} from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import { bindCloudCredential, readCloudCredentialRef } from '../src/backends/cloud-key.js'
import { forgetRemoteAccess } from '../src/remote-authorization.js'
import {
  backendResourceUrl,
  readRemoteFrontendInfo,
  remoteFrontendFetch,
  selectedRemoteOrigin,
} from '../src/remote-frontend.js'

it('binds only A’s listed credential references without creating or replacing secret values', () => {
  const origin = 'http://managed-cloud.test'
  const id = 'secret://generic/11111111-1111-1111-1111-111111111111'
  const requests = vi.fn()
  vi.stubGlobal('fetch', requests)
  try {
    bindCloudCredential(origin, id, [{ id }])
    expect(readCloudCredentialRef(origin)).toBe(id)
    expect(() => bindCloudCredential(origin, id, [])).toThrow('unavailable')
    expect(() => bindCloudCredential(origin, 'raw-fixture-key', [{ id }])).toThrow('unavailable')
    expect(readCloudCredentialRef(origin)).toBe(id)
    expect(requests).not.toHaveBeenCalled()
    expect(localStorage.getItem(`agnes.cloud.credential.v1:${origin}`)).toBe(id)
    expect(JSON.stringify(localStorage)).not.toContain('fixture-key')
    expect(JSON.stringify(sessionStorage)).not.toContain('fixture-key')
  } finally {
    localStorage.removeItem(`agnes.cloud.credential.v1:${origin}`)
    vi.unstubAllGlobals()
  }
})

it('requires the saved Key, exchanges it once and routes backend resources through an authenticated capability', async () => {
  const remote = 'http://key-cloud.test:8443'
  const key = 'fixture-third-party-key'
  const credentialRef = 'secret://generic/11111111-1111-1111-1111-111111111111'
  const token = `zzzzzzzz.${'A'.repeat(22)}.${'B'.repeat(43)}`
  const prefix = remoteFrontendSessionPath(token)
  const calls: { url: string; body: unknown }[] = []
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, body: init?.body })
    return url.endsWith(CLOUD_AUTHORIZATION_PATH)
      ? Response.json({ token, expiresAt: Date.now() + 3_600_000 })
      : Response.json({
          version: REMOTE_FRONTEND_KEY_VERSION,
          access: 'key-owner',
          wsPath: REMOTE_FRONTEND_WS,
          instanceId: 'fixture-B',
        })
  }) as typeof fetch
  try {
    await expect(readRemoteFrontendInfo(remote, new AbortController().signal, fetcher)).rejects.toThrow('Key')
    expect(calls).toEqual([])
    localStorage.setItem(`agnes.cloud.credential.v1:${remote}`, credentialRef)
    expect(await readRemoteFrontendInfo(remote, new AbortController().signal, fetcher)).toEqual({
      instanceId: 'fixture-B',
    })
    expect(calls[0]).toEqual({
      url: new URL(CLOUD_AUTHORIZATION_PATH, location.origin).href,
      body: JSON.stringify({ origin: remote, credentialRef }),
    })
    expect(calls[1]?.url).toBe(`${remote}${prefix}${REMOTE_FRONTEND_INFO}`)
    expect(backendResourceUrl('/api/accounts', remote, 'http://local.test')).toBe(
      `${remote}${prefix}/api/accounts`,
    )
    expect(backendResourceUrl('/plugins/pkg/client.js', remote, 'http://local.test')).toBe(
      `${remote}${prefix}/plugins/pkg/client.js`,
    )
    expect(backendResourceUrl(`${remote}/plugins/pkg/client.js`, remote, 'http://local.test')).toBe(
      `${remote}${prefix}/plugins/pkg/client.js`,
    )
    expect(backendResourceUrl('/app.js', remote, 'http://local.test')).toBe('/app.js')
    expect(backendResourceUrl(CLOUD_AUTHORIZATION_PATH, remote, 'http://local.test')).toBe(
      CLOUD_AUTHORIZATION_PATH,
    )
    expect(calls.every((call) => !call.url.includes(key))).toBe(true)
  } finally {
    localStorage.removeItem(`agnes.cloud.credential.v1:${remote}`)
    forgetRemoteAccess(remote)
  }
})

it('reports a rejected credential and refuses an old public publication instead of downgrading authentication', async () => {
  const remote = 'http://rejected-cloud.test'
  localStorage.setItem(
    `agnes.cloud.credential.v1:${remote}`,
    'secret://generic/11111111-1111-1111-1111-111111111111',
  )
  try {
    await expect(
      readRemoteFrontendInfo(remote, new AbortController().signal, async () =>
        Response.json({ error: 'CONFIG_CREDENTIAL_REJECTED' }, { status: 400 }),
      ),
    ).rejects.toThrow('Key')
    await expect(
      readRemoteFrontendInfo(remote, new AbortController().signal, async (input) =>
        String(input).endsWith(CLOUD_AUTHORIZATION_PATH)
          ? Response.json({
              token: `zzzzzzzz.${'A'.repeat(22)}.${'B'.repeat(43)}`,
              expiresAt: Date.now() + 60_000,
            })
          : Response.json({
              version: 'agh-public-frontend/v1',
              access: 'public-owner',
              instanceId: 'old-B',
              wsPath: REMOTE_FRONTEND_WS,
            }),
      ),
    ).rejects.toThrow('incompatible')
  } finally {
    localStorage.removeItem(`agnes.cloud.credential.v1:${remote}`)
    forgetRemoteAccess(remote)
  }
})

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
  const keyed = { enabled: true, access: 'key-owner', host: '0.0.0.0', port: 8443 }
  for (const auth of [undefined, {}, { keySha256: 'bad' }])
    expect(() => frontendPublication({ ...keyed, auth })).toThrow()
  expect(frontendPublication({ ...keyed, auth: { keySha256: 'a'.repeat(64) } }).access).toBe('key-owner')
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
  const frame = document.createElement('iframe')
  frame.setAttribute('data-agh-backend-frame', '1')
  frame.setAttribute('data-backend-origin', remote)
  vi.stubGlobal('window', { parent: {}, frameElement: frame })
  try {
    expect(selectedRemoteOrigin()).toBe(remote)
    // A child URL may change during navigation; the parent-owned environment remains fixed.
    expect(backendResourceUrl('/api/accounts')).toBe(`${remote}/api/accounts`)
    frame.setAttribute('data-backend-origin', '')
    expect(selectedRemoteOrigin()).toBeUndefined()
    expect(backendResourceUrl('/api/accounts')).toBe('/api/accounts')
  } finally {
    vi.unstubAllGlobals()
  }
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
