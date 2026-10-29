import type { Event } from '@agnes/core-common/types'
import { describe, expect, it } from 'vitest'
import { type ProjectionDef, ProjectionRegistry } from '../src/project/named.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
let seq = 0
const event = (type: string): Event =>
  ({
    seq: ++seq,
    ts: '2026-09-10T00:00:00.000Z',
    id: `event-${seq}`,
    type,
    data: {},
    actor,
    origin: 'principal',
    trust: 'trusted',
    lane: 'main',
    v: 1,
  }) as Event
const counter = (stateVersion = 1): ProjectionDef<{ n: number }> => ({
  key: 'turns',
  stateVersion,
  stateSchema: (value): value is { n: number } =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { n?: unknown }).n === 'number' &&
    Number.isFinite((value as { n: number }).n),
  init: () => ({ n: 0 }),
  apply: (state, row) => (row.type === 'turn/start' ? { n: state.n + 1 } : state),
  view: (state) => state.n,
})

describe('ProjectionRegistry', () => {
  it('folds named units to a cut, serves views, and resumes its versioned cache row', () => {
    seq = 0
    const registry = new ProjectionRegistry()
    registry.register(counter())
    const rows = [event('turn/start'), event('turn/end'), event('turn/start')]
    expect(registry.snapshot('session', rows, 2)).toEqual({
      asOfSeq: 2,
      units: { turns: { state: { n: 1 }, view: 1, stateVersion: 1 } },
    })
    expect(registry.cacheLine('session', 'turns')).toMatchObject({ key: 'turns', seq: 2, ver: 1 })
    expect(registry.snapshot('session', rows).units.turns).toMatchObject({ state: { n: 2 }, view: 2 })
  })

  it('invalidates a future or wrong-version cache and validates cached state before reuse', () => {
    seq = 0
    const registry = new ProjectionRegistry()
    const dispose = registry.register(counter())
    const rows = [event('turn/start'), event('turn/start')]
    const first = registry.snapshot('session', rows)
    ;(first.units.turns as { state: { n: number } }).state.n = Number.NaN
    expect(registry.snapshot('session', rows).units.turns).toMatchObject({ view: 2 })
    expect(registry.snapshot('session', rows, 1).units.turns).toMatchObject({ view: 1 })
    dispose()
    expect(registry.cacheLine('session', 'turns')).toMatchObject({ seq: 1, ver: 1 })
    registry.register(counter(2))
    expect(registry.snapshot('session', rows).units.turns).toMatchObject({ stateVersion: 2, view: 2 })
  })

  it('quarantines only the failed session/key, preserves other units, and does not retry it', () => {
    seq = 0
    let attempts = 0
    const registry = new ProjectionRegistry()
    registry.register(counter())
    registry.register({
      key: 'bad',
      stateVersion: 1,
      init: () => 0,
      apply: () => {
        attempts++
        throw new Error('boom')
      },
    })
    const rows = [event('turn/start')]
    expect(registry.snapshot('a', rows).units).toMatchObject({
      bad: { error: 'boom' },
      turns: { view: 1 },
    })
    expect(registry.snapshot('a', rows).units.bad).toEqual({ error: 'boom' })
    expect(attempts).toBe(1)
    expect(registry.snapshot('b', rows).units.bad).toEqual({ error: 'boom' })
    expect(attempts).toBe(2)
    expect(registry.failures()).toEqual([
      { key: 'bad', seq: 1, message: 'boom' },
      { key: 'bad', seq: 1, message: 'boom' },
    ])
  })

  it('quarantines a throwing cached-state validator without stopping another unit', () => {
    seq = 0
    let validatorThrows = false
    const registry = new ProjectionRegistry()
    registry.register(counter())
    registry.register({
      key: 'validated',
      stateVersion: 1,
      stateSchema: () => {
        if (validatorThrows) throw new Error('schema boom')
        return true
      },
      init: () => 0,
      apply: (state) => state + 1,
    })
    const rows = [event('turn/start')]
    registry.snapshot('session', rows)
    validatorThrows = true
    expect(registry.snapshot('session', rows).units).toMatchObject({
      turns: { view: 1 },
      validated: { error: 'schema boom' },
    })
    expect(registry.failures()).toEqual([{ key: 'validated', seq: 1, message: 'schema boom' }])
  })

  it('flags a fresh reference whose canonical data is unchanged', () => {
    seq = 0
    const registry = new ProjectionRegistry()
    registry.register({
      key: 'leaky',
      stateVersion: 1,
      init: () => ({ a: 1, b: 2 }),
      apply: () => ({ b: 2, a: 1 }),
    })
    expect(registry.snapshot('session', [event('turn/start')]).units.leaky).toEqual({
      error: 'apply returned a new reference with unchanged content at seq 1 (Object.is violated)',
    })
  })

  it('uses collision-free session/key identities and a stale disposer cannot delete a replacement', () => {
    seq = 0
    const registry = new ProjectionRegistry()
    const oldDispose = registry.register({ ...counter(), key: 'b|c' })
    registry.snapshot('a', [event('turn/start')])
    oldDispose()
    const replacement = { ...counter(2), key: 'b|c' }
    registry.register(replacement)
    oldDispose()
    registry.snapshot('a', [event('turn/start')])
    registry.register({ ...counter(), key: 'c' })
    registry.snapshot('a|b', [event('turn/start')])
    expect(registry.cacheLine('a', 'b|c')).toMatchObject({ ver: 2 })
    expect(registry.cacheLine('a|b', 'c')).toMatchObject({ ver: 1 })
  })

  it('preserves projection keys that overlap object prototype names', () => {
    const registry = new ProjectionRegistry()
    registry.register({ key: '__proto__', stateVersion: 1, init: () => 7, apply: (state) => state })
    const units = registry.snapshot('session', []).units
    expect(Object.getPrototypeOf(units)).toBeNull()
    expect(Object.hasOwn(units, '__proto__')).toBe(true)
    expect(Reflect.get(units, '__proto__')).toMatchObject({ state: 7, stateVersion: 1 })
  })

  it('rejects duplicate active keys and re-registration clears their quarantines', () => {
    seq = 0
    let broken = true
    const registry = new ProjectionRegistry()
    const definition: ProjectionDef<number> = {
      key: 'unit',
      stateVersion: 1,
      init: () => 0,
      apply: (state) => {
        if (broken) throw new Error('broken')
        return state + 1
      },
    }
    const dispose = registry.register(definition)
    expect(() => registry.register(definition)).toThrow(/E_REGISTRY_DUPLICATE/)
    expect(registry.snapshot('session', [event('turn/start')]).units.unit).toEqual({ error: 'broken' })
    dispose()
    broken = false
    registry.register({ ...definition, stateVersion: 2 })
    expect(registry.snapshot('session', [event('turn/start')]).units.unit).toMatchObject({
      state: 1,
      stateVersion: 2,
    })
  })
})

describe('owned projections', () => {
  it('reads one key without invoking other projections and fails safely for a missing key', () => {
    const registry = new ProjectionRegistry()
    registry.register(counter(), { owner: 'acme/a' })
    registry.register(
      {
        ...counter(),
        key: 'other',
        init: () => {
          throw new Error('must not run')
        },
      },
      { owner: 'acme/b' },
    )
    expect(registry.snapshotOne('s', 'turns', [])).toEqual({ state: { n: 0 }, view: 0, stateVersion: 1 })
    expect(registry.failures()).toEqual([])
    expect(registry.snapshotOne('s', 'missing', [])).toEqual({ error: 'unavailable' })
  })

  it('purges only the selected owner registration, cache and quarantine, including disposed keys', () => {
    seq = 0
    const registry = new ProjectionRegistry()
    const stale = registry.register(counter(), { owner: 'acme/a' })
    registry.register(
      {
        ...counter(),
        key: 'bad',
        init: () => {
          throw new Error('private failure')
        },
      },
      { owner: 'acme/a' },
    )
    registry.register({ ...counter(), key: 'kept' }, { owner: 'acme/b' })
    const rows = [event('turn/start')]
    expect(registry.snapshot('s', rows).units.bad).toEqual({ error: 'unavailable' })
    expect(registry.failures()).toHaveLength(1)
    registry.purgeOwner('acme/a')
    expect(registry.snapshot('s', rows).units).toEqual({
      kept: { state: { n: 1 }, view: 1, stateVersion: 1 },
    })
    expect(registry.cacheLine('s', 'turns')).toBeUndefined()
    expect(registry.cacheLine('s', 'bad')).toBeUndefined()
    expect(registry.failures()).toEqual([])
    registry.register(counter(), { owner: 'acme/b' })
    stale()
    registry.purgeOwner('acme/a')
    expect(registry.snapshotOne('s', 'turns', rows)).toMatchObject({ view: 1 })
  })

  it('owned disposal invalidates cache even when the replacement reuses its stateVersion', () => {
    const registry = new ProjectionRegistry()
    const stale = registry.register(counter(), { owner: 'acme/a' })
    registry.snapshot('s', [])
    stale()
    expect(registry.cacheLine('s', 'turns')).toBeUndefined()
    registry.register({ ...counter(), init: () => ({ n: 42 }) }, { owner: 'acme/a' })
    stale()
    expect(registry.snapshotOne('s', 'turns', [])).toMatchObject({ view: 42 })
    registry.purgeOwner('acme/a')
    expect(registry.cacheLine('s', 'turns')).toBeUndefined()
  })
})

describe('resuming from a cached line', () => {
  const ledger = () => {
    seq = 0
    return [
      event('turn/start'),
      event('turn/end'),
      event('turn/start'),
      event('turn/start'),
      event('turn/end'),
    ]
  }
  const fullRead = (rows: Event[], asOfSeq: number, definition = counter()) => {
    const registry = new ProjectionRegistry()
    registry.register(definition, { owner: 'acme/a' })
    return registry.snapshotOne('s', definition.key, rows, asOfSeq)
  }

  it('folds only the rows after the line into the unit a full read returns', () => {
    const rows = ledger()
    const registry = new ProjectionRegistry()
    registry.register(counter(), { owner: 'acme/a' })
    registry.snapshotOne('s', 'turns', rows.slice(0, 2), 2)
    expect(registry.snapshotOneAfter('s', 'turns', 2, rows.slice(2), 4)).toEqual(fullRead(rows, 4))
    expect(registry.cacheLine('s', 'turns')).toMatchObject({ seq: 4 })
    expect(registry.snapshotOneAfter('s', 'turns', 4, rows.slice(4), 5)).toEqual(fullRead(rows, 5))
    // Nothing new since the line: the line is the answer.
    expect(registry.snapshotOneAfter('s', 'turns', 5, [], 5)).toEqual(fullRead(rows, 5))
    expect(registry.cacheLine('s', 'turns')).toMatchObject({ seq: 5, state: { n: 3 } })
  })

  it('declines without touching the cache unless a full read would resume from that exact line', () => {
    const rows = ledger()
    const registry = new ProjectionRegistry()
    const dispose = registry.register(counter())
    registry.snapshotOne('s', 'turns', rows.slice(0, 3), 3)
    const line = registry.cacheLine('s', 'turns')
    expect(registry.snapshotOneAfter('s', 'missing', 3, rows.slice(3), 5)).toBeUndefined()
    expect(registry.snapshotOneAfter('other', 'turns', 3, rows.slice(3), 5)).toBeUndefined()
    expect(registry.snapshotOneAfter('s', 'turns', 2, rows.slice(2), 5)).toBeUndefined()
    expect(registry.snapshotOneAfter('s', 'turns', 4, rows.slice(4), 5)).toBeUndefined()
    expect(registry.snapshotOneAfter('s', 'turns', 3, [], 2)).toBeUndefined()
    expect(registry.cacheLine('s', 'turns')).toBe(line)
    // A reused cache from an older state version is the full read's to discard.
    dispose()
    registry.register(counter(2))
    expect(registry.snapshotOneAfter('s', 'turns', 3, rows.slice(3), 5)).toBeUndefined()
    expect(registry.cacheLine('s', 'turns')).toBe(line)
    expect(registry.snapshotOne('s', 'turns', rows, 5)).toMatchObject({ stateVersion: 2, view: 3 })
  })

  it('declines a cached state the schema rejects and leaves the refold to the full read', () => {
    const rows = ledger()
    const registry = new ProjectionRegistry()
    registry.register(counter())
    const cached = registry.snapshotOne('s', 'turns', rows.slice(0, 3), 3) as { state: { n: number } }
    cached.state.n = Number.NaN
    expect(registry.snapshotOneAfter('s', 'turns', 3, rows.slice(3), 5)).toBeUndefined()
    expect(registry.snapshotOne('s', 'turns', rows, 5)).toEqual(fullRead(rows, 5))
  })

  it('quarantines a throwing cached-state validator exactly as a full read does', () => {
    const rows = ledger()
    const prepared = () => {
      let throws = false
      const registry = new ProjectionRegistry()
      registry.register({
        key: 'validated',
        stateVersion: 1,
        stateSchema: () => {
          if (throws) throw new Error('schema boom')
          return true
        },
        init: () => 0,
        apply: (state: number) => state + 1,
      })
      registry.snapshotOne('s', 'validated', rows.slice(0, 3), 3)
      throws = true
      return registry
    }
    const resumed = prepared(),
      full = prepared()
    expect(resumed.snapshotOneAfter('s', 'validated', 3, rows.slice(3), 5)).toEqual(
      full.snapshotOne('s', 'validated', rows, 5),
    )
    expect(resumed.failures()).toEqual(full.failures())
    expect(resumed.cacheLine('s', 'validated')).toBeUndefined()
  })

  it('declines for a quarantined session even when an earlier cut left a line', () => {
    const rows = ledger()
    const registry = new ProjectionRegistry()
    registry.register({
      key: 'fragile',
      stateVersion: 1,
      init: () => 0,
      apply: (state: number, row) => {
        if (row.seq === 4) throw new Error('boom')
        return state + 1
      },
    })
    expect(registry.snapshotOne('s', 'fragile', rows, 5)).toEqual({ error: 'boom' })
    registry.snapshotOne('s', 'fragile', rows.slice(0, 3), 3)
    expect(registry.cacheLine('s', 'fragile')).toMatchObject({ seq: 3 })
    expect(registry.snapshotOneAfter('s', 'fragile', 3, rows.slice(3), 5)).toBeUndefined()
    expect(registry.snapshotOne('s', 'fragile', rows, 5)).toEqual({ error: 'boom' })
  })

  it('declines after an owner replacement commits and resumes the restored line', () => {
    const rows = ledger()
    const registry = new ProjectionRegistry()
    registry.register(counter(), { owner: 'acme/a' })
    registry.snapshotOne('s', 'turns', rows.slice(0, 3), 3)
    const candidate = new ProjectionRegistry()
    const replaced = { ...counter(), init: () => ({ n: 10 }) }
    candidate.register(replaced, { owner: 'acme/a' })
    const replacement = registry.prepareOwnerReplacement('acme/a', candidate)
    expect(registry.snapshotOneAfter('s', 'turns', 3, rows.slice(3), 4)).toEqual(fullRead(rows, 4))
    replacement.commit()
    expect(registry.snapshotOneAfter('s', 'turns', 4, rows.slice(4), 5)).toBeUndefined()
    expect(registry.snapshotOne('s', 'turns', rows, 5)).toEqual(fullRead(rows, 5, replaced))
    replacement.restore()
    expect(registry.snapshotOneAfter('s', 'turns', 4, rows.slice(4), 5)).toEqual(fullRead(rows, 5))
  })
})

it('accepts projection methods on a prototype and preserves their receiver', () => {
  class Counter {
    key = 'prototype'
    stateVersion = 1
    #initial = 7
    init() {
      return this.#initial
    }
    apply(state: number) {
      return state
    }
    view(state: number) {
      return state + this.#initial
    }
  }
  const registry = new ProjectionRegistry()
  registry.register(new Counter(), { owner: 'acme/class' })
  expect(registry.snapshotOne('s', 'prototype', [])).toEqual({ state: 7, view: 14, stateVersion: 1 })
})

it('quarantines hostile thrown values without interrupting other owners or leaking diagnostics', () => {
  const registry = new ProjectionRegistry()
  registry.register(
    {
      ...counter(),
      key: 'bad',
      init: () => {
        throw {
          toString() {
            throw new Error('private secret')
          },
        }
      },
    },
    { owner: 'acme/bad' },
  )
  registry.register(counter(), { owner: 'acme/good' })
  expect(registry.snapshot('s', []).units).toEqual({
    bad: { error: 'unavailable' },
    turns: { state: { n: 0 }, view: 0, stateVersion: 1 },
  })
  expect(registry.failures()).toEqual([{ key: 'bad', seq: 0, message: 'unavailable' }])
})
