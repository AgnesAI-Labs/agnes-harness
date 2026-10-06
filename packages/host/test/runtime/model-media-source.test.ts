import {
  buildWireRequest,
  handleIdOf,
  headerOf,
  type ModelCapture,
  modelInputDigest,
  type PreparedEntry,
  preparedIdOf,
} from '@agnes/core'
import type { ActionContext } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
} from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { mediaConsumed } from '../../../ai/src/runtime/model-adapter/media.js'
import { pack } from '../../../core/src/runtime/media/identity.js'
import { LIMITS, mediaBinding, must, planOf, stateBinding } from '../../../core/test/runtime/media-fixture.js'
import {
  callOf,
  frameFor,
  harness,
  openAction,
  readyView,
} from '../../../core/test/runtime/media-provider-fixture.js'
import { standardTool, toolCatalogOf } from '../../../core/test/runtime/model-tools-fixture.js'
import {
  createMediaResultSource,
  type MediaChildReceipts,
  MODEL_SOURCE_MEDIA,
  stateQuery,
} from '../../src/runtime/model/model-media-source.js'
import { createModelSourceReader } from '../../src/runtime/model/model-source-reader.js'
import { UNIMPLEMENTED_STATE_METHODS } from '../../src/runtime/providers/state.js'
import {
  fixtureContext,
  fixtureFrame,
  fixtureIds,
  fixtureModel,
  fixturePorts,
  fixtureWire,
  preparedFixture,
  sessionWith,
} from './model-source-fixture.js'

const images = [
  { marker: 1, node: 1 },
  { marker: 2, node: 2 },
]
const call = callOf()
const { runId, sessionId } = fixtureIds
const actionContext = {
  call: { signal: undefined, scope: { kind: 'action', sessionId, runId, actionId: 'act-1' } },
} as unknown as ActionContext
const detail = (r: { ok: boolean; error?: W.RuntimeError }) =>
  r.ok ? 'ok' : `${r.error?.code}/${r.error?.detailCode}`

/** Runs the real default media service, publishes its parent receipt and builds the locked request around it. */
async function published(kind: 'native' | 'convert', withTools = false) {
  const h = harness()
  const { action } = await openAction(h.deployment())
  const plan = planOf(kind === 'native' ? images : [images[0]!], kind)
  const frame = frameFor(plan)
  let done: W.ProviderTransition
  if (kind === 'native') done = await action.start(frame, h.ports)
  else {
    const first = await action.start(frame, h.ports)
    const second = { ...frame, providerRevision: 1, continuation: first.continuation }
    const waiting = await action.resume(second, h.ports)
    const receipt = h.childReceipt(waiting.children[0]!)
    done = await action.resume(
      {
        ...second,
        providerRevision: 2,
        continuation: waiting.continuation,
        receipts: { items: [receipt], snapshot: 's', nextCursor: null, complete: true },
      },
      h.ports,
    )
  }
  if (done.next.kind !== 'complete') throw new Error('media prepare did not complete')
  h.publish(
    readyView({
      actionId: 'infer-parent-media',
      receiptId: 'media-receipt',
      bindingId: mediaBinding.bindingId,
      inputDigest: canonicalJsonDigest(plan as never),
      outcome: 'succeeded',
      result: done.next.output,
    }),
  )

  const capture: ModelCapture = {
    adapterPackageDigest: 'package-1',
    route: { route: 'fixed-route', api: 'openai-completions', baseUrl: 'https://fake.invalid' },
    model: { ...fixtureModel, input: ['text', 'image'] },
  }
  const base = preparedFixture()
  const item = {
    ...base.view.items[0]!,
    id: 'media-item',
    sourceRefs: plan.sourceRefs,
  } as W.ContextItem
  const tool = withTools ? standardTool('text_statistics', 'Count the words of a text') : null
  const resolved = tool ? [tool.resolved] : null
  const unsealed: W.PreparedModelRequest = {
    ...base,
    target: { ...base.target, features: { ...plan.targetFeatures, tools: tool !== null } },
    toolCatalog: tool ? toolCatalogOf([tool.definition]) : null,
    view: { ...base.view, items: [item] },
    mediaPlans: [plan],
  }
  const inputDigest = modelInputDigest(unsealed, capture, fixtureWire, resolved)
  const prepared = { ...unsealed, inputDigest, preparedId: preparedIdOf(inputDigest) }
  const header = headerOf(prepared, capture, fixtureWire)
  const handleId = handleIdOf({ runId, sessionId, inputDigest })
  const handle: W.PreparedModelHandle = {
    kind: 'agh.model/prepared-handle@1',
    handleId,
    inputDigest,
    ownerBinding: prepared.ownerBinding,
    header,
  } as W.PreparedModelHandle
  const body = boundedCanonicalJson(handle, { maxBytes: 65_536, maxDepth: 32, maxMembers: 4096 })
  if (!body.ok) throw new Error('handle')
  const ref: Extract<W.DataRef, { kind: 'inline' }> = {
    kind: 'inline',
    schema: RuntimeSchemaRefs.PreparedModelHandle,
    value: body.value.json,
    digest: canonicalJsonDigest(body.value.json),
    bytes: body.value.bytes,
  }
  // The model service does not announce media plans yet, so no real entry carries them; this one stands in,
  // with the body a plan-free request would have had.
  const request = must(buildWireRequest({ ...prepared, mediaPlans: [] }, capture, fixtureWire, [], resolved))
  const entry: PreparedEntry = {
    runId,
    sessionId,
    ownerBinding: prepared.ownerBinding,
    inputDigest,
    header,
    prepared,
    capture,
    wire: fixtureWire,
    request,
    resolvedTools: resolved,
  }
  return { h, plan, entry, ref, handleId, header }
}
type Published = Awaited<ReturnType<typeof published>>

function sourceOver(p: Published, over: { children?: MediaChildReceipts; epoch?: () => string } = {}) {
  const store = {
    async probeActionResult(request: { actionId: string; sourceReceiptId: string }) {
      const reply = await p.h.ports.query({
        target: stateBinding,
        method: 'probeActionResult',
        input: must(pack(RuntimeMethodSchemaRefs['agh.state'].probeActionResult.input, request)),
      })
      if (!reply.ok || reply.value.kind !== 'value') throw new Error('state fixture')
      return {
        ok: true as const,
        value: reply.value.output.kind === 'inline' ? reply.value.output.value : null,
      }
    },
  }
  const calls = { epoch: 0, listed: 0 }
  const media = createMediaResultSource({
    state: stateBinding,
    query: stateQuery(store as never, call),
    children: over.children ?? {
      async list() {
        calls.listed += 1
        return { ok: true, value: [{ actionId: 'infer-parent-media', receiptId: 'media-receipt' }] }
      },
    },
    bytes: {
      async read(blob) {
        const bytes = p.h.bytes.get(blob.digest)
        return bytes
          ? { ok: true, value: bytes }
          : {
              ok: false,
              error: {
                code: 'denied',
                detailCode: 'media_source_denied',
                message: '',
                diagnosticId: 'd',
                retryAdvice: { kind: 'never' },
              },
            }
      },
    },
    limits: LIMITS,
    epoch: () => {
      calls.epoch += 1
      return over.epoch ? over.epoch() : 'epoch-0'
    },
  })
  return { media, calls }
}

function readerOver(p: Published, media: ReturnType<typeof sourceOver>['media'] | undefined) {
  return createModelSourceReader({
    packageDigest: 'package-1',
    registry: { get: () => p.entry },
    prices: { version: (target) => target.priceVersion },
    session: sessionWith({ primary: { route: 'fixed-route', model: 'fixture-model' } }),
    authorize: { epoch: () => 1 },
    ...(media ? { media } : {}),
  })
}
const frameOf = (p: Published, parent: string | null = 'infer-parent') =>
  ({ ...fixtureFrame(p.ref), parentActionId: parent }) as never as W.ActionFrame

const imageBlocks = (request: { messages: { role: string; content: { type: string }[] }[] }) =>
  request.messages.flatMap((m) => m.content).filter((b) => b.type === 'image').length

describe('model source reader with media', () => {
  it('loads a native result from the published receipts and the adapter check accepts it', async () => {
    const p = await published('native')
    const { media } = sourceOver(p)
    const reader = readerOver(p, media)
    const frame = frameOf(p)
    const loaded = await reader.load(p.ref, frame, actionContext)
    if (!loaded.ok) throw new Error(loaded.error.detailCode)
    expect(imageBlocks(loaded.value.request as never)).toBe(2)
    expect(loaded.value.media).toHaveLength(1)
    expect(loaded.value.media?.[0]?.usageIds).toEqual([])
    expect(loaded.value.request.derivedHash).toBe(loaded.value.prepared.inputDigest)
    expect(mediaConsumed(loaded.value)).toBe(true)
    expect(reader.current(loaded.value, frame, actionContext.call)).toBe(true)
  })

  it('rebuilds the request with the tools the entry kept, next to the verified media', async () => {
    const p = await published('native', true)
    const reader = readerOver(p, sourceOver(p).media)
    const loaded = await reader.load(p.ref, frameOf(p), actionContext)
    if (!loaded.ok) throw new Error(loaded.error.detailCode)
    expect(loaded.value.request.tools.map((tool) => tool.name)).toEqual(['text_statistics'])
    expect(loaded.value.request.tools[0]?.description).toBe('Count the words of a text')
    expect(imageBlocks(loaded.value.request as never)).toBe(2)
    expect(loaded.value.request.derivedHash).toBe(loaded.value.prepared.inputDigest)
  })

  it('loads a converted result: the vision text rides on the request and the usage stays the child usage', async () => {
    const p = await published('convert')
    const loaded = await readerOver(p, sourceOver(p).media).load(p.ref, frameOf(p), actionContext)
    if (!loaded.ok) throw new Error(loaded.error.detailCode)
    const text = JSON.stringify(loaded.value.request.messages)
    expect(text).toContain('[untrusted auxiliary vision analysis]')
    expect(imageBlocks(loaded.value.request as never)).toBe(0)
    expect(loaded.value.media?.[0]?.usageIds).toEqual(['vision-attempt:model'])
    expect(mediaConsumed(loaded.value)).toBe(true)
  })

  it('is no longer current once access to the sources may have been withdrawn after the load', async () => {
    const p = await published('native')
    let epoch = 'epoch-0'
    const reader = readerOver(p, sourceOver(p, { epoch: () => epoch }).media)
    const frame = frameOf(p)
    const loaded = await reader.load(p.ref, frame, actionContext)
    if (!loaded.ok) throw new Error(loaded.error.detailCode)
    expect(reader.current(loaded.value, frame, actionContext.call)).toBe(true)
    epoch = 'epoch-1'
    expect(reader.current(loaded.value, frame, actionContext.call)).toBe(false)
  })

  it('refuses a prepared call with media plans when no media source is installed', async () => {
    const p = await published('native')
    expect(detail(await readerOver(p, undefined).load(p.ref, frameOf(p), actionContext))).toBe(
      `denied/${MODEL_SOURCE_MEDIA}`,
    )
  })

  it('does not touch the media source when the request carries no plans, and keeps the prepared request body', async () => {
    const touched: string[] = []
    const media = {
      async read() {
        touched.push('read')
        return { ok: true as const, value: [] }
      },
      epoch: () => {
        touched.push('epoch')
        return 'e'
      },
    }
    const { ports, ref, entry } = fixturePorts()
    const reader = createModelSourceReader({ ...ports, media })
    const frame = fixtureFrame(ref)
    const context = fixtureContext()
    const loaded = await reader.load(ref, frame, context)
    if (!loaded.ok) throw new Error(loaded.error.detailCode)
    expect(loaded.value.request).toEqual(entry.request)
    expect(loaded.value.media).toBeUndefined()
    expect(reader.current(loaded.value, frame, context.call)).toBe(true)
    expect(touched).toEqual([])
  })

  it.each([
    [
      'no parent action to read children from',
      'native',
      (p: Published) => frameOf(p, null),
      undefined,
      'denied/model_source_media',
    ],
    [
      'no child published yet',
      'native',
      (p: Published) => frameOf(p),
      {
        async list() {
          return { ok: true as const, value: [] }
        },
      },
      'retryable/model_source_not_ready',
    ],
    [
      'the children cannot be listed',
      'native',
      (p: Published) => frameOf(p),
      {
        async list() {
          return {
            ok: false as const,
            error: {
              code: 'internal',
              detailCode: 'x',
              message: '',
              diagnosticId: 'd',
              retryAdvice: { kind: 'never' },
            } as W.RuntimeError,
          }
        },
      },
      'retryable/model_source_not_ready',
    ],
  ] as const)('refuses by name: %s', async (_name, kind, frame, children, expected) => {
    const p = await published(kind)
    const { media } = sourceOver(p, children ? { children: children as MediaChildReceipts } : {})
    expect(detail(await readerOver(p, media).load(p.ref, frame(p), actionContext))).toBe(expected)
  })

  it('refuses when the immutable child receipt of a conversion no longer matches the claim', async () => {
    const p = await published('convert')
    p.h.childReceipt({ ...(p.h.log.prepared[0] as W.PreparedAction) }, 'a different description')
    expect(detail(await readerOver(p, sourceOver(p).media).load(p.ref, frameOf(p), actionContext))).toBe(
      `denied/${MODEL_SOURCE_MEDIA}`,
    )
  })

  it('refuses when a source can no longer be read, and when access changes while reading', async () => {
    const p = await published('native')
    let reads = 0
    const flipping = sourceOver(p, { epoch: () => `epoch-${reads++ % 2}` }).media
    expect(detail(await readerOver(p, flipping).load(p.ref, frameOf(p), actionContext))).toBe(
      `denied/${MODEL_SOURCE_MEDIA}`,
    )
    p.h.bytes.clear()
    expect(detail(await readerOver(p, sourceOver(p).media).load(p.ref, frameOf(p), actionContext))).toBe(
      `denied/${MODEL_SOURCE_MEDIA}`,
    )
  })

  it('refuses a load whose permission changed while the media was being read', async () => {
    const p = await published('native')
    let epoch = 1
    const media = sourceOver(p).media
    const reader = createModelSourceReader({
      packageDigest: 'package-1',
      registry: { get: () => p.entry },
      prices: { version: (target) => target.priceVersion },
      session: sessionWith({ primary: { route: 'fixed-route', model: 'fixture-model' } }),
      authorize: { epoch: () => epoch },
      media: {
        epoch: media.epoch,
        async read(entry, frame, context) {
          const read = await media.read(entry, frame, context)
          epoch += 1
          return read
        },
      },
    })
    expect(detail(await reader.load(p.ref, frameOf(p), actionContext))).toBe('denied/model_source_stale')
  })

  it('refuses when the header does not commit to the plans the entry carries', async () => {
    const p = await published('native')
    const read = await sourceOver(p).media.read(
      { prepared: p.entry.prepared, header: { ...p.header, mediaPlanDigests: [] } },
      frameOf(p),
      call,
    )
    expect(detail(read)).toBe(`denied/${MODEL_SOURCE_MEDIA}`)
  })
})

describe('state query adapter', () => {
  it('forwards only probeActionResult and refuses any other read', async () => {
    const probed: unknown[] = []
    const query = stateQuery(
      {
        async probeActionResult(request: unknown) {
          probed.push(request)
          return { ok: true as const, value: null }
        },
      } as never,
      call,
    )
    const input = must(
      pack(RuntimeMethodSchemaRefs['agh.state'].probeActionResult.input, {
        actionId: 'a',
        sourceReceiptId: 'r',
      }),
    )
    const ok = await query({ target: stateBinding, method: 'probeActionResult', input })
    expect(ok.ok && ok.value.kind).toBe('value')
    expect(probed).toEqual([{ actionId: 'a', sourceReceiptId: 'r' }])
    expect(detail(await query({ target: stateBinding, method: 'other', input }))).toBe(
      `incompatible/${MODEL_SOURCE_MEDIA}`,
    )
    expect(probed).toHaveLength(1)
  })

  it('names the production State limit that keeps this port out of production', () => {
    // Fails once the State commits composite children itself; then listing a parent's children is the next gap.
    expect(UNIMPLEMENTED_STATE_METHODS).toContain('advanceProvider')
  })
})
