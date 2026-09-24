import { createServer } from 'node:http'
import { beforeEach, expect, it, vi } from 'vitest'
import type { LocalBackend } from './backend.js'

const mocks = vi.hoisted(() => {
  const catalogList = vi.fn(async () => ({ items: [], nextCursor: null }))
  const close = vi.fn(async () => undefined)
  const surfaceClose = vi.fn()
  const createAdminSurface = vi.fn((options: Record<string, unknown>) => ({
    handle: vi.fn(),
    close: surfaceClose,
    options,
  }))
  const pinsInspect = vi.fn(async () => ({ orphans: [] }))
  const pinsRelease = vi.fn(async () => ({ results: [] }))
  const trustWorkspace = vi.fn(async () => ({ hash: `sha256-${'f'.repeat(64)}` }))
  const treeGet = vi.fn(async () => ({ desired: null }))
  const treeList = vi.fn(async () => ({ desired: null }))
  const clientModuleCallService = vi.fn(async () => ({ output: { ok: true } }))
  const clientModuleCallEffect = vi.fn(async () => ({ output: { changed: true } }))
  const surfaceMounts = vi.fn(async () => ({
    mounts: [
      {
        package: 'agnes/demo-surface',
        surfaceId: 'demo',
        mount: '/demo',
        host: '127.0.0.1',
        port: 51234,
      },
    ],
  }))
  return {
    catalogList,
    close,
    surfaceClose,
    createAdminSurface,
    pinsInspect,
    pinsRelease,
    trustWorkspace,
    treeGet,
    treeList,
    clientModuleCallService,
    clientModuleCallEffect,
    surfaceMounts,
  }
})

vi.mock('@agnes/sdk', () => ({
  memoryJournal: vi.fn(() => ({})),
  createClient: vi.fn(() => ({
    initialize: vi.fn(async () => ({})),
    close: mocks.close,
    packages: {
      catalog: { list: mocks.catalogList, get: vi.fn() },
      list: vi.fn(),
      inspect: vi.fn(),
      install: vi.fn(),
      trust: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(),
      update: vi.fn(),
      rollback: vi.fn(),
      remove: vi.fn(),
      operation: { get: vi.fn(), cancel: vi.fn() },
      pins: { inspect: mocks.pinsInspect, release: mocks.pinsRelease },
      trustWorkspace: mocks.trustWorkspace,
      tree: { get: mocks.treeGet, list: mocks.treeList, apply: vi.fn(), rollback: vi.fn() },
    },
    surfaces: { mounts: mocks.surfaceMounts },
    clientModules: {
      callService: mocks.clientModuleCallService,
      callEffect: mocks.clientModuleCallEffect,
    },
  })),
}))

vi.mock('@agnes/daemon/packages', () => ({ createAdminSurface: mocks.createAdminSurface }))

import { localPackageAdmin } from './package-admin.js'

beforeEach(() => vi.clearAllMocks())

it('advertises exactly the frozen hot-update features and forwards catalog reads to the daemon SDK', async () => {
  const backend = {
    scope: { profile: 'local-dev', scopeID: 'scope-1' },
    socketPath: '/tmp/agnes-test.sock',
    web: {
      url: 'ws://127.0.0.1:5000',
      origin: 'http://127.0.0.1:4180',
      token: 'local-web-token-with-enough-entropy',
    },
  } as LocalBackend

  const admin = localPackageAdmin(backend, backend.web?.origin ?? '')
  const options = mocks.createAdminSurface.mock.calls[0]?.[0] as
    | {
        features: string[]
        invoke(action: string, params: unknown): Promise<unknown>
        surfaceLinks(): Promise<unknown>
      }
    | undefined
  expect(options?.features).toEqual([
    'packages.composite-activation.v1',
    'packages.runtime-identity.v1',
    'packages.rollback-target.v1',
    'packages.operation-control.v1',
  ])

  await options?.invoke('catalog/list', { profile: 'local-dev', limit: 50 })
  expect(mocks.catalogList).toHaveBeenCalledWith({ profile: 'local-dev', limit: 50 })
  await options?.invoke('tree/list', { profile: 'local-dev' })
  expect(mocks.treeList).toHaveBeenCalledWith({ profile: 'local-dev' })
  await options?.invoke('tree/get', { profile: 'local-dev' })
  expect(mocks.treeGet).toHaveBeenCalledWith({ profile: 'local-dev' })
  await expect(options?.surfaceLinks()).resolves.toEqual([
    { packageId: 'agnes/demo-surface', surfaceId: 'demo', mount: '/demo' },
  ])
  expect(mocks.surfaceMounts).toHaveBeenCalledOnce()
  await admin.close()
  expect(mocks.surfaceClose).toHaveBeenCalledOnce()
  expect(mocks.close).toHaveBeenCalledOnce()
})

it('forwards pins/inspect and pins/release through invoke to the SDK client', async () => {
  const backend = {
    scope: { profile: 'local-dev', scopeID: 'scope-1' },
    socketPath: '/tmp/agnes-test.sock',
    web: {
      url: 'ws://127.0.0.1:5000',
      origin: 'http://127.0.0.1:4180',
      token: 'local-web-token-with-enough-entropy',
    },
  } as LocalBackend

  localPackageAdmin(backend, backend.web?.origin ?? '')
  const options = mocks.createAdminSurface.mock.calls[0]?.[0] as
    | { invoke(action: string, params: unknown): Promise<unknown> }
    | undefined

  await options?.invoke('pins/inspect', { profile: 'local-dev' })
  expect(mocks.pinsInspect).toHaveBeenCalledWith({ profile: 'local-dev' })

  await options?.invoke('pins/release', {
    profile: 'local-dev',
    clientId: 'admin-web',
    commandId: 'release-1',
    pinIds: ['pin-1'],
  })
  expect(mocks.pinsRelease).toHaveBeenCalledWith({
    profile: 'local-dev',
    clientId: 'admin-web',
    commandId: 'release-1',
    pinIds: ['pin-1'],
  })
})

it('forwards trust-workspace through invoke to the SDK client', async () => {
  const backend = {
    scope: { profile: 'local-dev', scopeID: 'scope-1' },
    socketPath: '/tmp/agnes-test.sock',
    web: {
      url: 'ws://127.0.0.1:5000',
      origin: 'http://127.0.0.1:4180',
      token: 'local-web-token-with-enough-entropy',
    },
  } as LocalBackend
  const admin = localPackageAdmin(backend, backend.web?.origin ?? '')
  const options = mocks.createAdminSurface.mock.calls[0]?.[0] as
    | { invoke(action: string, params: unknown): Promise<unknown> }
    | undefined
  await options?.invoke('trust-workspace', {
    profile: 'local-dev',
    clientId: 'c1',
    commandId: 'cmd1',
    deployDir: '/deploy/xinwei',
  })
  expect(mocks.trustWorkspace).toHaveBeenCalledWith({
    profile: 'local-dev',
    clientId: 'c1',
    commandId: 'cmd1',
    deployDir: '/deploy/xinwei',
  })
  await admin.close()
})

it('relays only a same-origin typed browser service request and strips page-supplied identities', async () => {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test listener address')
    const origin = `http://127.0.0.1:${address.port}`
    const backend = {
      scope: { profile: 'local-dev', scopeID: 'scope-1' },
      socketPath: '/tmp/agnes-test.sock',
      web: { url: 'ws://127.0.0.1:5000', origin, token: 'legacy-ignored' },
    } as LocalBackend
    const admin = localPackageAdmin(backend, origin)
    server.on('request', (request, response) => {
      void admin.handleClientService(request, response)
    })
    const response = await fetch(`${origin}/api/client-modules/service`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
      },
      body: JSON.stringify({
        profile: 'attacker-profile',
        rowId: 'web:acme/panel',
        sessionId: 'session-a',
        service: 'panel.search',
        input: { text: 'hello', credential: 'attacker-value', nested: { token: 'attacker-value', keep: 1 } },
      }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ output: { ok: true } })
    expect(mocks.clientModuleCallService).toHaveBeenCalledWith({
      profile: 'local-dev',
      rowId: 'web:acme/panel',
      sessionId: 'session-a',
      service: 'panel.search',
      input: { text: 'hello', nested: { keep: 1 } },
    })
    const forbidden = await fetch(`${origin}/api/client-modules/service`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({}),
    })
    expect(forbidden.status).toBe(400)
    await admin.close()
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

it('relays effect commands only through the separate same-origin route', async () => {
  const server = createServer()
  const webToken = ['local', 'web', 'effect', 'token', 'with', 'entropy'].join('-')
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test listener address')
    const origin = `http://127.0.0.1:${address.port}`
    const backend = {
      scope: { profile: 'local-dev', scopeID: 'scope-1' },
      socketPath: '/tmp/agnes-test.sock',
      web: { url: 'ws://127.0.0.1:5000', origin, token: webToken },
    } as LocalBackend
    const admin = localPackageAdmin(backend, origin)
    server.on('request', (request, response) => void admin.handleClientEffect(request, response))
    const response = await fetch(`${origin}/api/client-modules/effect`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${webToken}`,
        'Content-Type': 'application/json',
        Origin: origin,
      },
      body: JSON.stringify({
        rowId: 'web:acme/panel',
        sessionId: 'session-a',
        service: 'panel.write',
        commandId: 'effect-1',
        input: { value: 1, credential: 'drop-me' },
      }),
    })
    expect(response.status).toBe(200)
    expect(mocks.clientModuleCallEffect).toHaveBeenCalledWith({
      profile: 'local-dev',
      rowId: 'web:acme/panel',
      sessionId: 'session-a',
      service: 'panel.write',
      commandId: 'effect-1',
      input: { value: 1 },
    })
    await admin.close()
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})
