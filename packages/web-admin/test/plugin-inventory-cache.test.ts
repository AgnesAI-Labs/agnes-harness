/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest'
import {
  forgetInventory,
  readInventorySnapshot,
  rememberInventory,
  seededState,
} from '../src/admin/plugins/admin/inventory-cache.js'
import { PluginAdminApi } from '../src/admin/plugins/api.js'
import type { AdminPageState } from '../src/admin/plugins/types.js'

afterEach(() => {
  forgetInventory()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const empty = {
  installed: [],
  surfaceLinks: [],
  catalog: [],
  nextCursor: null,
  operations: new Map(),
  runtime: new Map(),
  inventoryAuthoritative: false,
  loading: true,
  connection: 'loading',
} as unknown as AdminPageState

it('starts a first visit empty, and a later one from the inventory it read, still reading again', () => {
  expect(seededState(empty)).toBe(empty)
  const read = {
    ...empty,
    context: { readOnly: false } as unknown as AdminPageState['context'],
    installed: [{ id: '@agnes/plugin-helper' }] as unknown as AdminPageState['installed'],
    inventoryAuthoritative: true,
    loading: false,
    connection: 'connected',
  } as AdminPageState
  rememberInventory(read)
  const seeded = seededState(empty)
  expect(seeded.installed).toEqual(read.installed)
  expect(seeded.context).toEqual(read.context)
  // Shown at once, but not authoritative until the new read lands.
  expect(seeded.connection).toBe('connected')
  expect(seeded.loading).toBe(true)
  expect(seeded.inventoryAuthoritative).toBe(false)
})

it('does not cache a read invalidated in flight or reuse a snapshot after its retention window', async () => {
  vi.useFakeTimers()
  const context = {
    profile: 'test',
    clientId: 'web',
    permissions: ['packages.read' as const],
    readOnly: false,
  }
  const api = new PluginAdminApi(context)
  const list = vi.spyOn(api, 'list').mockResolvedValue({ packages: [] } as never)
  vi.spyOn(api, 'treeList').mockResolvedValue({ nodes: [] } as never)
  vi.spyOn(api, 'surfaceLinks').mockResolvedValue({ surfaces: [] })
  vi.spyOn(api, 'runtime').mockResolvedValue({ providers: [] } as never)
  vi.spyOn(api, 'composition').mockResolvedValue({} as never)
  vi.spyOn(api, 'catalog').mockResolvedValue({ items: [], nextCursor: null })
  const oldRead = readInventorySnapshot(api, context, true)
  window.dispatchEvent(new Event('agnes:plugins-invalidated'))
  await oldRead
  await readInventorySnapshot(api, context, true)
  expect(list).toHaveBeenCalledTimes(2)
  await readInventorySnapshot(api, context, true)
  expect(list).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(30_001)
  await readInventorySnapshot(api, context, true)
  expect(list).toHaveBeenCalledTimes(3)
  window.dispatchEvent(new Event('online'))
  await readInventorySnapshot(api, context, true)
  expect(list).toHaveBeenCalledTimes(4)
  list.mockRejectedValueOnce(new Error('offline'))
  await expect(readInventorySnapshot(api, context, false)).rejects.toThrow('offline')
  await readInventorySnapshot(api, context, true)
  expect(list).toHaveBeenCalledTimes(6)
})

it('uses the overview inventory without a second package list read', async () => {
  const context = {
    profile: 'test',
    clientId: 'web',
    permissions: ['packages.read' as const],
    readOnly: false,
  }
  const api = new PluginAdminApi(context)
  const list = vi.spyOn(api, 'list').mockResolvedValue({ packages: [] } as never)
  vi.spyOn(api, 'treeList').mockResolvedValue({ nodes: [] } as never)
  vi.spyOn(api, 'surfaceLinks').mockResolvedValue({ surfaces: [] })
  vi.spyOn(api, 'runtime').mockResolvedValue({ providers: [] } as never)
  vi.spyOn(api, 'composition').mockResolvedValue({} as never)
  vi.spyOn(api, 'catalog').mockResolvedValue({ items: [], nextCursor: null })
  const inventory = { packages: [] }
  expect((await readInventorySnapshot(api, context, false, inventory)).list).toEqual(inventory)
  expect(list).not.toHaveBeenCalled()
  const updated = { packages: [], generations: { generations: [], plugins: [] } }
  expect((await readInventorySnapshot(api, context, true, updated)).list).toEqual(updated)
  expect(list).not.toHaveBeenCalled()
})
