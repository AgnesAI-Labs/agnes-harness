import { describe, expect, it } from 'vitest'
import { type ProjectionDef, ProjectionRegistry } from '../src/project/named.js'
import type { Event } from '../src/types.js'

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
