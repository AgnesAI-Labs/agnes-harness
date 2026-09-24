import { afterEach, expect, it, vi } from 'vitest'
import { localStorageJournal } from '../src/journal-local-storage.js'

function storage() {
  const map = new Map<string, string>()
  return {
    map,
    getItem: vi.fn((key: string) => map.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      map.set(key, value)
    }),
  }
}
afterEach(() => vi.unstubAllGlobals())
it('persists all fields and interleaves instances without rolling counters back', async () => {
  const disk = storage()
  const a = localStorageJournal(disk)
  const b = localStorageJournal(disk)
  const id = await a.clientId()
  expect(await b.clientId()).toBe(id)
  expect(await a.nextCommandId('__proto__')).toBe(`${id}:__proto__:1`)
  expect(await b.nextCommandId('__proto__')).toBe(`${id}:__proto__:2`)
  expect(await a.nextCommandId('__proto__')).toBe(`${id}:__proto__:3`)
  const cursor = { fromSeq: 8, generation: 2 }
  await a.setCursor('s', cursor)
  cursor.fromSeq = 90
  const result = await b.cursor('s')
  expect(result).toEqual({ fromSeq: 8, generation: 2 })
  if (result) result.generation = 90
  expect(await a.cursor('s')).toEqual({ fromSeq: 8, generation: 2 })
  const command = { commandId: 'c', method: 'submit', params: { text: 'original' } }
  await a.markPending('s', command)
  command.params.text = 'changed'
  const pending = await b.pending('s')
  expect(pending).toEqual([{ commandId: 'c', method: 'submit', params: { text: 'original' } }])
  pending.splice(0)
  expect(await a.pending('s')).toHaveLength(1)
  await b.clearPending('s', 'c')
  expect(await a.pending('s')).toEqual([])
})
it('uses the actual default storage getter and default key', async () => {
  const disk = storage()
  vi.stubGlobal('localStorage', disk)
  const journal = localStorageJournal()
  const id = await journal.clientId()
  expect(disk.map.has('agnes-sdk-journal')).toBe(true)
  expect(await localStorageJournal().clientId()).toBe(id)
})
it('survives a denied default property getter and keeps its memory identity', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('private origin marker')
    },
  })
  try {
    const journal = localStorageJournal()
    const id = await journal.clientId()
    await journal.setCursor('s', { fromSeq: 1, generation: 1 })
    expect(await journal.clientId()).toBe(id)
    expect(await journal.cursor('s')).toEqual({ fromSeq: 1, generation: 1 })
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})
it.each(['get', 'set'] as const)(
  'permanently falls back after a late %s failure without losing pending state',
  async (kind) => {
    const disk = storage()
    const journal = localStorageJournal(disk)
    const id = await journal.clientId()
    await journal.nextCommandId('s')
    await journal.setCursor('s', { fromSeq: 7, generation: 3 })
    await journal.markPending('s', { commandId: 'c', method: 'submit', params: {} })
    const fail = () => {
      throw new Error('private storage marker')
    }
    if (kind === 'get') disk.getItem.mockImplementationOnce(fail)
    else disk.setItem.mockImplementationOnce(fail)
    expect(await journal.nextCommandId('s')).toBe(`${id}:s:2`)
    disk.map.clear()
    expect(await journal.nextCommandId('s')).toBe(`${id}:s:3`)
    expect(await journal.cursor('s')).toEqual({ fromSeq: 7, generation: 3 })
    expect(await journal.pending('s')).toHaveLength(1)
    await journal.clearPending('s', 'c')
    expect(await journal.pending('s')).toEqual([])
    expect(disk.map.size).toBe(0)
  },
)
it('rejects malformed stored shapes and isolates custom storage keys', async () => {
  const disk = storage()
  disk.map.set('broken', JSON.stringify({ clientId: 'bad', counters: { s: -1 }, cursors: {}, pending: {} }))
  const a = localStorageJournal(disk, 'broken')
  expect(await a.clientId()).not.toBe('bad')
  const b = localStorageJournal(disk, 'other')
  expect(await b.clientId()).not.toBe(await a.clientId())
  await expect(a.setCursor('s', { fromSeq: -1, generation: 0 })).rejects.toThrow('invalid journal state')
  expect(await a.cursor('s')).toBeNull()
})
