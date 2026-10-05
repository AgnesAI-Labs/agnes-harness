import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeModel } from '@agnes/ai/testkit'
import {
  assemblePrepared,
  createPreparedRegistry,
  type PreparedEntry,
  type PreparedRegistry,
} from '@agnes/core'
import type { ThinkingLevel } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest, type DataRef } from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureModelCatalog } from '../../src/runtime/model/model-catalog-capture.js'
import { createModelSourceReader } from '../../src/runtime/model/model-source-reader.js'
import { openModelSourceStore } from '../../src/runtime/model/model-source-store.js'
import { revision } from './model-selection-fixture.js'
import {
  fixtureContext,
  fixtureFrame,
  fixtureIds,
  fixtureWire,
  preparedFixture,
} from './model-source-fixture.js'
import { actionContext, BODY_DIGEST, frameFor, registryOf, resultFor } from './model-source-store-fixture.js'

// The tests here pin what a changed session selection does to a request that is already prepared,
// inside one process, and what a restart does instead. The selection itself is read elsewhere; these
// use the real reader, the real registry, the real input digest and the real send-fence store.

const fetchSpy = vi.spyOn(globalThis, 'fetch')
const cleanup: Array<() => void> = []
afterEach(() => {
  fetchSpy.mockClear()
  while (cleanup.length > 0) cleanup.pop()?.()
})

const ROUTE = 'fixed-route'
const MODEL_A = 'fixture-model'
const MODEL_B = 'fixture-model-b'
const catalog = () =>
  captureModelCatalog({
    routes: () => [{ route: ROUTE, api: 'openai-completions', baseUrl: 'https://fake.invalid' } as never],
    models: () => [
      fakeModel({ id: MODEL_A, route: ROUTE }),
      fakeModel({ id: MODEL_B, route: ROUTE, reasoning: true }),
    ],
    seal: () => {},
  })
const schema = preparedFixture().sessionParameterRef.schema
const refOf = (n: number): Wire.DomainReference => ({
  authorityId: 'fixture-config',
  recordId: 'parameters',
  recordRevision: n,
  schema,
  digest: canonicalJsonDigest({ revision: n }),
})

type Choice = { revision: number; model: string; thinking?: ThinkingLevel }
/** What a prepare under the given revision and selection produces: handle reference and registry entry. */
function prepareUnder(choice: Choice, ids: { runId: string; sessionId: string } = fixtureIds) {
  const base = preparedFixture()
  const picked = catalog().select(ROUTE, choice.model)
  if (!picked) throw new Error('unknown fixture model')
  const assembled = assemblePrepared({
    ...ids,
    owner: base.ownerBinding,
    request: {
      view: base.view,
      route: { ...base.target, model: choice.model },
      outputSchema: null,
      toolCatalog: null,
      generation: { maxOutputTokens: 32, thinking: choice.thinking ?? null },
      sessionParameterRef: refOf(choice.revision),
      credentialRef: base.credentialRef,
    },
    capture: {
      adapterPackageDigest: 'package-1',
      route: { route: ROUTE, api: 'openai-completions', baseUrl: 'https://fake.invalid' },
      model: picked.model,
    },
    wire: fixtureWire,
    estimatedUnits: [],
  })
  if (!assembled.ok) throw new Error(assembled.error.detailCode)
  return assembled.value
}

/** Session parameter revisions by record revision; every question put to the port is recorded. */
function world(revisions: Record<number, string>, registry: PreparedRegistry = createPreparedRegistry()) {
  const asked: number[] = []
  const epoch = { value: 1 }
  const reader = createModelSourceReader({
    packageDigest: 'package-1',
    registry,
    prices: { version: (target) => target.priceVersion },
    session: {
      async parameters(ref) {
        asked.push(ref.recordRevision)
        const model = revisions[ref.recordRevision]
        if (model === undefined)
          return { ok: false, error: { code: 'not_found', detailCode: 'revision_missing' } as never }
        return {
          ok: true,
          value: revision(ref.recordRevision, { primary: { route: ROUTE, model } }),
        }
      },
    },
    authorize: { epoch: () => epoch.value },
  })
  return { reader, registry, asked, epoch }
}
const load = (w: ReturnType<typeof world>, ref: DataRef, signal?: AbortSignal) =>
  w.reader.load(ref, fixtureFrame(ref), fixtureContext(signal))
const detail = (out: Awaited<ReturnType<typeof load>>) => (out.ok ? null : out.error.detailCode)

describe('a request prepared under revision 1 inside one process', () => {
  const both = { 1: MODEL_A, 2: MODEL_B }

  it('loads byte for byte the same after the session switches to revision 2, asking for its own revision', async () => {
    const w = world(both)
    const old = prepareUnder({ revision: 1, model: MODEL_A })
    w.registry.put(old.handleId, old.entry)
    const before = await load(w, old.ref)
    if (!before.ok) throw new Error(before.error.detailCode)
    const bytes = JSON.stringify(before.value.request)
    // The session now selects model B and a request is prepared under it.
    const next = prepareUnder({ revision: 2, model: MODEL_B })
    w.registry.put(next.handleId, next.entry)
    w.asked.length = 0
    const after = await load(w, old.ref)
    if (!after.ok) throw new Error(after.error.detailCode)
    expect(JSON.stringify(after.value.request)).toBe(bytes)
    expect(after.value.request.derivedHash).toBe(old.prepared.inputDigest)
    expect(after.value.model.id).toBe(MODEL_A)
    expect(w.asked).toEqual([1])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('loads the new model for a request prepared under revision 2', async () => {
    const w = world(both)
    const next = prepareUnder({ revision: 2, model: MODEL_B })
    w.registry.put(next.handleId, next.entry)
    const loaded = await load(w, next.ref)
    if (!loaded.ok) throw new Error(loaded.error.detailCode)
    expect(loaded.value.model.id).toBe(MODEL_B)
    expect(w.asked).toEqual([2])
  })

  it('refuses a request whose recorded revision was swapped for revision 2 without recomputing its digest', async () => {
    const w = world(both)
    const old = prepareUnder({ revision: 1, model: MODEL_A })
    const swapped: PreparedEntry = {
      ...old.entry,
      prepared: { ...old.entry.prepared, sessionParameterRef: refOf(2) },
    }
    w.registry.put(old.handleId, swapped)
    expect(detail(await load(w, old.ref))).toBe('model_source_drift')
  })

  it('refuses an entry whose header differs from the handle header, in any one field', async () => {
    const old = prepareUnder({ revision: 1, model: MODEL_A })
    for (const patch of [{ model: MODEL_B }, { catalogRevision: 99 }, { priceVersion: 'other' }]) {
      const w = world(both)
      w.registry.put(old.handleId, {
        ...old.entry,
        header: { ...old.entry.header, ...patch } as PreparedEntry['header'],
      })
      expect(detail(await load(w, old.ref))).toBe('model_source_drift')
    }
  })

  it('refuses a registry entry recorded for another run or session than the handle names', async () => {
    const old = prepareUnder({ revision: 1, model: MODEL_A })
    for (const patch of [{ runId: 'run-2' }, { sessionId: 'session-2' }]) {
      const w = world(both)
      w.registry.put(old.handleId, { ...old.entry, ...patch })
      expect(detail(await load(w, old.ref))).toBe('model_source_drift')
    }
  })

  it('refuses when the request’s own revision no longer allows the slot, and does not look at a newer one', async () => {
    const w = world({ 1: MODEL_B, 2: MODEL_A })
    const old = prepareUnder({ revision: 1, model: MODEL_A })
    w.registry.put(old.handleId, old.entry)
    expect(detail(await load(w, old.ref))).toBe('model_source_slot')
    expect(w.asked).toEqual([1])
  })

  it('is no longer current once the authority epoch moves, and sends nothing while loading', async () => {
    const w = world(both)
    const old = prepareUnder({ revision: 1, model: MODEL_A })
    w.registry.put(old.handleId, old.entry)
    const frame = fixtureFrame(old.ref)
    const context = fixtureContext()
    const loaded = await w.reader.load(old.ref, frame, context)
    if (!loaded.ok) throw new Error(loaded.error.detailCode)
    expect(w.reader.current(loaded.value, frame, context.call)).toBe(true)
    w.epoch.value = 2
    expect(w.reader.current(loaded.value, frame, context.call)).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('gives four different input digests for a different revision, model or thinking level', () => {
    const digests = [
      prepareUnder({ revision: 1, model: MODEL_A }),
      prepareUnder({ revision: 2, model: MODEL_A }),
      prepareUnder({ revision: 1, model: MODEL_B }),
      prepareUnder({ revision: 1, model: MODEL_B, thinking: 'high' }),
    ].map((prepared) => prepared.prepared.inputDigest)
    expect(new Set(digests).size).toBe(4)
  })

  it('never serves the handle of another run or session', async () => {
    const w = world(both)
    const old = prepareUnder({ revision: 1, model: MODEL_A })
    w.registry.put(old.handleId, old.entry)
    const otherRun = { ...fixtureFrame(old.ref), runId: 'run-2' }
    expect(detail(await w.reader.load(old.ref, otherRun, fixtureContext()))).toBe('model_source_frame')
    expect(
      detail(await w.reader.load(old.ref, fixtureFrame(old.ref), fixtureContext(undefined, 'session-2'))),
    ).toBe('model_source_frame')
    expect(w.asked).toEqual([])
  })
})

describe('after a restart', () => {
  const both = { 1: MODEL_A, 2: MODEL_B }

  it('finds nothing in the empty registry, does not prepare again and asks for no revision', async () => {
    const w = world(both)
    const old = prepareUnder({ revision: 1, model: MODEL_A })
    const put = vi.spyOn(w.registry, 'put')
    expect(await load(w, old.ref)).toMatchObject({
      ok: false,
      error: { code: 'incompatible', detailCode: 'model_prepared_lost' },
    })
    expect(put).not.toHaveBeenCalled()
    expect(w.asked).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  function storeFor(frame: ReturnType<typeof frameFor>) {
    const directory = mkdtempSync(join(tmpdir(), 'model-selection-'))
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    const store = openModelSourceStore({
      path: join(directory, 'model-source.sqlite'),
      calls: registryOf(frame),
      soleSendFence: true,
    })
    cleanup.push(() => store.close())
    return store
  }

  it('lets the send store decide: a fenced attempt is unknown or resolved, an unrecorded one is not found', async () => {
    const lost = frameFor('1')
    const unrecorded = storeFor(lost)
    expect(await unrecorded.deployment.lookup(lost, [], actionContext(), null)).toMatchObject({
      kind: 'not_found',
      safeToRetry: false,
    })
    const sent = storeFor(lost)
    expect(sent.fence(lost, BODY_DIGEST)).toBe(true)
    expect(await sent.deployment.lookup(lost, [], actionContext(), null)).toMatchObject({ kind: 'unknown' })
    await sent.deployment.save(lost, resultFor(lost), BODY_DIGEST)
    expect(await sent.deployment.lookup(lost, [], actionContext(), null)).toMatchObject({ kind: 'resolved' })
  })

  it('may plan the replacement under another target: a new prepare under revision 2 is a new handle for model B', async () => {
    const fresh = world(both)
    const old = prepareUnder({ revision: 1, model: MODEL_A })
    expect(detail(await load(fresh, old.ref))).toBe('model_prepared_lost')
    // Loop plans again: the new request follows the selection that is current now, not the lost one.
    const replanned = prepareUnder({ revision: 2, model: MODEL_B })
    fresh.registry.put(replanned.handleId, replanned.entry)
    expect(replanned.handleId).not.toBe(old.handleId)
    expect(replanned.prepared.inputDigest).not.toBe(old.prepared.inputDigest)
    const loaded = await load(fresh, replanned.ref)
    if (!loaded.ok) throw new Error(loaded.error.detailCode)
    expect(loaded.value.model.id).toBe(MODEL_B)
  })

  it('does not hand the old handle to a run it was not prepared for', async () => {
    const w = world(both)
    const other = prepareUnder({ revision: 1, model: MODEL_A }, { runId: 'run-2', sessionId: 'session-1' })
    w.registry.put(other.handleId, other.entry)
    const old = prepareUnder({ revision: 1, model: MODEL_A })
    expect(detail(await load(w, old.ref))).toBe('model_prepared_lost')
  })
})
