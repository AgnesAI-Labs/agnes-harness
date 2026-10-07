import { expect, it, vi } from 'vitest'
import { createAdminSessionSelection } from '../src/admin-session-selection.js'

it('validates exact catalog versions and model ids before persisting defaults', async () => {
  const save = vi.fn(async (input) => ({ ...input, revision: input.revision + 1 }))
  const loop = { id: 'loop', version: '1.0.0', sourcePackage: '@acme/loop', capabilities: ['resume'] }
  const adapter = {
    ...loop,
    id: 'adapter',
    api: 'custom',
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
      loop: { id: 'loop', version: '1.0.0' },
      modelAdapter: { id: 'adapter', version: '1.0.0', model: 'model' },
    },
  }
  expect(await provider.loops()).toEqual([loop])
  expect(await provider.getDefaults()).toEqual({ revision: 0, defaults: {} })
  expect(await provider.saveDefaults(input)).toEqual({ ...input, revision: 1 })
  expect(await provider.presets?.()).toEqual(['read-only', 'workspace-write', 'full-access'])
  for (const defaults of [
    { preset: 'absent' },
    { loop: { id: 'loop', version: '2.0.0' } },
    { loop: { id: 'absent', version: '1.0.0' } },
    { modelAdapter: { id: 'adapter', version: '1.0.0', model: 'absent' } },
    { modelAdapter: { id: 'absent', version: '1.0.0', model: 'model' } },
  ])
    await expect(provider.saveDefaults({ revision: 0, defaults })).rejects.toThrow()
  expect(save).toHaveBeenCalledOnce()
})
