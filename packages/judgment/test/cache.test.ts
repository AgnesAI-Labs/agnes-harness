import { afterEach, expect, it, vi } from 'vitest'
import { createAnswerCache } from '../src/cache.js'

afterEach(() => vi.useRealTimers())
const target = { route: 'jev', model: 'j', native: true }
const question = { type: 'noul' as const, instructions: 'done?' }
const answer = { type: 'noul' as const, noul: 0.9 }
const opts = { ttlMs: 30 * 86400000, maxEntries: 2 }
it('stores hash and answer only', () => {
  const rows = new Map<string, any>()
  const store = {
    get: (key: string) => rows.get(key),
    set: (key: string, value: any) => {
      rows.set(key, value)
    },
    delete: (key: string) => {
      rows.delete(key)
    },
    scan: () => ({ rows: [] }),
  }
  const cache = createAnswerCache(store, opts)
  cache.set('PRIVATE_STATE_SENTINEL', target, question, answer)
  expect([...rows.keys()][0]).toMatch(/^[a-f0-9]{64}$/)
  expect([...rows.values()][0]).toEqual({ answer, at: expect.any(Number) })
  expect(JSON.stringify([...rows])).not.toContain('PRIVATE_STATE_SENTINEL')
})
it('expires after 30 days', () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const cache = createAnswerCache(null, opts)
  cache.set('s', target, question, answer)
  vi.setSystemTime(opts.ttlMs - 1)
  expect(cache.get('s', target, question)).toEqual(answer)
  vi.setSystemTime(opts.ttlMs)
  expect(cache.get('s', target, question)).toBeNull()
})
it('evicts least recently used over maxEntries', () => {
  const cache = createAnswerCache(null, opts)
  for (const s of ['a', 'b']) cache.set(s, target, question, answer)
  cache.get('a', target, question)
  cache.set('c', target, question, answer)
  expect(cache.get('b', target, question)).toBeNull()
  expect(cache.get('a', target, question)).toEqual(answer)
})
it('disables itself when the store throws', () => {
  const get = vi.fn(() => {
    throw Error('storage')
  })
  const cache = createAnswerCache({ get, set: vi.fn(), delete: vi.fn(), scan: () => ({ rows: [] }) }, opts)
  expect(cache.get('a', target, question)).toBeNull()
  expect(cache.get('a', target, question)).toBeNull()
  expect(get).toHaveBeenCalledTimes(1)
})
it('canonicalizes state while retaining choice option order', () => {
  const cache = createAnswerCache(null, opts)
  cache.set({ a: 1, b: 2 }, target, question, answer)
  expect(cache.get({ b: 2, a: 1 }, target, question)).toEqual(answer)
  const q = { type: 'choice' as const, instructions: 'pick', criteria: { x: null, y: null } }
  cache.set('s', target, q, { type: 'choice', choice: 'x', probabilities: { x: 1, y: 0 }, confidence: 1 })
  expect(cache.get('s', target, { ...q, criteria: { y: null, x: null } })).toBeNull()
})
