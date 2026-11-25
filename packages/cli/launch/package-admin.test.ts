import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, request as requestHttp } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLOUD_AUTHORIZATION_PATH,
  type PackageCatalogPage,
  type PackageSource,
  REMOTE_FRONTEND_INFO,
  REMOTE_FRONTEND_WS,
  remoteFrontendSessionPath,
} from '@agnes/protocol'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createCredentialAdmin } from '../../daemon-admin/src/credentials.js'
import type { LocalBackend } from './backend.js'

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const upstream = { origin: '' }
  const request = vi.fn(
    async (
      _method: string,
      _input: unknown,
      _options?: { signal?: AbortSignal; timeoutMs?: number },
    ): Promise<unknown> => ({
      schemaVersion: 1,
    }),
  )
  const catalogList = vi.fn(async (): Promise<PackageCatalogPage> => ({ items: [], nextCursor: null }))
  const initialize = vi.fn(async (): Promise<{ features?: string[] }> => ({}))
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
  const publicationStatus = vi.fn(async () => ({ publication: null }))
  const migrateSession = vi.fn(async () => ({ changed: true }))
  const treeGet = vi.fn(async () => ({ desired: null }))
  const treeList = vi.fn(async () => ({ desired: null }))
  const clientModuleList = vi.fn(async () => ({
    rows: [
      {
        rowId: 'web:acme/panel',
        moduleName: 'plugin/0123456789abcdef',
        enabled: true,
        phase: 'ready',
        services: ['panel.report'],
        extIds: ['plugin/0123456789abcdef'],
      },
    ],
  }))
  const clientModuleCallService = vi.fn(async () => ({ output: { ok: true } }))
  const clientModuleCallEffect = vi.fn(async () => ({ output: { changed: true } }))
  const readOperation = vi.fn(async () => {
    throw Object.assign(new Error('unknown operation'), { data: { code: 'CAPABILITY_DENIED' } })
  })
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
  const sessionSelection = {
    loops: vi.fn(async () => [
      { id: 'default', version: '1.0.0', sourcePackage: '@agnes/core', capabilities: [] },
    ]),
    modelAdapters: vi.fn(async () => []),
    getDefaults: vi.fn(async () => ({ revision: 0, defaults: {} })),
    saveDefaults: vi.fn(async (input: unknown) => input),
  }
  return {
    listeners,
    upstream,
    sessionSelection,
    request,
    catalogList,
    initialize,
    close,
    surfaceClose,
    createAdminSurface,
    pinsInspect,
    pinsRelease,
    trustWorkspace,
    treeGet,
    publicationStatus,
    migrateSession,
    treeList,
    clientModuleList,
    clientModuleCallService,
    clientModuleCallEffect,
    surfaceMounts,
    readOperation,
  }
})

vi.mock('node:https', async (original) => ({
  ...(await original<typeof import('node:https')>()),
  request: (...args: Parameters<typeof requestHttp>) => {
    const url = args[0] as URL
    return requestHttp(new URL(url.pathname, mocks.upstream.origin), args[1], args[2])
  },
}))

vi.mock('@agnes/sdk', () => ({
  unixTransport: vi.fn(),
  memoryJournal: vi.fn(() => ({})),
  createClient: vi.fn(() => ({
    request: mocks.request,
    call: mocks.request,
    initialize: mocks.initialize,
    close: mocks.close,
    on(event: string, listener: (payload: unknown) => void) {
      const receivers = mocks.listeners.get(event) ?? new Set()
      receivers.add(listener)
      mocks.listeners.set(event, receivers)
      return () => receivers.delete(listener)
    },
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
      publicationStatus: mocks.publicationStatus,
      migrateSession: mocks.migrateSession,
      tree: { get: mocks.treeGet, list: mocks.treeList, apply: vi.fn(), rollback: vi.fn() },
    },
    sessionSelection: mocks.sessionSelection,
    surfaces: { mounts: mocks.surfaceMounts },
    extensions: { readOperation: mocks.readOperation },
    clientModules: {
      list: mocks.clientModuleList,
      callService: mocks.clientModuleCallService,
      callEffect: mocks.clientModuleCallEffect,
    },
  })),
}))

vi.mock('@agnes/daemon/packages', async (original) => ({
  ...(await original<typeof import('@agnes/daemon/packages')>()),
  createAdminSurface: mocks.createAdminSurface,
}))

import { localPackageAdmin } from './package-admin.js'

let daemonDir: string
beforeEach(() => {
  vi.clearAllMocks()
  mocks.listeners.clear()
  daemonDir = mkdtempSync(join(tmpdir(), 'agh-launch-admin-'))
})

it('revokes a live Cloud socket and aborts a pending authorization on a daemon credential deletion', async () => {
  const upstream = createServer((_request, response) => response.end('authorized'))
  const server = createServer()
  const listen = async (server: ReturnType<typeof createServer>) => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing fixture address')
    return `http://127.0.0.1:${address.port}`
  }
  mocks.upstream.origin = await listen(upstream)
  upstream.on('upgrade', (request, socket) => {
    const accept = createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    socket.once('end', () => socket.destroy())
  })
  const origin = await listen(server)
  const backend = {
    scope: { daemonDir, home: daemonDir, profile: 'local-dev', scopeID: 'scope-1' },
    socketPath: join(daemonDir, 'daemon.sock'),
    web: { origin },
  } as LocalBackend
  const admin = localPackageAdmin(backend, origin)
  const home = join(daemonDir, 'home')
  const credentials = createCredentialAdmin({
    home,
    dataDir: join(home, 'data'),
    configurations: async () => [],
    writableStore: async () => true,
    onDeleted(id) {
      for (const listener of mocks.listeners.get('notice') ?? [])
        listener({ kind: 'credential_deleted', detail: { id } })
    },
  })
  const addCredential = async (label: string) =>
    ((await credentials.call('create', { label, value: 'synthetic-credential' }, 'local')) as { id: string })
      .id
  const credentialRef = await addCredential('Cloud fixture')
  const unrelated = await addCredential('Unrelated fixture')
  const token = `zzzzzzzz.${'A'.repeat(22)}.${'B'.repeat(43)}`
  const target = 'https://8443-fixture.ap-shanghai.tencentags.com'
  const expiresAt = Date.now() + 60_000
  const path = remoteFrontendSessionPath(token)
  const grant = { origin: target, token, expiresAt, trafficToken: 'synthetic-proof' }
  const input = { credentialRef, origin: target }
  const authorize = () =>
    fetch(origin + CLOUD_AUTHORIZATION_PATH, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
  server.on('request', (request, response) => {
    void admin.handle(request, response).then((handled) => {
      if (!handled) return admin.cloudGateway.handleHttp(request, response)
    })
  })
  server.on(
    'upgrade',
    (request, socket, head) => void admin.cloudGateway.handleUpgrade(request, socket, head),
  )
  try {
    mocks.request.mockResolvedValueOnce(grant)
    const response = await authorize()
    expect(await response.json()).toMatchObject({ token, proxied: true })
    const socket = new WebSocket(origin.replace('http:', 'ws:') + path + REMOTE_FRONTEND_WS)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    const closed = new Promise<void>((resolve) =>
      socket.addEventListener('close', () => resolve(), { once: true }),
    )
    mocks.request.mockImplementationOnce(
      async (_method, _input, options) =>
        new Promise((_resolve, reject) =>
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true }),
        ),
    )
    const pending = authorize()
    await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2))
    await credentials.call('delete', { id: unrelated }, 'local')
    expect(socket.readyState).toBe(WebSocket.OPEN)
    expect(mocks.request.mock.lastCall?.[2]?.signal?.aborted).toBe(false)
    await credentials.call('delete', { id: credentialRef }, 'local')
    await closed
    expect(await (await pending).json()).toEqual({ error: 'CONFIG_CREDENTIAL_NOT_FOUND' })
    expect((await fetch(origin + path + REMOTE_FRONTEND_INFO)).status).toBe(401)
  } finally {
    await admin.close()
    await Promise.all(
      [server, upstream].map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve())
            server.closeAllConnections()
          }),
      ),
    )
  }
})
afterEach(() => rmSync(daemonDir, { recursive: true, force: true }))

it('closes the dedicated daemon connection when the browser abandons cloud authorization', async () => {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing test listener address')
  const origin = `http://127.0.0.1:${address.port}`
  const backend = {
    scope: { daemonDir, home: daemonDir, profile: 'local-dev', scopeID: 'scope-1' },
    socketPath: join(daemonDir, 'daemon.sock'),
    web: { url: 'ws://127.0.0.1:5000', origin, token: ['test', 'web', 'token'].join('-') },
  } as LocalBackend
  const admin = localPackageAdmin(backend, origin)
  const controller = new AbortController()
  const input = { credentialRef: 'secret://generic/11111111-1111-1111-1111-111111111111' }
  mocks.request.mockImplementationOnce(async (_method, _input, options) => {
    const signal = options?.signal
    if (!signal) throw Error('missing exchange signal')
    return new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  })
  server.on('request', (request, response) => void admin.handle(request, response))
  try {
    const request = fetch(origin + CLOUD_AUTHORIZATION_PATH, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: controller.signal,
    }).catch((error: Error) => error.name)
    await vi.waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith('_agnes/v1/admin.cloud.authorize', input, {
        timeoutMs: expect.any(Number),
        signal: expect.any(AbortSignal),
      }),
    )
    const signal = mocks.request.mock.lastCall?.[2]?.signal
    expect(signal?.aborted).toBe(false)
    controller.abort()
    expect(await request).toBe('AbortError')
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalled())
    expect(signal?.aborted).toBe(true)
  } finally {
    controller.abort()
    await admin.close()
    const stopped = new Promise<void>((resolve) => server.close(() => resolve()))
    server.closeAllConnections()
    await stopped
  }
})

it('advertises exactly the frozen hot-update features and forwards catalog reads to the daemon SDK', async () => {
  const backend = {
    scope: { daemonDir, home: '/tmp/agnes-launch-fixture', profile: 'local-dev', scopeID: 'scope-1' },
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
        diagnostics: { export(input: unknown): Promise<unknown>; doctor?: () => Promise<unknown> }
        features: string[]
        backendFeatures(): Promise<readonly string[]>
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

  await options?.diagnostics.export({ diagnosticId: '11111111-1111-4111-8111-111111111111' })
  expect(mocks.request).toHaveBeenCalledWith('_agnes/v1/diagnostics.export', {
    diagnosticId: '11111111-1111-4111-8111-111111111111',
  })
  await expect(options?.diagnostics.doctor?.()).resolves.toEqual({ schemaVersion: 1 })
  expect(mocks.request).toHaveBeenCalledWith('_agnes/v1/doctor.run', {})
  await options?.invoke('catalog/list', { profile: 'local-dev', limit: 50 })
  expect(mocks.catalogList).toHaveBeenCalledWith({ profile: 'local-dev', limit: 50 })
  await options?.invoke('catalog/list', { profile: 'local-dev', includeCommunity: true })
  expect(mocks.catalogList).toHaveBeenLastCalledWith({ profile: 'local-dev' })
  mocks.initialize.mockResolvedValueOnce({ features: ['packages.community-discovery.v1'] })
  await options?.invoke('catalog/list', { profile: 'local-dev', includeCommunity: true })
  expect(mocks.catalogList).toHaveBeenLastCalledWith({ profile: 'local-dev', includeCommunity: true })
  mocks.initialize.mockResolvedValueOnce({ features: ['packages.community-discovery.v1'] })
  await expect(options?.backendFeatures()).resolves.toEqual(['packages.community-discovery.v1'])
  await expect(options?.backendFeatures()).resolves.toEqual([])
  await options?.invoke('catalog/list', { profile: 'local-dev', includeCommunity: true })
  expect(mocks.catalogList).toHaveBeenLastCalledWith({ profile: 'local-dev' })
  const v2 = 'packages.community-discovery.v2'
  const v3 = 'packages.community-discovery.v3'
  const request = { profile: 'local-dev', query: 'example', cursor: 'page-2', limit: 25 }
  const source: PackageSource = {
    type: 'git',
    ref: `git:https://github.com/example/plugin.git#${'a'.repeat(40)}`,
  }
  const release = { version: '1.0.0', source }
  const snapshot = {
    state: 'ready',
    lastSuccessAt: null,
    nextAttemptAt: null,
    error: null,
    totalReported: 1,
    items: [
      { id: 'example/plugin', fullName: 'example/plugin', description: 'Example', versions: [release] },
    ],
  } satisfies NonNullable<PackageCatalogPage['communityIndex']>
  const legacyPage = { items: [], nextCursor: 'page-3', communityIndex: snapshot }
  mocks.initialize.mockResolvedValueOnce({ features: [v2] })
  mocks.catalogList.mockResolvedValueOnce(legacyPage)
  await expect(options?.invoke('catalog/list', { ...request, communityVersion: 3 })).resolves.toEqual(
    legacyPage,
  )
  expect(mocks.catalogList).toHaveBeenLastCalledWith({ ...request, communityVersion: 2 })

  await options?.invoke('catalog/list', { ...request, communityVersion: 3 })
  expect(mocks.catalogList).toHaveBeenLastCalledWith(request)

  mocks.initialize.mockResolvedValueOnce({ features: [v2, v3] })
  mocks.catalogList.mockResolvedValueOnce(legacyPage)
  await expect(options?.invoke('catalog/list', { ...request, communityVersion: 2 })).resolves.toEqual(
    legacyPage,
  )
  expect(mocks.catalogList).toHaveBeenLastCalledWith({ ...request, communityVersion: 2 })

  const currentPage: PackageCatalogPage = {
    ...legacyPage,
    communityIndex: {
      ...snapshot,
      items: snapshot.items.map((row) => ({
        ...row,
        versions: [{ ...release, provides: ['tool'], compatibility: { kind: 'undeclared' } }],
      })),
    },
  }
  mocks.initialize.mockResolvedValueOnce({ features: [v2, v3] })
  mocks.catalogList.mockResolvedValueOnce(currentPage)
  await expect(options?.invoke('catalog/list', { ...request, communityVersion: 3 })).resolves.toEqual(
    currentPage,
  )
  expect(mocks.catalogList).toHaveBeenLastCalledWith({ ...request, communityVersion: 3 })

  mocks.initialize.mockResolvedValueOnce({ features: [v2, v3] })
  mocks.catalogList.mockResolvedValueOnce(currentPage)
  await expect(options?.invoke('catalog/list', { ...request, communityVersion: 2 })).rejects.toThrow(
    'invalid community catalog projection',
  )

  await options?.invoke('tree/list', { profile: 'local-dev' })
  expect(mocks.treeList).toHaveBeenCalledWith({ profile: 'local-dev' })
  await options?.invoke('tree/get', { profile: 'local-dev' })
  expect(mocks.treeGet).toHaveBeenCalledWith({ profile: 'local-dev' })
  await expect(options?.invoke('publication-status', { profile: 'local-dev' })).resolves.toEqual({
    publication: null,
  })
  const migration = {
    profile: 'local-dev',
    clientId: 'admin-web',
    commandId: 'migration',
    sessionId: 'closed',
  }
  await options?.invoke('sessions/migrate', migration)
  expect(mocks.migrateSession).toHaveBeenCalledWith(migration)

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
    scope: { daemonDir, home: '/tmp/agnes-launch-fixture', profile: 'local-dev', scopeID: 'scope-1' },
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
    scope: { daemonDir, home: '/tmp/agnes-launch-fixture', profile: 'local-dev', scopeID: 'scope-1' },
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
      scope: { daemonDir, home: '/tmp/agnes-launch-fixture', profile: 'local-dev', scopeID: 'scope-1' },
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
    const profileCall = { rowId: 'web:acme/panel', service: 'panel.report', input: {} }
    const channelCall = {
      method: '_agnes/v1/extension.call',
      params: {
        sessionId: 'session-a',
        extension: 'plugin/0123456789abcdef',
        service: 'channel.bind',
        commandId: 'channel-bind-1',
        input: { instanceId: 'one', targetId: 'a'.repeat(32), expectedVersion: 0 },
      },
    }
    const sendChannel = (body: unknown, from = origin) =>
      fetch(`${origin}/api/channels`, {
        method: 'POST',
        headers: { Origin: from, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    mocks.request.mockResolvedValueOnce({
      providers: [{ extension: 'plugin/0123456789abcdef', bindingAvailable: true }],
    } as never)
    mocks.request.mockResolvedValueOnce({ output: { bound: true } } as never)
    const bound = await sendChannel(channelCall)
    expect(bound.status).toBe(200)
    expect(await bound.json()).toEqual({ output: { bound: true } })
    expect(mocks.request).toHaveBeenCalledWith(channelCall.method, channelCall.params)
    expect((await sendChannel(channelCall, 'http://attacker.invalid')).status).toBe(403)
    expect((await sendChannel({ ...channelCall, method: '_agnes/v1/packages.remove' })).status).toBe(400)
    expect(
      (await sendChannel({ ...channelCall, params: { ...channelCall.params, actor: 'owner' } })).status,
    ).toBe(400)
    mocks.request.mockResolvedValueOnce({ providers: [] } as never)
    expect((await sendChannel(channelCall)).status).toBe(403)
    for (const forged of [
      { actor: 'owner' },
      { profile: 'foreign' },
      { workspace: 'D:/foreign' },
      { agent: 'default' },
    ]) {
      expect(
        (
          await sendChannel({
            method: 'channels.context',
            params: { extension: channelCall.params.extension, sessionId: 'session-a', ...forged },
          })
        ).status,
      ).toBe(400)
      expect(
        (
          await sendChannel({
            method: 'channels.remove',
            params: {
              extension: channelCall.params.extension,
              instanceId: 'one',
              operationId: 'remove',
              configurationRevision: 'revision',
              expectedVersion: 0,
              ...forged,
            },
          })
        ).status,
      ).toBe(400)
    }
    const dedicated = {
      extension: channelCall.params.extension,
      workspaceId: 'w-team',
      instanceId: 'd-0123456789ab',
      credentialRefs: { appId: 'secret://generic/app-id' },
      operationId: 'dedicated',
      configurationRevision: 'revision',
    }
    // The dedicated connection never names a session, another instance, a path or an agent.
    for (const params of [
      ...[
        { sessionId: 'session-a' },
        { replaceId: 'one' },
        { workspace: '/work/team' },
        { agent: 'default' },
        { profile: 'foreign' },
        { expectedConfigurationRevision: 'a'.repeat(64) },
      ].map((forged) => ({ ...dedicated, ...forged })),
      ...['operationId', 'configurationRevision', 'workspaceId', 'instanceId', 'credentialRefs'].map((key) =>
        Object.fromEntries(Object.entries(dedicated).filter(([name]) => name !== key)),
      ),
      { ...dedicated, credentialRefs: { appId: 'plain-secret-value' } },
    ])
      expect((await sendChannel({ method: 'channels.configureDedicated', params })).status).toBe(400)
    for (const params of [{}, { extension: dedicated.extension, sessionId: 'session-a' }])
      expect((await sendChannel({ method: 'channels.dedicatedContext', params })).status).toBe(400)
    // Well-formed requests reach the workbench; this mocked client has no workspace registry.
    for (const [method, params] of [
      ['channels.dedicatedContext', { extension: dedicated.extension }],
      ['channels.configureDedicated', dedicated],
    ] as const) {
      mocks.request.mockClear()
      const routed = await sendChannel({ method, params })
      expect(routed.status).toBe(503)
      expect(mocks.request).toHaveBeenCalledWith('_agnes/v1/channels.catalog', {})
    }
    // A deterministic refusal (here: the channel is gone) is a 409 the page can act on, not "unconfirmed".
    mocks.request.mockResolvedValueOnce({ providers: [] } as never)
    const refusedDedicated = await sendChannel({ method: 'channels.configureDedicated', params: dedicated })
    expect(refusedDedicated.status).toBe(409)
    expect(await refusedDedicated.json()).toMatchObject({ error: { data: { code: 'CHANNEL_REFUSED' } } })
    // An id that is already configured says so, so the page can point at the existing connection.
    mocks.request.mockResolvedValueOnce({
      providers: [
        {
          extension: dedicated.extension,
          manifest: { credentials: { required: [], optional: ['appId'] } },
        },
      ],
    } as never)
    mocks.request.mockResolvedValueOnce({ output: { instances: [{ id: dedicated.instanceId }] } } as never)
    const exists = await sendChannel({ method: 'channels.configureDedicated', params: dedicated })
    expect(exists.status).toBe(409)
    expect(await exists.json()).toMatchObject({
      error: { data: { code: 'CHANNEL_REFUSED', reason: 'exists' } },
    })
    for (const expectedVersion of [undefined, -1, 0.5, '0']) {
      expect(
        (
          await sendChannel({
            method: 'channels.remove',
            params: {
              extension: channelCall.params.extension,
              instanceId: 'one',
              operationId: 'remove',
              configurationRevision: 'revision',
              expectedVersion,
            },
          })
        ).status,
      ).toBe(400)
    }
    const revoke = { action: 'revoke', pairingId: 'a'.repeat(32) }
    mocks.request.mockResolvedValueOnce({} as never)
    expect((await sendChannel({ method: 'channels.pairing', params: revoke })).status).toBe(200)
    expect(mocks.request).toHaveBeenCalledWith('_agnes/v1/channels.pairing', revoke)
    for (const params of [
      { ...revoke, actor: 'owner' },
      { action: 'revoke', pairingId: 'not-a-pairing' },
      { action: 'mint', extension: channelCall.params.extension, instanceId: 'one', operationId: 'mint' },
    ])
      expect((await sendChannel({ method: 'channels.pairing', params })).status).toBe(400)
    mocks.request.mockRejectedValueOnce(
      Object.assign(new Error('internal detail'), { data: { code: 'TARGET_PAIRED' } }) as never,
    )
    const refused = await sendChannel({
      method: 'channels.pairing',
      params: {
        action: 'mint',
        extension: channelCall.params.extension,
        instanceId: 'one',
        target: { owner: '@acme/desk#ext:acme/desk/main', service: 'desk' },
        operationId: 'mint',
      },
    })
    expect(refused.status).toBe(409)
    expect(JSON.stringify(await refused.json())).not.toContain('internal detail')
    const profile = await fetch(`${origin}/api/client-modules/profile`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(profileCall),
    })
    expect(profile.status).toBe(200)
    expect(mocks.clientModuleList).toHaveBeenCalledWith('local-dev')
    expect(mocks.request).toHaveBeenCalledWith('_agnes/v1/extension.callScoped', {
      extension: 'plugin/0123456789abcdef',
      service: 'panel.report',
      input: {},
    })
    const scoped = await fetch(`${origin}/api/client-modules/profile`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...profileCall,
        input: { sessionId: 'owned-session' },
        sessionReads: ['owned-session'],
      }),
    })
    expect(scoped.status).toBe(200)
    expect(mocks.request).toHaveBeenCalledWith('_agnes/v1/extension.callScoped', {
      extension: 'plugin/0123456789abcdef',
      service: 'panel.report',
      input: { sessionId: 'owned-session' },
      sessionReads: ['owned-session'],
    })
    for (const body of [
      { ...profileCall, sessionReads: ['duplicate', 'duplicate'] },
      { ...profileCall, sessionReads: [''] },
      { ...profileCall, read: true, operationId: 'one', sessionReads: ['owned-session'] },
      { ...profileCall, sessionId: 'forged' },
      { ...profileCall, actor: {} },
    ]) {
      const rejected = await fetch(`${origin}/api/client-modules/profile`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(rejected.status).toBe(400)
    }
    const crossOrigin = await fetch(`${origin}/api/client-modules/profile`, {
      method: 'POST',
      headers: { Origin: 'https://untrusted.invalid', 'Content-Type': 'application/json' },
      body: JSON.stringify(profileCall),
    })
    expect(crossOrigin.status).toBe(403)
    mocks.clientModuleList.mockResolvedValueOnce({ rows: [] })
    const removed = await fetch(`${origin}/api/client-modules/profile`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(profileCall),
    })
    expect(removed.status).toBe(503)
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
      scope: { daemonDir, home: '/tmp/agnes-launch-fixture', profile: 'local-dev', scopeID: 'scope-1' },
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

it('fits production catalog/defaults relays without an injected provider', async () => {
  const backend = {
    scope: { daemonDir, home: '/tmp/agnes-launch-fixture', profile: 'local-dev', scopeID: 'scope-1' },
    socketPath: '/tmp/test.sock',
    web: { origin: 'http://127.0.0.1:4180' },
  } as LocalBackend
  const admin = localPackageAdmin(backend, backend.web?.origin ?? '')
  const provider = mocks.createAdminSurface.mock.calls[0]?.[0]
    ?.sessionSelection as import('@agnes/protocol').AdminSessionSelection
  try {
    expect(await provider.loops()).toEqual(await mocks.sessionSelection.loops())
    expect(await provider.modelAdapters()).toEqual([])
    expect(await provider.getDefaults()).toEqual({ revision: 0, defaults: {} })
    const update = {
      revision: 0,
      defaults: { providers: { loop: { provider: 'default', version: '1.0.0' } } },
    }
    expect(await provider.saveDefaults(update)).toEqual(update)
    expect(mocks.sessionSelection.saveDefaults).toHaveBeenCalledWith(update)
    const failure = {
      rpc: {
        code: -32011,
        message: 'SEMANTIC_REJECTED',
        data: {
          code: 'SEMANTIC_REJECTED',
          reason: 'CONFIG_REVISION_CONFLICT',
          messageKey: 'appServer.errors.conflict',
          cause: { code: 'CONFIG_REVISION_CONFLICT' },
          diagnosticId: '00000000-0000-0000-0000-000000000001',
        },
      },
    }
    mocks.sessionSelection.saveDefaults.mockRejectedValueOnce(failure)
    await expect(provider.saveDefaults(update)).rejects.toBe(failure)
  } finally {
    await admin.close()
  }
})
