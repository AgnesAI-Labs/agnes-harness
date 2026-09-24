import type { ModelRecord, RouteTable } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { buildRegistry } from '../src/index.js'
import { resolveSlot, SlotUnresolved } from '../src/route.js'
import { FakeAdapter, fakeModel } from '../testkit/fake-adapter.js'

const registry = buildRegistry([
  new FakeAdapter({
    id: 'a',
    routes: [{ route: 'gw', api: 'openai-completions', baseUrl: 'https://gw.invalid' }],
    models: { gw: [fakeModel({ id: 'flash', route: 'gw' }), fakeModel({ id: 'pro', route: 'gw' })] },
  }),
])

describe('resolveSlot', () => {
  it('resolves the head model and every fallback to a record', () => {
    const table: RouteTable = {
      primary: { route: 'gw', model: 'flash', fallbacks: [{ route: 'gw', model: 'pro' }] },
    }
    const r = resolveSlot(table, registry, 'primary')
    expect(r.route).toBe('gw')
    expect(r.model.id).toBe('flash')
    expect(r.fallbacks.map((f) => f.model.id)).toEqual(['pro'])
  })

  it('reports a slot the table does not fill as NO_MODEL naming the slot', () => {
    let caught: unknown
    try {
      resolveSlot({ primary: { route: 'gw', model: 'flash' } }, registry, 'escalation')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SlotUnresolved)
    expect((caught as SlotUnresolved).code).toBe('NO_MODEL')
    expect((caught as SlotUnresolved).detail).toBe('slot=escalation')
  })

  it('separates an unregistered route from an unserved model', () => {
    const table: RouteTable = {
      primary: { route: 'gw', model: 'flash' },
      fast: { route: 'nope', model: 'flash' },
      verifier: { route: 'gw', model: 'ghost' },
    }
    try {
      resolveSlot(table, registry, 'fast')
      expect.fail('a slot naming an unregistered route must not resolve')
    } catch (e) {
      expect((e as SlotUnresolved).code).toBe('NO_ADAPTER')
      expect((e as SlotUnresolved).detail).toBe('slot=fast route=nope')
    }
    try {
      resolveSlot(table, registry, 'verifier')
      expect.fail('a slot naming a model the route does not serve must not resolve')
    } catch (e) {
      expect((e as SlotUnresolved).code).toBe('NO_MODEL')
      expect((e as SlotUnresolved).detail).toBe('slot=verifier route=gw model=ghost')
    }
  })

  // A fallback is resolved with the head, so a table naming a model that does not exist is a
  // configuration mistake found on the first request rather than on the first failure.
  it('rejects the whole slot when a fallback names a model that does not exist', () => {
    const table: RouteTable = {
      primary: { route: 'gw', model: 'flash', fallbacks: [{ route: 'gw', model: 'ghost' }] },
    }
    expect(() => resolveSlot(table, registry, 'primary')).toThrowError(SlotUnresolved)
  })
})

// The sealed fingerprint is the identity a host records for an assembled session. Resolution has to
// answer from the same reading that digest was computed from: a model that entered a catalogue after
// the seal is not covered by the recorded identity, so serving a turn with it would make the
// fingerprint stop describing what actually answered.
describe('resolveSlot against a sealed registry', () => {
  const build = () => {
    const models: Record<string, ReturnType<typeof fakeModel>[]> = {
      gw: [fakeModel({ id: 'flash', route: 'gw' })],
    }
    const reg = buildRegistry([
      new FakeAdapter({
        id: 'a',
        routes: [{ route: 'gw', api: 'openai-completions', baseUrl: 'https://gw.invalid' }],
        models,
      }),
    ])
    return { reg, models }
  }

  it('refuses a model the adapter gained after the seal', () => {
    const { reg, models } = build()
    reg.seal()
    const before = reg.fingerprint()
    models.gw = [fakeModel({ id: 'flash', route: 'gw' }), fakeModel({ id: 'ghost', route: 'gw' })]
    expect(reg.models().map((m) => m.id)).toEqual(['flash'])
    expect(reg.fingerprint()).toBe(before)
    let caught: unknown
    try {
      resolveSlot({ primary: { route: 'gw', model: 'ghost' } }, reg, 'primary')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SlotUnresolved)
    expect((caught as SlotUnresolved).code).toBe('NO_MODEL')
    expect((caught as SlotUnresolved).detail).toBe('slot=primary route=gw model=ghost')
  })

  // A record is matched on its own `route` field, so one registered under `gw` while carrying
  // `route: 'other'` is in the catalogue and unreachable through it. The behaviour is deliberate —
  // the projection the fingerprint covers is the one that must answer — but the failure has to name
  // the cause, or the reader goes looking for a model that is plainly there. Whoever builds the
  // catalogue owes the agreement between the two.
  it('says so when a record is filed under a route its own field disagrees with', () => {
    const models: Record<string, ModelRecord[]> = {
      gw: [{ ...fakeModel({ id: 'flash', route: 'gw' }), route: 'other' }],
    }
    const reg = buildRegistry([
      new FakeAdapter({
        id: 'a',
        routes: [{ route: 'gw', api: 'openai-completions', baseUrl: 'https://gw.invalid' }],
        models,
      }),
    ])
    reg.seal()
    let caught: unknown
    try {
      resolveSlot({ primary: { route: 'gw', model: 'flash' } }, reg, 'primary')
    } catch (e) {
      caught = e
    }
    expect((caught as SlotUnresolved).code).toBe('NO_MODEL')
    expect((caught as SlotUnresolved).detail).toBe(
      'slot=primary route=gw model=flash (present in the catalogue under a different record.route)',
    )
  })

  // Before the seal there is nothing to bypass, and assembly still has to see a refreshed catalogue.
  it('still reads a catalogue live before the seal', () => {
    const { reg, models } = build()
    models.gw = [fakeModel({ id: 'flash', route: 'gw' }), fakeModel({ id: 'ghost', route: 'gw' })]
    expect(resolveSlot({ primary: { route: 'gw', model: 'ghost' } }, reg, 'primary').model.id).toBe('ghost')
  })
})
