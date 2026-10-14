import { afterEach, expect, it } from 'vitest'
import {
  forgetInventory,
  rememberInventory,
  seededState,
} from '../src/admin/plugins/admin/inventory-cache.js'
import type { AdminPageState } from '../src/admin/plugins/types.js'

afterEach(() => forgetInventory())

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
