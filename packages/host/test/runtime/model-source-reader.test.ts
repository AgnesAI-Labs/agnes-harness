import { createPreparedRegistry, type PreparedEntry } from '@agnes/core'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createModelSourceReader,
  type ModelSourcePorts,
} from '../../src/runtime/model/model-source-reader.js'
import {
  assembledFixture,
  fixtureCatalog,
  fixtureContext,
  fixtureFrame,
  fixturePorts,
  fixtureWire,
  sessionWith,
} from './model-source-fixture.js'

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
  const { ports, ref, entry } = fixturePorts({ authorize: { epoch: () => epoch.value }, ...over })
  return {
    reader: createModelSourceReader(ports),
    ports,
    ref,
    entry,
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
const sessionWithSlots = sessionWith

// A registry that answers every handle with the given entry, as a replaced or edited entry would.
const answering = (entry: PreparedEntry): ModelSourcePorts['registry'] => ({ get: () => entry })

describe('model source reader: load', () => {
  it('returns a source whose parts agree, built from the registry entry and its recorded wire identity', async () => {
    const { reader, ref, frame, context } = setup()
    const loaded = await reader.load(ref, frame, context)
    if (!loaded.ok) throw new Error(loaded.error.detailCode)
    expect(loaded.value.model.id).toBe('fixture-model')
    expect(loaded.value.route.models.map((m) => m.id)).toEqual(['fixture-model'])
    expect(loaded.value.request.derivedHash).toBe(loaded.value.prepared.inputDigest)
    expect(loaded.value.request).toMatchObject({ slot: 'primary', sessionKey: 'session-1', contractId: null })
  })

  it('loads when the same model sits behind several slots, using the slot recorded at prepare', async () => {
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

  it('serves the request recorded at prepare time, whatever catalog was captured afterwards', async () => {
    const { reader, ref, frame, context } = setup({ catalog: fixtureCatalog(2) })
    fixtureCatalog(9)
    const loaded = await reader.load(ref, frame, context)
    if (!loaded.ok) throw new Error(loaded.error.detailCode)
    expect(loaded.value.model.cost.output).toBe(2)
  })

  it('names a registry miss and neither prepares again nor reaches the network', async () => {
    const s = rebuild(setup(), { registry: createPreparedRegistry() })
    expect(await s.reader.load(s.ref, s.frame, s.context)).toMatchObject({
      ok: false,
      error: { code: 'incompatible', detailCode: 'model_prepared_lost' },
    })
    expect(s.network.calls).toBe(0)
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
        frame: fixtureFrame(assembledFixture(undefined, { ...fixtureWire, sessionKey: 'x' }).ref),
      }),
      'model_source_frame',
    ],
    [
      'the frame belongs to another run',
      (s: Setup) => ({ ...s, frame: { ...s.frame, runId: 'run-2' } }),
      'model_source_frame',
    ],
    [
      'the call belongs to another session',
      (s: Setup) => ({ ...s, context: fixtureContext(new AbortController().signal, 'session-2') }),
      'model_source_frame',
    ],
    [
      'the entry header differs from the handle',
      (s: Setup) =>
        rebuild(s, {
          registry: answering({
            ...s.entry,
            header: { ...s.entry.header, maxOutputTokens: s.entry.header.maxOutputTokens + 1 },
          }),
        }),
      'model_source_drift',
    ],
    [
      'the entry belongs to another owner',
      (s: Setup) =>
        rebuild(s, {
          registry: answering({ ...s.entry, ownerBinding: { ...s.entry.ownerBinding, bindingId: 'other' } }),
        }),
      'model_source_drift',
    ],
    [
      'the prepared request in the entry was edited',
      (s: Setup) =>
        rebuild(s, {
          registry: answering({
            ...s.entry,
            prepared: { ...s.entry.prepared, generation: { maxOutputTokens: 99, thinking: null } },
          }),
        }),
      'model_source_drift',
    ],
    [
      'the captured catalog in the entry was edited',
      (s: Setup) => {
        const capture = {
          ...s.entry.capture,
          model: { ...s.entry.capture.model, cost: { ...s.entry.capture.model.cost, output: 9 } },
        }
        return rebuild(s, { registry: answering({ ...s.entry, capture }) })
      },
      'model_source_drift',
    ],
    [
      'the wire identity in the entry was edited',
      (s: Setup) =>
        rebuild(s, {
          registry: answering({ ...s.entry, wire: { ...s.entry.wire, sessionKey: 'forged' } }),
        }),
      'model_source_drift',
    ],
    [
      'price version differs',
      (s: Setup) => rebuild(s, { prices: { version: () => 'fixture-price-2' } }),
      'model_source_price',
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
      error: { code: 'internal', detailCode: 'model_source_not_ready' },
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
