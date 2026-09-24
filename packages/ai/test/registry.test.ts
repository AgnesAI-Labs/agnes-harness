import type { ModelRecord, RouteDecl } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { AiSetupError, buildRegistry } from '../src/index.js'
import { FakeAdapter, fakeModel } from '../testkit/fake-adapter.js'

const decl = (route: string): RouteDecl => ({
  route,
  api: 'openai-completions',
  baseUrl: `https://${route}.invalid`,
})

// The fingerprint refuses to answer before the registry is sealed, so every digest case seals the
// registry it just built — assembly does the same, in createProvider.
const sealed = (adapters: FakeAdapter[]) => {
  const reg = buildRegistry(adapters)
  reg.seal()
  return reg
}

describe('registry', () => {
  it('maps routes to adapters and projects models', () => {
    const a = new FakeAdapter({
      id: 'a',
      routes: [decl('r1')],
      models: { r1: [fakeModel({ id: 'm1', route: 'r1' })] },
    })
    const b = new FakeAdapter({
      id: 'b',
      routes: [decl('r2')],
      models: { r2: [fakeModel({ id: 'm2', route: 'r2' })] },
    })
    const reg = buildRegistry([a, b])
    expect(reg.lookup('r2')?.adapter.id).toBe('b')
    expect(reg.lookup('r2')?.decl).toEqual(decl('r2'))
    expect(reg.lookup('nope')).toBeUndefined()
    expect(reg.models().map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(reg.routes().map((r) => r.route)).toEqual(['r1', 'r2'])
  })

  // Ordering is by route name, not by the order adapters were handed in, so two assemblies that
  // list the same adapters differently project the same tables.
  it('projects routes and models in route order regardless of adapter order', () => {
    const a = new FakeAdapter({
      id: 'a',
      routes: [decl('zeta')],
      models: { zeta: [fakeModel({ id: 'mz', route: 'zeta' })] },
    })
    const b = new FakeAdapter({
      id: 'b',
      routes: [decl('alpha')],
      models: { alpha: [fakeModel({ id: 'ma', route: 'alpha' })] },
    })
    expect(
      buildRegistry([a, b])
        .routes()
        .map((r) => r.route),
    ).toEqual(['alpha', 'zeta'])
    expect(
      buildRegistry([b, a])
        .routes()
        .map((r) => r.route),
    ).toEqual(['alpha', 'zeta'])
    expect(
      buildRegistry([a, b])
        .models()
        .map((m) => m.id),
    ).toEqual(['ma', 'mz'])
  })

  it('rejects the whole batch on a duplicate route', () => {
    const a = new FakeAdapter({ id: 'a', routes: [decl('r1')], models: {} })
    const b = new FakeAdapter({ id: 'b', routes: [decl('r1')], models: {} })
    let caught: unknown
    try {
      buildRegistry([a, b])
    } catch (e) {
      caught = e
    }
    // Assert on the specific rejection: a generic "it threw" would also pass on a TypeError from a
    // typo, which is the failure this case is meant to distinguish from a real duplicate check.
    expect(caught).toBeInstanceOf(AiSetupError)
    expect((caught as AiSetupError).code).toBe('DUPLICATE_ROUTE')
    expect((caught as AiSetupError).detail).toEqual({ route: 'r1', adapters: ['a', 'b'] })
  })

  // All-or-nothing: a batch whose second adapter collides must not leave the first adapter's other
  // routes usable. There is no partially-built registry to hand back, so nothing is returned at all.
  it('does not half-build: a later collision discards the routes already accepted', () => {
    const a = new FakeAdapter({ id: 'a', routes: [decl('ok1'), decl('dup')], models: {} })
    const b = new FakeAdapter({ id: 'b', routes: [decl('dup')], models: {} })
    expect(() => buildRegistry([a, b])).toThrowError(AiSetupError)
    // the same two adapters minus the collision build fine, so the rejection is about the duplicate
    // and not about either adapter being malformed
    const clean = new FakeAdapter({ id: 'b', routes: [decl('ok2')], models: {} })
    expect(
      buildRegistry([new FakeAdapter({ id: 'a', routes: [decl('ok1')], models: {} }), clean])
        .routes()
        .map((r) => r.route),
    ).toEqual(['ok1', 'ok2'])
  })

  it('reports a duplicate inside a single adapter against itself', () => {
    const a = new FakeAdapter({ id: 'a', routes: [decl('r1'), decl('r1')], models: {} })
    try {
      buildRegistry([a])
      expect.fail('a route declared twice by one adapter must be rejected too')
    } catch (e) {
      expect((e as AiSetupError).detail).toEqual({ route: 'r1', adapters: ['a', 'a'] })
    }
  })

  it('fingerprint is stable and order-independent', () => {
    const a = new FakeAdapter({
      id: 'a',
      routes: [decl('r1')],
      models: { r1: [fakeModel({ id: 'm1', route: 'r1' })] },
    })
    const b = new FakeAdapter({
      id: 'b',
      routes: [decl('r2')],
      models: { r2: [fakeModel({ id: 'm2', route: 'r2' })] },
    })
    expect(sealed([a, b]).fingerprint()).toBe(sealed([b, a]).fingerprint())
    expect(sealed([a]).fingerprint()).not.toBe(sealed([a, b]).fingerprint())
    expect(sealed([a]).fingerprint()).toMatch(/^[0-9a-f]{64}$/)
  })

  // The fingerprint feeds the hash a host records for a session, so it has to move when any part of
  // what was resolved moves — not just when the set of route names does.
  it('fingerprint changes when a model id, an api or a baseUrl changes', () => {
    const base = () =>
      new FakeAdapter({
        id: 'a',
        routes: [decl('r1')],
        models: { r1: [fakeModel({ id: 'm1', route: 'r1' })] },
      })
    const original = sealed([base()]).fingerprint()
    const otherModel = new FakeAdapter({
      id: 'a',
      routes: [decl('r1')],
      models: { r1: [fakeModel({ id: 'm2', route: 'r1' })] },
    })
    const otherApi = new FakeAdapter({
      id: 'a',
      routes: [{ ...decl('r1'), api: 'anthropic-messages' }],
      models: { r1: [fakeModel({ id: 'm1', route: 'r1' })] },
    })
    const otherBaseUrl = new FakeAdapter({
      id: 'a',
      routes: [{ ...decl('r1'), baseUrl: 'https://elsewhere.invalid' }],
      models: { r1: [fakeModel({ id: 'm1', route: 'r1' })] },
    })
    expect(sealed([otherModel]).fingerprint()).not.toBe(original)
    expect(sealed([otherApi]).fingerprint()).not.toBe(original)
    expect(sealed([otherBaseUrl]).fingerprint()).not.toBe(original)
  })

  // Two models whose ids differ only in order must hash the same; two genuinely different catalogues
  // must not. Without sorting the id list the first pair would differ; without hashing the ids at all
  // the second pair would collide.
  it('fingerprint sorts model ids within a route but still distinguishes different catalogues', () => {
    const withIds = (ids: string[]) =>
      new FakeAdapter({
        id: 'a',
        routes: [decl('r1')],
        models: { r1: ids.map((id) => fakeModel({ id, route: 'r1' })) },
      })
    expect(sealed([withIds(['m1', 'm2'])]).fingerprint()).toBe(sealed([withIds(['m2', 'm1'])]).fingerprint())
    expect(sealed([withIds(['m1', 'm2'])]).fingerprint()).not.toBe(
      sealed([withIds(['m1', 'm3'])]).fingerprint(),
    )
  })

  // The route table is resolved once. An adapter that grows a route afterwards is not picked up,
  // which is what "read-only after assembly" means in practice.
  it('the route table is fixed at build time, not re-read per lookup', () => {
    const routes = [decl('r1')]
    const a = new FakeAdapter({ id: 'a', routes, models: {} })
    const reg = buildRegistry([a])
    routes.push(decl('r2'))
    expect(reg.lookup('r2')).toBeUndefined()
    expect(reg.routes().map((r) => r.route)).toEqual(['r1'])
  })

  // Every other fingerprint case compares one digest to another, which pins the hashed field set
  // only from below: dropping a field is caught, but *adding* one is not, and a widened input would
  // silently change every resolved_profile_hash a host has already recorded. This case pins the
  // digest itself. If it fails, the hashed shape or the canonical form changed: confirm the change
  // was intended and that recorded hashes may move, then update the constant.
  it('fingerprint of a fixed assembly matches its recorded value', () => {
    const a = new FakeAdapter({
      id: 'a',
      routes: [{ route: 'r1', api: 'openai-completions', baseUrl: 'https://r1.invalid' }],
      models: { r1: [fakeModel({ id: 'm2', route: 'r1' }), fakeModel({ id: 'm1', route: 'r1' })] },
    })
    const b = new FakeAdapter({
      id: 'b',
      routes: [
        {
          route: 'r2',
          api: 'anthropic-messages',
          baseUrl: 'https://r2.invalid',
          credentialRef: 'secret://agnes/r2',
        },
      ],
      models: { r2: [fakeModel({ id: 'm3', route: 'r2' })] },
    })
    expect(sealed([a, b]).fingerprint()).toBe(
      'eb89eae34a553eceb6c32b154fc6aa3b15d975a262ca1c1f523dc195605a5386',
    )
  })

  // Before the seal, model catalogues are read live: a catalogue route is empty until its adapter
  // has refreshed it, and assembly has to see the result of that refresh.
  it('reads model catalogues live until the registry is sealed', () => {
    const models: Record<string, ReturnType<typeof fakeModel>[]> = { r1: [] }
    const a = new FakeAdapter({ id: 'a', routes: [decl('r1')], models })
    const reg = buildRegistry([a])
    expect(reg.models()).toEqual([])
    models.r1 = [fakeModel({ id: 'later', route: 'r1' })]
    expect(reg.models().map((m) => m.id)).toEqual(['later'])
  })
})

// A host records the fingerprint as the identity of an assembled session. Reading catalogues live
// would make that identity depend on the moment it was read — a refresh landing a millisecond
// later would change it — and "read it after the last refresh" is an obligation on a caller in
// another package that nothing here could check. The seal moves the guarantee inside: assembly
// takes one snapshot, and every later read answers from it.
describe('sealing', () => {
  const withModels = (ids: string[], models: Record<string, ReturnType<typeof fakeModel>[]>) => {
    models.r1 = ids.map((id) => fakeModel({ id, route: 'r1' }))
    return new FakeAdapter({ id: 'a', routes: [decl('r1')], models })
  }

  it('refuses to fingerprint a registry that has not been sealed', () => {
    const reg = buildRegistry([new FakeAdapter({ id: 'a', routes: [decl('r1')], models: {} })])
    let caught: unknown
    try {
      reg.fingerprint()
    } catch (e) {
      caught = e
    }
    // Assert on which check fired: a bare "it threw" would also pass on a TypeError from reading a
    // snapshot field that is not there yet, which is the mistake this case exists to distinguish.
    expect(caught).toBeInstanceOf(AiSetupError)
    expect((caught as AiSetupError).code).toBe('UNSEALED')
  })

  it('freezes catalogues at the seal, so a later refresh moves neither models() nor the fingerprint', () => {
    const models: Record<string, ReturnType<typeof fakeModel>[]> = {}
    const reg = buildRegistry([withModels(['m1'], models)])
    reg.seal()
    const before = reg.fingerprint()
    models.r1 = [fakeModel({ id: 'm1', route: 'r1' }), fakeModel({ id: 'later', route: 'r1' })]
    expect(reg.models().map((m) => m.id)).toEqual(['m1'])
    expect(reg.fingerprint()).toBe(before)
  })

  // The digest a host has already written down must stay readable, so a second seal keeps the first
  // snapshot rather than quietly recording a newer one under the same name.
  it('keeps the first snapshot when sealed again', () => {
    const models: Record<string, ReturnType<typeof fakeModel>[]> = {}
    const reg = buildRegistry([withModels(['m1'], models)])
    reg.seal()
    const before = reg.fingerprint()
    models.r1 = [fakeModel({ id: 'm1', route: 'r1' }), fakeModel({ id: 'later', route: 'r1' })]
    reg.seal()
    expect(reg.fingerprint()).toBe(before)
    expect(reg.models().map((m) => m.id)).toEqual(['m1'])
  })

  // The snapshot is a copy, not a view: a caller that mutates what models() handed back must not be
  // able to change what the next reader sees.
  it('hands out a catalogue the caller cannot mutate through', () => {
    const models: Record<string, ReturnType<typeof fakeModel>[]> = {}
    const reg = buildRegistry([withModels(['m1'], models)])
    reg.seal()
    reg.models().push(fakeModel({ id: 'injected', route: 'r1' }))
    expect(reg.models().map((m) => m.id)).toEqual(['m1'])
    reg.routes().push(decl('injected'))
    expect(reg.routes().map((r) => r.route)).toEqual(['r1'])
  })

  // The arrays are copies, and so are the records inside them: a caller that writes to a record it
  // received must not be able to change what the next reader sees, because the fingerprint was
  // computed from that same reading and would not move with it. They are frozen rather than merely
  // copied so that the attempt fails loudly instead of silently having no effect.
  it('hands out records the caller cannot mutate through', () => {
    const models: Record<string, ReturnType<typeof fakeModel>[]> = {}
    const reg = buildRegistry([withModels(['m1'], models)])
    reg.seal()
    const record = reg.models()[0] as ModelRecord
    expect(() => {
      record.id = 'HIJACKED'
    }).toThrow(TypeError)
    expect(() => {
      record.cost.input = 99
    }).toThrow(TypeError)
    expect(() => {
      ;(reg.routes()[0] as RouteDecl).baseUrl = 'https://elsewhere.invalid'
    }).toThrow(TypeError)
    expect(reg.models().map((m) => m.id)).toEqual(['m1'])
    expect(reg.routes().map((r) => r.baseUrl)).toEqual(['https://r1.invalid'])
  })

  // A catalogue that was empty at the seal stays empty: an adapter that never refreshed did not
  // contribute models to the assembly, and the fingerprint says so.
  it('records an empty catalogue as empty rather than filling it in later', () => {
    const models: Record<string, ReturnType<typeof fakeModel>[]> = { r1: [] }
    const reg = buildRegistry([new FakeAdapter({ id: 'a', routes: [decl('r1')], models })])
    reg.seal()
    const empty = reg.fingerprint()
    models.r1 = [fakeModel({ id: 'later', route: 'r1' })]
    expect(reg.fingerprint()).toBe(empty)
    const refreshedFirst = buildRegistry([new FakeAdapter({ id: 'a', routes: [decl('r1')], models })])
    refreshedFirst.seal()
    expect(refreshedFirst.fingerprint()).not.toBe(empty)
  })
})
