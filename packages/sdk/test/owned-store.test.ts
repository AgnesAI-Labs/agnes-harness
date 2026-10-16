import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createOwnedStore } from '../src/owned-store.node.js'

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
function database() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  return db
}
describe('namespace-owned managed storage', () => {
  it('provides isolated CAS transactions and rolls back all writes on conflict or callback failure', async () => {
    const db = database(),
      one = createOwnedStore(db, 'one'),
      two = createOwnedStore(db, 'two')
    await one.transaction((tx) => {
      tx.put('state', { value: 1 }, null)
      tx.put('outbox', { wake: 'one' }, null)
    })
    const initial = await one.scan({ prefix: '', limit: 1000 })
    expect(initial.rows.map((r) => r.key)).toEqual(['outbox', 'state'])
    expect((await two.scan({ prefix: '', limit: 1000 })).rows).toEqual([])
    await expect(
      one.transaction((tx) => {
        tx.put('new', {}, null)
        tx.put('state', {}, null)
      }),
    ).rejects.toThrow('CONFLICT')
    await expect(
      one.transaction((tx) => {
        const outbox = initial.rows[0]
        if (!outbox) throw new Error('missing fixture')
        tx.remove('outbox', outbox.revision)
        throw new Error('crash')
      }),
    ).rejects.toThrow('crash')
    expect(await one.scan({ prefix: '', limit: 1000 })).toEqual(initial)
    await one.transaction((tx) => {
      const state = tx.get('state')
      if (!state) throw new Error()
      tx.put('state', { value: 2 }, state.revision)
    })
    expect((await one.scan({ prefix: 'state', limit: 1 })).rows[0]?.value).toEqual({ value: 2 })
  })
  it('bounds keys, values, scans and namespace quota, refusing async and escaped transactions', async () => {
    const store = createOwnedStore(database(), 'bounded', 30)
    for (const key of ['', 'bad\nkey', 'x'.repeat(513)])
      await expect(store.transaction((tx) => tx.put(key, {}, null))).rejects.toThrow('INVALID')
    await expect(store.transaction((tx) => tx.put('value', 'x'.repeat(131073), null))).rejects.toThrow(
      'INVALID',
    )
    await expect(store.transaction((tx) => tx.put('value', 'x'.repeat(40), null))).rejects.toThrow('QUOTA')
    expect((await store.scan({ prefix: '', limit: 1 })).rows).toEqual([])
    await expect(store.scan({ prefix: '', limit: 1001 })).rejects.toThrow('INVALID')
    let escaped: Parameters<Parameters<typeof store.transaction>[0]>[0] | undefined
    await store.transaction((tx) => {
      escaped = tx
    })
    expect(() => escaped?.get('value')).toThrow('CLOSED')
    await expect(store.transaction(async () => 1)).rejects.toThrow('INVALID')
  })
  it('binds cursors to namespace, prefix and mutation watermark', async () => {
    const db = database(),
      one = createOwnedStore(db, 'one'),
      two = createOwnedStore(db, 'two')
    await one.transaction((tx) => {
      tx.put('a', 1, null)
      tx.put('b', 2, null)
    })
    const first = await one.scan({ prefix: '', limit: 1 })
    expect(first.rows[0]?.key).toBe('a')
    expect(first.nextCursor).toBeTypeOf('string')
    if (!first.nextCursor) throw new Error('missing cursor')
    expect((await one.scan({ prefix: '', limit: 1, cursor: first.nextCursor })).rows[0]?.key).toBe('b')
    await expect(two.scan({ prefix: '', limit: 1, cursor: first.nextCursor })).rejects.toThrow('CONFLICT')
    await expect(one.scan({ prefix: 'a', limit: 1, cursor: first.nextCursor })).rejects.toThrow('CONFLICT')
    await one.transaction((tx) => tx.put('c', 3, null))
    await expect(one.scan({ prefix: '', limit: 1, cursor: first.nextCursor })).rejects.toThrow('CONFLICT')
  })
})
