import type { PageSessionMeta } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { createSessionInventory } from '../src/session-inventory.js'

type Row = PageSessionMeta['items'][number]
const row = (sessionId: string, archived: boolean): Row => ({ sessionId, archived, title: sessionId }) as Row

afterEach(() => vi.unstubAllGlobals())

it('keeps the default view on the paged projection and reads the full list only on request', async () => {
  const inventory = createSessionInventory()
  const list = vi
    .fn()
    .mockResolvedValueOnce({ items: [row('a', true), row('b', false)], next: 'p2' })
    .mockResolvedValueOnce({ items: [row('c', true)] })
  inventory.bind({ list, restore: vi.fn(), changed: vi.fn() })
  expect(list).not.toHaveBeenCalled()
  expect(inventory.getSnapshot()).toMatchObject({ mode: 'active', loaded: false, status: 'idle', rows: [] })

  inventory.setMode('all')
  expect(inventory.getSnapshot()).toMatchObject({ mode: 'all', status: 'loading' })
  await vi.waitFor(() => expect(inventory.getSnapshot().status).toBe('idle'))
  expect(list).toHaveBeenNthCalledWith(1, { limit: 500 })
  expect(list).toHaveBeenNthCalledWith(2, { limit: 500, cursor: 'p2' })
  expect(inventory.getSnapshot()).toMatchObject({ loaded: true, filter: 'unarchived' })
  expect(inventory.getSnapshot().rows.map((item) => item.sessionId)).toEqual(['a', 'b', 'c'])

  // The archived filter reuses the list it already read and narrows it.
  inventory.setMode('archived')
  expect(list).toHaveBeenCalledTimes(2)
  expect(inventory.getSnapshot()).toMatchObject({ mode: 'archived', filter: 'archived' })
  expect(inventory.getSnapshot().rows.map((item) => item.sessionId)).toEqual(['a', 'c'])

  inventory.setMode('active')
  expect(inventory.getSnapshot().rows).toEqual([expect.objectContaining({ sessionId: 'b' })])
})

it('stops reading when a page repeats its own cursor', async () => {
  const inventory = createSessionInventory()
  const list = vi
    .fn()
    .mockResolvedValueOnce({ items: [row('a', false)], next: 'p2' })
    .mockResolvedValueOnce({ items: [row('b', false)], next: 'p2' })
  inventory.bind({ list, restore: vi.fn(), changed: vi.fn() })
  await inventory.ensureLoaded()
  expect(list).toHaveBeenCalledTimes(2)
  expect(inventory.getSnapshot().status).toBe('idle')
})

it('reads once on demand, keeps the rows on failure and does not retry by itself', async () => {
  const inventory = createSessionInventory()
  const list = vi.fn().mockResolvedValue({ items: [row('a', false)] })
  inventory.bind({ list, restore: vi.fn(), changed: vi.fn() })
  await inventory.ensureLoaded()
  await inventory.ensureLoaded()
  expect(list).toHaveBeenCalledTimes(1)

  inventory.invalidate()
  expect(inventory.getSnapshot().loaded).toBe(false)
  await inventory.ensureLoaded()
  expect(list).toHaveBeenCalledTimes(2)

  list.mockRejectedValueOnce(new Error('list failed'))
  inventory.invalidate()
  await inventory.ensureLoaded()
  expect(inventory.getSnapshot()).toMatchObject({ status: 'error', error: 'list failed' })
  // The retry button, not an effect, owns the second attempt.
  await inventory.ensureLoaded()
  expect(list).toHaveBeenCalledTimes(3)
  expect(inventory.getSnapshot().rows.map((item) => item.sessionId)).toEqual(['a'])
})

it('keeps a restored session as a live row and refreshes the paged list', async () => {
  const inventory = createSessionInventory()
  const restore = vi.fn().mockResolvedValue(undefined)
  const changed = vi.fn().mockResolvedValue(undefined)
  inventory.bind({ list: async () => ({ items: [row('a', true), row('c', true)] }), restore, changed })
  inventory.setMode('all')
  await vi.waitFor(() => expect(inventory.getSnapshot().status).toBe('idle'))
  await inventory.restore('a')
  expect(restore).toHaveBeenCalledWith('a')
  expect(changed).toHaveBeenCalledTimes(1)
  expect(inventory.getSnapshot()).toMatchObject({ restoring: [] })
  expect(inventory.getSnapshot().rows).toEqual([
    expect.objectContaining({ sessionId: 'a', archived: false }),
    expect.objectContaining({ sessionId: 'c', archived: true }),
  ])
  // The archived filter no longer holds it; the mixed view keeps it as a normal row.
  inventory.setMode('archived')
  expect(inventory.getSnapshot().rows.map((item) => item.sessionId)).toEqual(['c'])
})

it('keeps a restore failure out of the list state and reports it to the app notice', async () => {
  const inventory = createSessionInventory()
  const error = vi.fn()
  inventory.bind({
    list: async () => ({ items: [row('a', true)] }),
    restore: vi.fn().mockRejectedValue(new Error('daemon offline')),
    changed: vi.fn(),
    error,
  })
  inventory.setMode('archived')
  await vi.waitFor(() => expect(inventory.getSnapshot().status).toBe('idle'))
  await inventory.restore('a')
  expect(inventory.getSnapshot()).toMatchObject({ rows: [{ sessionId: 'a' }], restoring: [] })
  expect(inventory.getSnapshot().error).toBeUndefined()
  expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'daemon offline' }))
})

it('does not resurrect a restored session from an older in-flight listing', async () => {
  const inventory = createSessionInventory()
  let resolve!: (page: { items: Row[] }) => void
  const list = vi
    .fn()
    .mockResolvedValueOnce({ items: [row('a', true), row('b', true)] })
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    .mockResolvedValue({ items: [row('b', true)] })
  inventory.bind({ list, restore: async () => undefined, changed: async () => undefined })
  inventory.setMode('archived')
  await vi.waitFor(() => expect(inventory.getSnapshot().status).toBe('idle'))
  const oldRead = inventory.reload()
  await inventory.restore('a')
  resolve({ items: [row('a', true), row('b', true)] })
  await oldRead
  expect(inventory.getSnapshot()).toMatchObject({ status: 'idle', rows: [{ sessionId: 'b' }] })
})

it('remembers the chosen filter and falls back to the default on a missing or bad value', () => {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  })
  storage.set('agnes.sidebar.filter.v1', 'all')
  const inventory = createSessionInventory()
  expect(inventory.getSnapshot().mode).toBe('all')

  storage.set('agnes.sidebar.filter.v1', 'nonsense')
  expect(createSessionInventory().getSnapshot().mode).toBe('active')

  inventory.setMode('archived')
  expect(storage.get('agnes.sidebar.filter.v1')).toBe('archived')
  inventory.reset()
  expect(storage.has('agnes.sidebar.filter.v1')).toBe(false)
  expect(inventory.getSnapshot()).toMatchObject({ mode: 'active', loaded: false, rows: [] })
})
