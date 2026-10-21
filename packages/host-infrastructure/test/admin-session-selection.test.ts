import { expect, it, vi } from 'vitest'
import {
  conversationModelAdapters,
  createAdminSessionSelection,
  payloadOnlyRoutes,
} from '../src/admin-session-selection.js'
import { permissionLevelDefaults } from '../src/session-defaults-permission.js'

it('validates exact catalog versions and model ids before persisting defaults', async () => {
  const save = vi.fn(async (input) => ({ ...input, revision: input.revision + 1 }))
  const loop = { id: 'loop', version: '1.0.0', sourcePackage: '@acme/loop', capabilities: ['resume'] }
  const adapter = {
    ...loop,
    id: 'adapter',
    wireApi: 'custom',
    capabilities: { imageInput: true, tools: true, streaming: true },
    models: [{ id: 'model' }],
  }
  const provider = createAdminSessionSelection(
    {
      presets: async () => ['standard', 'minimal'],
      permissions: async () => ['read-only', 'workspace-write'],
      loops: async () => [loop],
      modelAdapters: async () => [adapter],
      models: async () => adapter.models,
    },
    { sessionDefaults: async () => ({ revision: 0, defaults: {} }), saveSessionDefaults: save },
  )
  const input = {
    revision: 0,
    defaults: {
      preset: 'minimal',
      permission: 'read-only' as const,
      providers: {
        loop: { provider: 'loop', version: '1.0.0' },
        'model-adapter': { provider: 'adapter', version: '1.0.0' },
      },
      model: 'model',
    },
  }
  expect(await provider.loops()).toEqual([loop])
  expect(await provider.getDefaults()).toEqual({ revision: 0, defaults: {} })
  expect(await provider.saveDefaults(input)).toEqual({ ...input, revision: 1 })
  expect(await provider.presets?.()).toEqual(['standard', 'minimal'])
  for (const defaults of [
    { preset: 'absent' },
    { providers: { loop: { provider: 'loop', version: '2.0.0' } } },
    { providers: { loop: { provider: 'absent', version: '1.0.0' } } },
    { providers: { 'model-adapter': { provider: 'adapter', version: '1.0.0' } }, model: 'absent' },
    { providers: { 'model-adapter': { provider: 'absent', version: '1.0.0' } }, model: 'model' },
    // A model without the adapter that serves it, and the retired spellings, are not selections.
    { model: 'model' },
    { loop: { id: 'loop', version: '1.0.0' } } as never,
    { modelAdapter: { id: 'adapter', version: '1.0.0', model: 'model' } } as never,
  ])
    await expect(provider.saveDefaults({ revision: 0, defaults })).rejects.toThrow()
  expect(save).toHaveBeenCalledOnce()
})

it('saves a default permission beside the default recipe, checked against the levels offered', async () => {
  const save = vi.fn(async (input) => ({ ...input, revision: input.revision + 1 }))
  const provider = createAdminSessionSelection(
    {
      presets: async () => ['standard', 'minimal'],
      permissions: async () => ['read-only', 'workspace-write'],
      loops: async () => [],
      modelAdapters: async () => [],
      models: async () => [],
    },
    { sessionDefaults: async () => ({ revision: 0, defaults: {} }), saveSessionDefaults: save },
  )
  expect(await provider.permissions?.()).toEqual(['read-only', 'workspace-write'])
  const defaults = { preset: 'minimal', permission: 'read-only' } as const
  expect(await provider.saveDefaults({ revision: 0, defaults })).toEqual({ revision: 1, defaults })
  // A level the deployment does not offer, and a name that is not a level, are not saved.
  await expect(
    provider.saveDefaults({ revision: 1, defaults: { permission: 'full-access' } }),
  ).rejects.toThrow()
  await expect(
    provider.saveDefaults({ revision: 1, defaults: { permission: 'root' as never } }),
  ).rejects.toThrow()
  expect(save).toHaveBeenCalledOnce()
})

it('refuses saved permission-as-recipe aliases and preserves real recipe defaults', () => {
  for (const preset of ['read-only', 'workspace-write', 'full-access'])
    expect(() => permissionLevelDefaults({ preset })).toThrow(/Retired.*clean home/)
  expect(permissionLevelDefaults({ preset: 'default', permission: 'read-only' })).toEqual({
    preset: 'default',
    permission: 'read-only',
  })
  expect(permissionLevelDefaults({ preset: 'minimal' })).toEqual({ preset: 'minimal' })
  expect(permissionLevelDefaults(undefined)).toEqual({})
})

const entry = (
  id: string,
  wireApi: string,
  capabilities: {
    imageInput?: boolean
    tools?: boolean
    streaming?: boolean
    payload?: boolean
    payloadOnly?: boolean
  },
) => ({
  id,
  version: '1.0.0',
  wireApi,
  sourcePackage: '@acme/adapter',
  capabilities: { imageInput: false, tools: false, streaming: false, ...capabilities },
})

it('offers no conversation model for a payload-only adapter and keeps the adapter listed', () => {
  const jev = entry('jev', 'jev-wire', { payload: true, payloadOnly: true })
  const mixed = entry('mixed', 'mixed-wire', { payload: true })
  const models = [
    { id: 'j', route: 'r1', api: 'jev-wire' },
    { id: 'm', route: 'r2', api: 'mixed-wire' },
  ]
  const routes = [
    { route: 'r1', api: 'jev' },
    { route: 'r2', api: 'mixed' },
  ]
  expect(conversationModelAdapters([jev, mixed], models, routes)).toEqual([
    { ...jev, models: [] },
    { ...mixed, models: [{ id: 'm', route: 'r2' }] },
  ])
})

it('finds payload-only routes by the registration that serves them, not by wire API', () => {
  // A community payload-only adapter may name the same wire API as a chat adapter.
  const chat = entry('chat', 'shared-wire', { tools: true })
  const payload = entry('community-jev', 'shared-wire', { payload: true, payloadOnly: true })
  const routes = [
    { route: 'chat-route', api: 'chat' },
    { route: 'jev-route', api: 'community-jev' },
    { route: 'unregistered', api: 'nobody' },
  ]
  expect([...payloadOnlyRoutes([chat, payload], routes)]).toEqual(['jev-route'])
  // The chat adapter lists no model of the payload-only route, although both name the wire API.
  const models = [
    { id: 'c', route: 'chat-route', api: 'shared-wire' },
    { id: 'j', route: 'jev-route', api: 'shared-wire' },
  ]
  expect(conversationModelAdapters([chat, payload], models, routes)).toEqual([
    { ...chat, models: [{ id: 'c', route: 'chat-route' }] },
    { ...payload, models: [] },
  ])
  // A mixed adapter, or no registration at all, never makes a route payload-only.
  expect([...payloadOnlyRoutes([entry('chat', 'w', { payload: true })], routes)]).toEqual([])
})
