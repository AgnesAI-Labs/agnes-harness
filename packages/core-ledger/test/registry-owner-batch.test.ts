import { expect, it } from 'vitest'
import { ProjectionRegistry } from '../src/project/named.js'
import { OwnedRegistryTable, prepareOwnerReplacement } from '../src/registry/owner-batch.js'

const owner = 'fixture/one'
it.each([0, 1, 2, 3, 4, 5])(
  'rolls back reservations when participant %s conflicts, without touching six live tables',
  (index) => {
    const live = Array.from({ length: 6 }, () => new OwnedRegistryTable<string>(true))
    const next = Array.from({ length: 6 }, () => new OwnedRegistryTable<string>(true))
    for (let i = 0; i < 6; i++) {
      live[i]?.add(owner, 'old', 'old')
      next[i]?.add(owner, 'next', 'next')
    }
    live[index]?.add('fixture/other', 'next', 'foreign')
    expect(() =>
      prepareOwnerReplacement(
        owner,
        live.map((table, i) => () => {
          const candidate = next[i]
          if (!candidate) throw new Error('missing candidate')
          return table.prepare(owner, candidate)
        }),
      ),
    ).toThrow()
    for (let i = 0; i < 6; i++) {
      expect(live[i]?.get('old')).toBe('old')
      expect(live[i]?.get('next')).toBe(i === index ? 'foreign' : undefined)
      // Earlier participants have released their reservations after the failure.
      if (i !== index) live[i]?.add(owner, 'probe', 'probe')()
    }
  },
)

it('preserves old snapshots, transfers disposer ownership, and makes empty replacement remove all entries', () => {
  const live = new OwnedRegistryTable<string>(true),
    next = new OwnedRegistryTable<string>(true)
  const oldOff = live.add(owner, 'name', 'old'),
    nextOff = next.add(owner, 'name', 'next')
  const before = live.values(),
    transaction = live.prepare(owner, next)
  expect(live.values()).toEqual(['old'])
  expect(() => nextOff()).toThrow(/prepared/)
  expect(transaction.commit()).toEqual(['old'])
  oldOff()
  expect(live.values()).toEqual(['next'])
  expect(before).toEqual(['old'])
  expect(next.values()).toEqual([])
  expect(transaction.commit()).toEqual(['old'])
  nextOff()
  expect(live.size).toBe(0)
  transaction.finalize()
  live.add(owner, 'a', 'a')
  const empty = live.prepare(owner, new OwnedRegistryTable<string>(true))
  empty.commit()
  empty.finalize()
  expect(live.size).toBe(0)
})

it('restores exact old identities before finalize and never lets either generation disposer erase the other', () => {
  const live = new OwnedRegistryTable<string>(true),
    next = new OwnedRegistryTable<string>(true)
  const oldOff = live.add(owner, 'name', 'old'),
    nextOff = next.add(owner, 'name', 'next'),
    transaction = live.prepare(owner, next)
  transaction.commit()
  expect(live.values()).toEqual(['next'])
  transaction.restore()
  transaction.restore()
  expect(live.values()).toEqual(['old'])
  nextOff()
  expect(live.values()).toEqual(['old'])
  oldOff()
  expect(live.values()).toEqual([])
  expect(() => transaction.finalize()).toThrow(/not finalizable/)
})

it('finalizes a replacement once and prevents a later restore while old disposers stay identity-safe', () => {
  const removed: string[] = [],
    live = new OwnedRegistryTable<string>(true, (value) => removed.push(value)),
    next = new OwnedRegistryTable<string>(true, (value) => removed.push(value))
  const oldOff = live.add(owner, 'name', 'old'),
    nextOff = next.add(owner, 'name', 'next'),
    transaction = live.prepare(owner, next)
  transaction.commit()
  transaction.finalize()
  transaction.finalize()
  expect(removed).toEqual(['old'])
  oldOff()
  expect(live.values()).toEqual(['next'])
  expect(() => transaction.restore()).toThrow(/not restorable/)
  nextOff()
  expect(live.values()).toEqual([])
  expect(removed).toEqual(['old', 'next'])
})

it('reserves owner and names, permits independent owners, and never overwrites an interleaved commit', () => {
  const live = new OwnedRegistryTable<string>(true),
    a = new OwnedRegistryTable<string>(true),
    b = new OwnedRegistryTable<string>(true)
  a.add(owner, 'a', 'a')
  b.add('fixture/two', 'b', 'b')
  const first = live.prepare(owner, a),
    second = live.prepare('fixture/two', b)
  expect(() => live.add(owner, 'x', 'x')).toThrow()
  expect(() => live.add('fixture/three', 'a', 'x')).toThrow()
  second.commit()
  first.commit()
  expect(live.values().sort()).toEqual(['a', 'b'])
  second.finalize()
  first.finalize()
  const empty = new OwnedRegistryTable<string>(true),
    cancelled = live.prepare(owner, empty)
  cancelled.discard()
  cancelled.discard()
  expect(() => cancelled.commit()).toThrow(/discarded/)
  live.add(owner, 'x', 'x')()
  expect(live.values().sort()).toEqual(['a', 'b'])
})

it('does not resurrect an old registration released during preparation and rejects mixed owners', () => {
  const live = new OwnedRegistryTable<string>(true),
    next = new OwnedRegistryTable<string>(true)
  const off = live.add(owner, 'old', 'old')
  next.add(owner, 'new', 'new')
  const pending = live.prepare(owner, next)
  off()
  pending.commit()
  pending.finalize()
  expect(live.values()).toEqual(['new'])
  const mixed = new OwnedRegistryTable<string>()
  mixed.add('fixture/other', 'key', 'value')
  expect(() => live.prepare(owner, mixed)).toThrow(/another owner/)
})

it('clears old Projection cache and quarantine while stale disposers cannot erase new state', () => {
  const live = new ProjectionRegistry(),
    next = new ProjectionRegistry(),
    key = `${owner}/count`
  const oldOff = live.register(
    {
      key,
      stateVersion: 1,
      init: () => {
        throw Error('old')
      },
      apply: (s) => s,
    },
    { owner },
  )
  live.snapshotOne('s', key, [])
  expect(live.failures()).toHaveLength(1)
  const nextOff = next.register({ key, stateVersion: 1, init: () => 9, apply: (s) => s }, { owner })
  const committed = live.prepareOwnerReplacement(owner, next)
  committed.commit()
  expect(live.failures()).toEqual([])
  expect(live.snapshotOne('s', key, [])).toMatchObject({ state: 9 })
  oldOff()
  expect(live.cacheLine('s', key)?.state).toBe(9)
  nextOff()
  expect(live.cacheLine('s', key)).toBeUndefined()
  expect(live.registrations(owner)).toEqual([])
  committed.finalize()
})

it.each(['register', 'batch'] as const)(
  'drops legacy unowned cache when owned %s takes over a key',
  (method) => {
    const live = new ProjectionRegistry(),
      next = new ProjectionRegistry(),
      key = `${owner}/legacy`
    const definition = { key, stateVersion: 1, init: () => 1, apply: (s: number) => s }
    const legacyOff = live.register(definition)
    live.snapshotOne('s', key, [])
    legacyOff()
    expect(live.cacheLine('s', key)?.state).toBe(1)
    let off: () => void
    if (method === 'register') off = live.register({ ...definition, init: () => 2 }, { owner })
    else {
      off = next.register({ ...definition, init: () => 2 }, { owner })
      const committed = live.prepareOwnerReplacement(owner, next)
      committed.commit()
      committed.finalize()
    }
    expect(live.snapshotOne('s', key, [])).toMatchObject({ state: 2 })
    off()
    expect(live.cacheLine('s', key)).toBeUndefined()
  },
)

it('does not erase a later legacy cache when a completed Projection commit is repeated', () => {
  const live = new ProjectionRegistry(),
    next = new ProjectionRegistry(),
    key = `${owner}/later`
  const def = { key, stateVersion: 1, init: () => 9, apply: (s: number) => s }
  next.register(def, { owner })
  const prepared = live.prepareOwnerReplacement(owner, next)
  prepared.commit()
  prepared.finalize()
  live.purgeOwner(owner)
  const off = live.register(def)
  live.snapshotOne('s', key, [])
  off()
  prepared.commit()
  expect(live.cacheLine('s', key)?.state).toBe(9)
})

it('retains owned Projection cache and quarantine across restore, then retires them only on finalize', () => {
  const live = new ProjectionRegistry(),
    next = new ProjectionRegistry(),
    key = `${owner}/recoverable`
  live.register(
    {
      key,
      stateVersion: 1,
      init: () => {
        throw Error('old')
      },
      apply: (s) => s,
    },
    { owner },
  )
  live.snapshotOne('s', key, [])
  expect(live.failures()).toHaveLength(1)
  next.register({ key, stateVersion: 1, init: () => 2, apply: (s) => s }, { owner })
  const restored = live.prepareOwnerReplacement(owner, next)
  restored.commit()
  restored.restore()
  expect(live.failures()).toHaveLength(1)
  expect(live.snapshotOne('s', key, [])).toEqual({ error: 'unavailable' })

  const final = live.prepareOwnerReplacement(owner, new ProjectionRegistry())
  final.commit()
  final.finalize()
  expect(live.failures()).toEqual([])
  expect(live.cacheLine('s', key)).toBeUndefined()
})
