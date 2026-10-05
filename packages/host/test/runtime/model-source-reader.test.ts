import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  captureModelCatalog,
  type SelectedModelCatalog,
} from '../../src/runtime/model/model-catalog-capture.js'
import {
  createModelSourceReader,
  type IssuedPrepared,
  type ModelSourcePorts,
} from '../../src/runtime/model/model-source-reader.js'
import {
  fixtureCatalog,
  fixtureContext,
  fixtureFrame,
  fixturePorts,
  fixtureWire,
  preparedFixture,
  preparedRef,
  sessionWith,
} from './model-source-fixture.js'

const ok = <T>(value: T) => ({ ok: true as const, value })
const fetchSpy = vi.spyOn(globalThis, 'fetch')
afterEach(() => fetchSpy.mockClear())
const network = {
  get calls() {
    return fetchSpy.mock.calls.length
  },
}
function setup(over: Parameters<typeof fixturePorts>[0] = {}) {
  const epoch = { value: 1 }
  const controller = new AbortController()
  const { ports, ref } = fixturePorts({ authorize: { epoch: () => epoch.value }, ...over })
  return {
    reader: createModelSourceReader(ports),
    ports,
    ref,
    frame: fixtureFrame(ref),
    context: fixtureContext(controller.signal),
    network,
    epoch,
    abort: () => controller.abort(),
  }
}
type Setup = ReturnType<typeof setup>

// Same ports and reference with some ports replaced; the reader is recreated around them.
function rebuild(s: Setup, over: Partial<ModelSourcePorts>): Setup {
  return { ...s, ports: { ...s.ports, ...over }, reader: createModelSourceReader({ ...s.ports, ...over }) }
}
// What the default issuance port returns for this setup.
const issued = (s: Setup): IssuedPrepared => ({
  preparedDigest: s.ref.digest,
  actionId: 'act-1',
  captureDigest: fixtureCatalog().digest,
  wire: fixtureWire,
})
const emptyCatalog = (): SelectedModelCatalog =>
  captureModelCatalog({ routes: () => [], models: () => [], seal: () => {} })
const sessionWithSlots = sessionWith

describe('model source reader: load', () => {
  it('returns a source whose four parts agree, built from the retained capture and the issued wire identity', async () => {
    const { reader, ref, frame, context } = setup()
    const loaded = await reader.load(ref, frame, context)
    if (!loaded.ok) throw new Error(loaded.error.detailCode)
    expect(loaded.value.model.id).toBe('fixture-model')
    expect(loaded.value.route.models.map((m) => m.id)).toEqual(['fixture-model'])
    expect(loaded.value.request.derivedHash).toBe(loaded.value.prepared.inputDigest)
    expect(loaded.value.request).toMatchObject({ slot: 'primary', sessionKey: 'session-1', contractId: null })
  })

  it('loads when the same model sits behind several slots, using the slot the issuance recorded', async () => {
    const both = {
      primary: { route: 'fixed-route', model: 'fixture-model' },
      fast: { route: 'fixed-route', model: 'fixture-model' },
    }
    const wire = { ...fixtureWire, slot: 'fast' as const }
    const { reader, ref, frame, context } = setup({ slots: both, wire })
    const loaded = await reader.load(ref, frame, context)
    if (!loaded.ok) throw new Error(loaded.error.detailCode)
    expect(loaded.value.request.slot).toBe('fast')
  })

  it('judges the recorded slot alone, not whichever slot happens to come first', async () => {
    const slots = {
      primary: { route: 'other', model: 'other' },
      fast: { route: 'fixed-route', model: 'fixture-model' },
    }
    const wire = { ...fixtureWire, slot: 'fast' as const }
    const { reader, ref, frame, context } = setup({ slots, wire })
    expect((await reader.load(ref, frame, context)).ok).toBe(true)
  })

  it('accepts a slot whose fallbacks name the target', async () => {
    const slots = {
      primary: {
        route: 'other',
        model: 'other',
        fallbacks: [{ route: 'fixed-route', model: 'fixture-model' }],
      },
    }
    const { reader, ref, frame, context } = setup({ slots })
    expect((await reader.load(ref, frame, context)).ok).toBe(true)
  })

  it('keeps loading an old request from its retained capture after the current catalog changed', async () => {
    const original = fixtureCatalog(2)
    const changed = fixtureCatalog(9)
    const { reader, ref, frame, context } = setup({ retained: [original, changed] })
    const loaded = await reader.load(ref, frame, context)
    if (!loaded.ok) throw new Error(loaded.error.detailCode)
    expect(loaded.value.model.cost.output).toBe(2)
  })

  it.each([
    [
      'digest of the reference was altered',
      (s: Setup) => ({ ...s, ref: { ...s.ref, digest: 'd'.repeat(64) } }),
      'model_source_ref',
    ],
    [
      'reference is not the invoke input',
      (s: Setup) => ({
        ...s,
        frame: fixtureFrame(preparedRef(preparedFixture(undefined, { ...fixtureWire, sessionKey: 'x' }))),
      }),
      'model_source_frame',
    ],
    [
      'issuance names another action',
      (s: Setup) => rebuild(s, { issuance: { read: async () => ok({ ...issued(s), actionId: 'other' }) } }),
      'model_source_issuance',
    ],
    [
      'issuance has another digest',
      (s: Setup) =>
        rebuild(s, { issuance: { read: async () => ok({ ...issued(s), preparedDigest: 'e'.repeat(64) }) } }),
      'model_source_issuance',
    ],
    [
      'the retained capture is missing',
      (s: Setup) => rebuild(s, { captures: { read: () => undefined } }),
      'model_source_capture',
    ],
    [
      'the route is not in the retained capture',
      (s: Setup) => rebuild(s, { captures: { read: () => emptyCatalog() } }),
      'model_source_capture',
    ],
    [
      'price version differs',
      (s: Setup) => rebuild(s, { prices: { version: () => 'fixture-price-2' } }),
      'model_source_price',
    ],
    [
      'the retained capture was edited in place',
      (s: Setup) => rebuild(s, { captures: { read: () => fixtureCatalog(9) } }),
      'model_source_drift',
    ],
    [
      'the issued wire identity was edited',
      (s: Setup) =>
        rebuild(s, {
          issuance: {
            read: async () => ok({ ...issued(s), wire: { ...fixtureWire, sessionKey: 'forged' } }),
          },
        }),
      'model_source_drift',
    ],
    [
      'the adapter package changed',
      (s: Setup) => rebuild(s, { packageDigest: 'package-2' }),
      'model_source_drift',
    ],
    [
      'the recorded slot does not allow the target',
      (s: Setup) =>
        rebuild(s, { session: sessionWithSlots({ primary: { route: 'elsewhere', model: 'else' } }) }),
      'model_source_slot',
    ],
    [
      'the recorded slot is not configured',
      (s: Setup) => rebuild(s, { session: sessionWithSlots({}) }),
      'model_source_slot',
    ],
  ] as const)('refuses when %s, without reaching the network', async (_name, tweak, detail) => {
    const { reader, ref, frame, context, network } = tweak(setup())
    expect(await reader.load(ref, frame, context)).toMatchObject({ ok: false, error: { detailCode: detail } })
    expect(network.calls).toBe(0)
  })

  it('is not ready when there is no trusted price source', async () => {
    const { reader, ref, frame, context } = rebuild(setup(), { prices: { version: () => null } })
    expect(await reader.load(ref, frame, context)).toMatchObject({
      ok: false,
      error: { code: 'backend_unavailable', detailCode: 'model_source_not_ready' },
    })
  })

  it('meets every condition the adapter checks on a source, and sends nothing while loading', async () => {
    const s = setup()
    const loaded = await s.reader.load(s.ref, s.frame, s.context)
    if (!loaded.ok) throw new Error(loaded.error.detailCode)
    const source = loaded.value
    expect(source.prepared.target.model).toBe(source.model.id)
    expect(source.model.route).toBe(source.route.route)
    expect(source.request.derivedHash).toBe(source.prepared.inputDigest)
    expect(source.request.route).toBe(source.route.route)
    expect(source.request.model).toBe(source.prepared.target.model)
    expect(
      source.route.models.some(
        (m) => canonicalJsonDigest(m as never) === canonicalJsonDigest(source.model as never),
      ),
    ).toBe(true)
    expect(source.request.sampling?.maxTokens).toBe(source.prepared.generation.maxOutputTokens)
    expect(source.request.sampling?.thinking ?? null).toBe(source.prepared.generation.thinking)
    expect(source.prepared.mediaPlans).toHaveLength(0)
    expect(s.network.calls).toBe(0)
  })
})

describe('model source reader: current', () => {
  it('is true right after load and false once authorization moves, the source is not the loaded one, or the call aborts', async () => {
    const s = setup()
    const loaded = await s.reader.load(s.ref, s.frame, s.context)
    if (!loaded.ok) throw new Error(loaded.error.detailCode)
    expect(s.reader.current(loaded.value, s.frame, s.context.call)).toBe(true)
    s.epoch.value++
    expect(s.reader.current(loaded.value, s.frame, s.context.call)).toBe(false)
    s.epoch.value--
    expect(s.reader.current({ ...loaded.value }, s.frame, s.context.call)).toBe(false)
    s.abort()
    expect(s.reader.current(loaded.value, s.frame, s.context.call)).toBe(false)
  })
})
