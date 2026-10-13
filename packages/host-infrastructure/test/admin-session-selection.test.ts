import { expect, it, vi } from 'vitest'
import { createAdminSessionSelection } from '../src/admin-session-selection.js'

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
      presets: async () => ['read-only', 'workspace-write', 'full-access'],
      loops: async () => [loop],
      modelAdapters: async () => [adapter],
      models: async () => adapter.models,
    },
    { sessionDefaults: async () => ({ revision: 0, defaults: {} }), saveSessionDefaults: save },
  )
  const input = {
    revision: 0,
    defaults: {
      preset: 'read-only',
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
  expect(await provider.presets?.()).toEqual(['read-only', 'workspace-write', 'full-access'])
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
