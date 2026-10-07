import { Context } from '@agnes/cordis'
import type { CompactionEngine } from '@agnes/extension-api'
import { expect, it } from 'vitest'
import { assembleCompaction } from '../../src/assemble/compaction.js'
import { installCompactionEngines } from '../../src/assemble/compaction-engines.js'
import { resolveProfile } from '../../src/profile/resolve.js'

const engine = (id = 'default'): CompactionEngine => ({
  id,
  version: '1.0.0',
  create: () => ({ shouldCompact: () => true, compact: async () => null }),
})

it('selects registered engines, rejects missing/duplicate ids, and unloads with the plugin', async () => {
  const root = new Context()
  const registry = installCompactionEngines(root)
  const plugin = root.plugin((ctx) => {
    ctx.compactionEngines.register(engine())
  })
  await expect.poll(() => registry.catalog().length).toBe(1)
  expect(Object.isFrozen(registry.catalog()[0])).toBe(true)
  expect(() => registry.register(engine())).toThrow('duplicate compaction engine')
  const runner = (await assembleCompaction(registry))!
  expect(runner.shouldCompact({ contextTokens: 0, contextWindow: 100, reserveTokens: 20 })).toBe(true)
  await expect(assembleCompaction(registry, { engine: 'missing' })).rejects.toThrow(
    'compaction engine is not registered: missing',
  )
  await plugin.dispose()
  expect(registry.catalog()).toEqual([])
  expect(() => runner.shouldCompact({ contextTokens: 0, contextWindow: 100, reserveTokens: 20 })).toThrow(
    'unloaded',
  )
  expect(await assembleCompaction(registry)).toBeUndefined()
  await root.fiber.dispose()
})

it('retains profile selection in its immutable result and hash and refuses invalid config', async () => {
  const env = {
    platform: { os: 'linux' as const, arch: 'x64', capabilities: {} },
    agnesVersion: '1.4.0',
    now: '2026-10-07',
    homeDir: '/synthetic/home',
  }
  const baseline = await resolveProfile({ builtin: 'local-dev' }, env)
  const profile = await resolveProfile(
    { builtin: 'local-dev', user: { name: 'test', compaction: { engine: 'sliding-window' } } },
    env,
  )
  expect(profile.compaction).toEqual({ engine: 'sliding-window' })
  expect(profile.hash).not.toBe(baseline.hash)
  await expect(
    resolveProfile({ builtin: 'local-dev', user: { name: 'test', compaction: { engine: '' } } }, env),
  ).rejects.toThrow('compaction.engine')
})

it('drains late creates before instance disposal and reports both disposal and cleanup failures', async () => {
  const root = new Context()
  const registry = installCompactionEngines(root)
  let finish!: (value: ReturnType<NonNullable<CompactionEngine['create']>>) => void
  const order: string[] = []
  const unregister = registry.register({
    ...engine('late'),
    create: () =>
      new Promise((resolve) => {
        finish = resolve
      }),
    cleanup() {
      order.push('cleanup')
      throw new Error('cleanup failure')
    },
  })
  const creating = registry.create('late')
  void creating.catch(() => {})
  await Promise.resolve()
  const unloading = unregister()
  void unloading.catch(() => {})
  expect(unregister()).toBe(unloading)
  await Promise.resolve()
  expect(order).toEqual([])
  finish({
    shouldCompact: () => true,
    compact: async () => null,
    dispose() {
      order.push('dispose')
      throw new Error('dispose failure')
    },
  })
  await expect(creating).rejects.toMatchObject({
    errors: [expect.objectContaining({ message: 'dispose failure' })],
  })
  await expect(unloading).rejects.toMatchObject({
    errors: [
      expect.objectContaining({ errors: [expect.objectContaining({ message: 'dispose failure' })] }),
      expect.objectContaining({ message: 'cleanup failure' }),
    ],
  })
  expect(order).toEqual(['dispose', 'cleanup'])
  await root.fiber.dispose()
})
