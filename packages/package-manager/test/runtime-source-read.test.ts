import { beforeEach, expect, it, vi } from 'vitest'
import type { Lockfile } from '../src/lockfile.js'
import { createRuntimeSourceReader, readRuntimePluginSnapshots } from '../src/runtime-source-read.js'

const state = vi.hoisted(() => ({
  writing: true,
  finishOnPause: true,
  pauses: [] as number[],
  reads: 0,
  error: undefined as Error | undefined,
  finishDuringRead: false,
}))
vi.mock('node:fs', () => ({ existsSync: () => state.writing }))
vi.mock('node:timers/promises', () => ({
  setTimeout: async (ms: number) => {
    state.pauses.push(ms)
    if (state.finishOnPause) {
      state.writing = false
      state.error = undefined
    }
  },
}))
vi.mock('../src/inventory-boundary.js', () => ({
  readBoundary: (_profile: string, files: string[]) =>
    files.includes('.agnes-runtime-transaction.json') ? String(state.writing) : 'unchanged',
}))
vi.mock('../src/inventory.js', () => ({
  readInventoryAsync: async () => {
    state.reads++
    if (state.finishDuringRead) state.writing = false
    if (state.error) throw state.error
    return { hash: 'verified-inventory', packages: [] }
  },
}))
vi.mock('../src/runtime-snapshots.js', () => ({ listRuntimePinsStoreAsync: async () => [] }))
vi.mock('../src/package-plugin-loader.js', () => ({
  runtimePluginSnapshotsFromPins: () => [],
  runtimePluginDataSourcesFromInventory: () => [],
}))
vi.mock('../src/verification-operation.js', () => ({
  invalidatePackageVerification: vi.fn(),
  withPackageVerification: (read: () => Promise<unknown>) => read(),
}))

const input: Parameters<typeof readRuntimePluginSnapshots>[1] = {
  store: {
    dataDir: '/synthetic',
    profileDir: '/synthetic/profile',
    profile: 'test',
    agnesVersion: '0.1.0',
    now: () => '2026-10-22T00:00:00Z',
  },
  load: () => ({}) as Lockfile,
  ceiling: () => [],
  verificationCache: new Map(),
}
beforeEach(() => {
  Object.assign(state, {
    writing: true,
    finishOnPause: true,
    reads: 0,
    error: undefined,
    finishDuringRead: false,
  })
  state.pauses.length = 0
})

it('lets an announced writer finish between successful but torn reads', async () => {
  await expect(readRuntimePluginSnapshots('/synthetic/profile', input)).resolves.toEqual([])
  expect(state.pauses).toEqual([50])
})

it('keeps a writer that never finishes bounded by the existing retry limit', async () => {
  state.finishOnPause = false
  await expect(readRuntimePluginSnapshots('/synthetic/profile', input)).rejects.toMatchObject({
    detail: { reason: 'runtime-source-stale' },
  })
  expect(state.reads).toBe(6)
  expect(state.pauses.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(300)
})

it('refuses unexplained integrity failures without waiting or accepting a later read', async () => {
  state.writing = false
  state.error = Object.assign(new Error('unexplained byte change'), { code: 'E_PACKAGE_INTEGRITY' })
  await expect(readRuntimePluginSnapshots('/synthetic/profile', input)).rejects.toBe(state.error)
  expect(state.reads).toBe(1)
  expect(state.pauses).toEqual([])
})

it('remembers a writer observed before it finishes during a rejected read', async () => {
  state.finishDuringRead = true
  state.error = new Error('snapshot store requires recovery')
  await expect(readRuntimePluginSnapshots('/synthetic/profile', input)).resolves.toEqual([])
  expect(state.pauses).toEqual([50])
})

it('does not share an older in-flight read across a newly announced transaction', async () => {
  state.writing = false
  const load = vi.fn(input.load)
  const read = createRuntimeSourceReader()
  const before = read('/synthetic/profile', { ...input, load })
  state.writing = true
  const during = read('/synthetic/profile', { ...input, load })
  const started = load.mock.calls.length
  await Promise.allSettled([before, during])
  expect(started).toBe(2)
})
