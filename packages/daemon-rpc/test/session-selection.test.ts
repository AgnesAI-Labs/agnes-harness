import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  localPackageAdminAuthority,
  localWebSkinReadAuthority,
} from '@agnes/daemon-admin/packages/permissions'
import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { createConfigurationService, createCredentialStore, type Host } from '@agnes/host'
import { createPrivateDirectorySync } from '@agnes/system-node'
import { expect, it } from 'vitest'
import {
  hostSessionCatalog,
  registerSessionSelection,
  sessionSelectionProvider,
} from '../src/local/methods/session-selection.js'

it('serves host catalogs, persists exact defaults and refuses web/narrow writes', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'agnes-selection-'))
  const home = join(fixtureRoot, 'home')
  createPrivateDirectorySync(home)
  const configuration = createConfigurationService({ home, profile: 'local-dev' })
  const loop = { id: 'example', version: '1.0.0', sourcePackage: '@acme/loop', capabilities: ['resume'] }
  const adapter = {
    id: 'custom',
    version: '2.0.0',
    wireApi: 'openai-chat',
    sourcePackage: '@acme/adapter',
    capabilities: { imageInput: true, tools: true, streaming: true },
  }
  const catalog = () =>
    hostSessionCatalog({
      profile: {
        presets: { default: 'standard', allowed: ['standard', 'minimal'] },
        permissions: { default: 'workspace-write', allowed: ['read-only', 'workspace-write'] },
        provider: { routes: [] },
      },
      kernel: { loops: { catalog: () => [loop] } },
      modelAdapterCatalog: () => [adapter],
      provider: { models: () => [{ id: 'model', route: 'account', api: 'openai-chat' }] },
    } as unknown as Host)
  const service = sessionSelectionProvider(configuration, catalog)
  const runtimeSnapshot = {
    providers: [],
    presets: [{ id: 'read-only', isDefault: true }],
    localPluginFolders: { home: '/synthetic/plugins', workspace: '/synthetic/.agh/plugins' },
  }
  let rescanned = false
  const endpoint = (authority = localPackageAdminAuthority()) => {
    const ep = new LocalEndpoint({ clock: Date.now, principalId: 'owner' })
    ep.conn.initialized = true
    ep.conn.authKind = 'local'
    ep.conn.credentialKind = 'local'
    registerSessionSelection(ep, service, authority, {
      snapshot: async () => runtimeSnapshot,
      reloadLocal: async () => {
        rescanned = true
      },
    })
    return ep
  }
  const ep = endpoint(),
    browser = endpoint(localWebSkinReadAuthority),
    reader = endpoint(localPackageAdminAuthority(['packages.read']))
  const request = (target: LocalEndpoint, method: string, params: unknown = {}) =>
    target.handle({ jsonrpc: '2.0', id: 1, method: `_agnes/v1/sessionSelection.${method}`, params })
  try {
    expect(await request(ep, 'runtime')).toMatchObject({ result: runtimeSnapshot })
    expect(await request(reader, 'runtime')).toMatchObject({ result: runtimeSnapshot })
    expect(await request(browser, 'runtime')).toMatchObject({ error: { message: 'CAPABILITY_DENIED' } })
    expect(await request(reader, 'reloadLocal')).toMatchObject({ error: { message: 'CAPABILITY_DENIED' } })
    expect(rescanned).toBe(false)
    expect(await request(ep, 'reloadLocal')).toMatchObject({ result: {} })
    expect(rescanned).toBe(true)
    expect(await request(ep, 'loops')).toMatchObject({
      result: { loops: [loop], presets: ['standard', 'minimal'] },
    })
    expect(await request(ep, 'modelAdapters')).toMatchObject({
      result: { modelAdapters: [{ ...adapter, models: [{ id: 'model', route: 'account' }] }] },
    })
    const input = {
      revision: 0,
      defaults: {
        preset: 'minimal',
        permission: 'read-only',
        providers: {
          loop: { provider: loop.id, version: loop.version },
          'model-adapter': { provider: adapter.id, version: adapter.version },
        },
        model: 'model',
      },
    }
    expect(await request(browser, 'defaults.save', input)).toMatchObject({
      error: { message: 'CAPABILITY_DENIED' },
    })
    expect(await request(reader, 'defaults.save', input)).toMatchObject({
      error: { message: 'CAPABILITY_DENIED' },
    })
    expect(
      await request(ep, 'defaults.save', {
        ...input,
        defaults: { providers: { loop: { ...input.defaults.providers.loop, version: 'missing' } } },
      }),
    ).toMatchObject({ error: { data: { reason: 'CONFIG_INVALID_INPUT' } } })
    expect(await request(ep, 'defaults.save', input)).toMatchObject({
      result: { revision: 1, defaults: input.defaults },
    })
    expect(await createConfigurationService({ home, profile: 'local-dev' }).sessionDefaults()).toEqual({
      revision: 1,
      defaults: input.defaults,
    })
    expect(await request(ep, 'defaults.save', input)).toMatchObject({
      error: { data: { reason: 'CONFIG_REVISION_CONFLICT' } },
    })
  } finally {
    await Promise.all([ep.close(), browser.close(), reader.close()])
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

it('lists a payload-only adapter without models and refuses its models as the default', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'agnes-selection-'))
  const home = join(fixtureRoot, 'home')
  createPrivateDirectorySync(home)
  const configuration = createConfigurationService({ home, profile: 'local-dev' })
  const entry = (id: string, wireApi: string, capabilities: Record<string, boolean>) => ({
    id,
    version: '1.0.0',
    wireApi,
    sourcePackage: '@acme/adapter',
    capabilities: { imageInput: false, tools: false, streaming: false, ...capabilities },
  })
  const jev = entry('typesafe-systemone', 'typesafe-systemone', { payload: true, payloadOnly: true })
  const mixed = entry('mixed', 'mixed-wire', { payload: true })
  const chat = entry('chat', 'chat-wire', { tools: true, streaming: true })
  // A community adapter that takes payloads only may name the same wire API as a chat adapter.
  const community = entry('community-jev', 'chat-wire', { payload: true, payloadOnly: true })
  const host = {
    profile: {
      presets: { default: 'standard', allowed: ['standard'] },
      provider: {
        routes: [
          { route: 'jev', api: 'typesafe-systemone' },
          { route: 'mixed-route', api: 'mixed' },
          { route: 'chat-route', api: 'chat' },
          { route: 'community-route', api: 'community-jev' },
        ],
      },
    },
    kernel: { loops: { catalog: () => [] } },
    modelAdapterCatalog: () => [chat, community, jev, mixed],
    provider: {
      models: () => [
        { id: 'jev-1', route: 'jev', api: 'typesafe-systemone' },
        { id: 'mixed-1', route: 'mixed-route', api: 'mixed-wire' },
        { id: 'chat-1', route: 'chat-route', api: 'chat-wire' },
        { id: 'community-1', route: 'community-route', api: 'chat-wire' },
      ],
    },
  } as unknown as Host
  const service = sessionSelectionProvider(configuration, () => hostSessionCatalog(host))
  const ep = new LocalEndpoint({ clock: Date.now, principalId: 'owner' })
  ep.conn.initialized = true
  ep.conn.authKind = 'local'
  ep.conn.credentialKind = 'local'
  registerSessionSelection(ep, service, localPackageAdminAuthority())
  const request = (method: string, params: unknown = {}) =>
    ep.handle({ jsonrpc: '2.0', id: 1, method: `_agnes/v1/sessionSelection.${method}`, params })
  const save = (provider: string, model: string, revision = 0) =>
    request('defaults.save', {
      revision,
      defaults: { providers: { 'model-adapter': { provider, version: '1.0.0' } }, model },
    })
  try {
    // The adapter itself stays visible to the administrator, with its capabilities.
    expect(await request('modelAdapters')).toMatchObject({
      result: {
        modelAdapters: [
          { ...chat, models: [{ id: 'chat-1', route: 'chat-route' }] },
          { ...community, models: [] },
          { ...jev, models: [] },
          { ...mixed, models: [{ id: 'mixed-1', route: 'mixed-route' }] },
        ],
      },
    })
    // Naming a payload-only model as the default is refused like any model the host does not offer.
    expect(await save('typesafe-systemone', 'jev-1')).toMatchObject({
      error: { data: { reason: 'CONFIG_MODEL_UNAVAILABLE' } },
    })
    expect(await configuration.sessionDefaults()).toEqual({ revision: 0, defaults: {} })
    // A mixed adapter takes messages too, so its model stays selectable.
    expect(await save('mixed', 'mixed-1')).toMatchObject({ result: { revision: 1 } })
  } finally {
    await ep.close()
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

it('projects no conversation models for the route a saved configuration account produced', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'agnes-selection-'))
  const home = join(fixtureRoot, 'home')
  createPrivateDirectorySync(home)
  const configuration = createConfigurationService({ home, profile: 'local-dev' })
  const credentialRef = 'secret://generic/11111111-1111-4111-8111-111111111111'
  await createCredentialStore({ root: home }).putGeneric(credentialRef, 'jev-test-key', {
    label: 'Jev',
    createdAt: '2026-10-16T00:00:00.000Z',
  })
  await configuration.save({
    providerId: 'typesafe-systemone',
    accountId: 'jev',
    label: 'Jev',
    credentialRef,
    model: 'typesafe/jev-1.13-20260917',
    models: [{ id: 'typesafe/jev-1.13-20260917', name: 'Jev 1.13', contextWindow: 65536, maxTokens: 32768 }],
    expectedRevision: 0,
  })
  const generated = (await configuration.profileInput()).provider?.routes ?? []
  expect(generated.map((decl) => [decl.route, decl.api])).toEqual([['account-jev', 'typesafe-systemone']])
  const entry = (id: string, wireApi: string, capabilities: Record<string, boolean>) => ({
    id,
    version: '1.0.0',
    wireApi,
    sourcePackage: '@acme/adapter',
    capabilities: { imageInput: false, tools: false, streaming: false, ...capabilities },
  })
  const jev = entry('typesafe-systemone', 'typesafe-systemone', { payload: true, payloadOnly: true })
  const chat = entry('chat', 'chat-wire', { tools: true, streaming: true })
  const host = {
    profile: {
      presets: { default: 'standard', allowed: ['standard'] },
      provider: { routes: [...generated, { route: 'chat-route', api: 'chat' }] },
    },
    kernel: { loops: { catalog: () => [] } },
    modelAdapterCatalog: () => [chat, jev],
    provider: {
      models: () => [
        { id: 'typesafe/jev-1.13-20260917', route: 'account-jev', api: 'typesafe-systemone' },
        { id: 'chat-1', route: 'chat-route', api: 'chat-wire' },
      ],
    },
  } as unknown as Host
  const service = sessionSelectionProvider(configuration, () => hostSessionCatalog(host))
  const ep = new LocalEndpoint({ clock: Date.now, principalId: 'owner' })
  ep.conn.initialized = true
  ep.conn.authKind = 'local'
  ep.conn.credentialKind = 'local'
  registerSessionSelection(ep, service, localPackageAdminAuthority())
  const request = (method: string, params: unknown = {}) =>
    ep.handle({ jsonrpc: '2.0', id: 1, method: `_agnes/v1/sessionSelection.${method}`, params })
  try {
    expect(await request('modelAdapters')).toMatchObject({
      result: {
        modelAdapters: [
          { ...chat, models: [{ id: 'chat-1', route: 'chat-route' }] },
          { ...jev, models: [] },
        ],
      },
    })
    expect(
      await request('defaults.save', {
        revision: 0,
        defaults: {
          providers: { 'model-adapter': { provider: 'typesafe-systemone', version: '1.0.0' } },
          model: 'typesafe/jev-1.13-20260917',
        },
      }),
    ).toMatchObject({ error: { data: { reason: 'CONFIG_MODEL_UNAVAILABLE' } } })
  } finally {
    await ep.close()
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})
