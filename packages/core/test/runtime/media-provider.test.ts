import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type * as W from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  validateRuntime,
  validateRuntimeErrorDetail,
} from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { collectPreparedMedia } from '../../src/runtime/media/continuation.js'
import { mediaSourceDigest, pack } from '../../src/runtime/media/identity.js'
import { verifyPreparedMedia } from '../../src/runtime/media/verify.js'
import {
  featuresImage,
  LIMITS,
  legacyImage,
  mediaBinding,
  must,
  planOf,
  png,
  publicBlob,
} from './media-fixture.js'
import {
  callOf,
  frameFor,
  harness,
  modelOutput,
  openAction,
  readyView,
  visionTarget,
} from './media-provider-fixture.js'

const detail = (t: W.ProviderTransition) =>
  t.next.kind === 'fail' ? `${t.next.error.code}/${t.next.error.detailCode}` : t.next.kind
const mediaOf = (t: W.ProviderTransition): W.PreparedMedia => {
  if (t.next.kind !== 'complete' || t.next.output.kind !== 'inline')
    throw new Error(`not complete: ${detail(t)}`)
  const checked = validateRuntime('PreparedMedia', t.next.output.value)
  if (!checked.ok) throw new Error('PreparedMedia invalid')
  return checked.value
}
const images = [
  { marker: 1, node: 1 },
  { marker: 2, node: 2 },
]

describe('native media', () => {
  it('completes in start with no child, no compute and no usage', async () => {
    const h = harness()
    const { action } = await openAction(h.deployment())
    const plan = planOf(images, 'native')
    const done = await action.start(frameFor(plan), h.ports)
    const media = mediaOf(done)
    expect(done.children).toHaveLength(0)
    expect(h.log.computes).toBe(0)
    expect(h.log.prepared).toHaveLength(0)
    expect(h.log.resolves).toBe(0)
    expect(media.usageRefs).toEqual([])
    expect(media.transformChain).toEqual([])
    expect(media.contentRefs).toHaveLength(3) // manifest + two blobs
    expect(verifyPreparedMedia(plan, media, { child: null }).ok).toBe(true)
  })

  it('records an omitted result when no image is eligible, still without a child', async () => {
    const h = harness()
    const small = png(4, 4, 7) // below the legacy minimum dimension of 8
    const ref = publicBlob(small)
    if (ref.kind !== 'blob') throw new Error('fixture')
    h.bytes.set(ref.value.digest, small)
    const plan = {
      ...planOf([{ marker: 7, node: 1 }], 'native'),
      sourceRefs: [ref],
      sourceDigest: must(mediaSourceDigest([ref])),
    }
    const { action } = await openAction(h.deployment())
    const done = await action.start(frameFor(plan), h.ports)
    const media = mediaOf(done)
    expect(done.children).toHaveLength(0)
    expect(media.contentRefs).toHaveLength(1) // the manifest only
    const verified = verifyPreparedMedia(plan, media, { child: null })
    expect(verified.ok && verified.value.kind).toBe('omitted')
  })

  it('refuses a native plan for a text-only target, and a conversion plan for an image-capable one', async () => {
    const h = harness()
    const { action } = await openAction(h.deployment())
    const nativePlan = {
      ...planOf(images, 'native'),
      targetFeatures: { ...featuresImage, input: ['text' as const] },
    }
    expect(detail(await action.start(frameFor(nativePlan), h.ports))).toBe(
      'incompatible/media_native_unavailable',
    )
    const convertPlan = { ...planOf(images, 'convert'), targetFeatures: featuresImage }
    expect(detail(await action.start(frameFor(convertPlan), h.ports))).toBe(
      'incompatible/media_conversion_not_needed',
    )
    expect(h.log.computes).toBe(0)
    expect(h.log.prepared).toHaveLength(0)
  })
})

describe('conversion', () => {
  async function runToChild(h = harness()) {
    const { action } = await openAction(h.deployment())
    const plan = planOf(images, 'convert')
    const frame = frameFor(plan)
    const preflighted = await action.start(frame, h.ports)
    const computesAfterStart = h.log.computes
    const second = { ...frame, providerRevision: 1, continuation: preflighted.continuation }
    const waiting = await action.resume(second, h.ports)
    return { h, action, plan, frame, preflighted, second, waiting, computesAfterStart }
  }

  it('preflights in start without any effect, then creates exactly one child in resume', async () => {
    const { h, preflighted, waiting, computesAfterStart } = await runToChild()
    expect(computesAfterStart).toBe(0)
    expect(preflighted.children).toHaveLength(0)
    expect(preflighted.next).toEqual({ kind: 'continue' })
    expect(h.log.computes).toBe(1)
    expect(waiting.children).toHaveLength(1)
    expect(waiting.next.kind).toBe('wait')
    const child = waiting.children[0]!
    expect(child.method).toBe('infer')
    expect(child.target.bindingId).toBe('model-binding')
    expect(child.retry).toEqual({ mode: 'never', maxAttempts: 1, backoffMs: [] })
    expect(child.obligation).toBe('mandatory')
  })

  it('completes with the child usage, a derived trust and a chain a consumer verifies from receipts', async () => {
    const { h, action, plan, second, waiting } = await runToChild()
    const receipt = h.childReceipt(waiting.children[0]!)
    const third = {
      ...second,
      providerRevision: 2,
      continuation: waiting.continuation,
      receipts: { items: [receipt], snapshot: 's', nextCursor: null, complete: true },
    }
    const done = await action.resume(third, h.ports)
    const media = mediaOf(done)
    expect(done.children).toHaveLength(0)
    expect(media.trust).toBe('derived')
    expect(media.usageRefs.map((u) => u.usageId)).toEqual(['vision-attempt:model'])
    expect(media.transformChain).toHaveLength(1)
    expect(h.log.computes).toBe(1)
    expect(h.log.prepared).toHaveLength(1)

    // the model composite publishes this result as the parent receipt; a consumer re-reads the child receipt too
    h.publish(
      readyView({
        actionId: 'media-parent',
        receiptId: 'media-receipt',
        bindingId: mediaBinding.bindingId,
        inputDigest: canonicalJsonDigest(plan as never),
        outcome: 'succeeded',
        result: must(pack(RuntimeMethodSchemaRefs['agh.media'].prepare.output, media)),
      }),
    )
    const collect = () =>
      collectPreparedMedia({
        plans: [plan],
        receipts: [{ actionId: 'media-parent', receiptId: 'media-receipt' }],
        ports: h.ports,
        state: h.deployment().state,
        context: callOf(),
      })
    const ready = await collect()
    expect(ready.kind).toBe('ready')
    h.childReceipt(waiting.children[0]!, 'a different description') // the immutable receipt no longer matches the claim
    const forged = await collect()
    expect(forged.kind === 'failed' && forged.error.detailCode).toBe('media_verify_receipt')
    expect(
      (
        await collectPreparedMedia({
          plans: [plan],
          receipts: [],
          ports: h.ports,
          state: h.deployment().state,
          context: callOf(),
        })
      ).kind,
    ).toBe('pending')
  })

  it('a cold process that only has the persisted frame does not create a second child', async () => {
    const { h, plan, second, waiting } = await runToChild()
    const receipt = h.childReceipt(waiting.children[0]!)
    const third = {
      ...second,
      providerRevision: 2,
      continuation: waiting.continuation,
      receipts: { items: [receipt], snapshot: 's', nextCursor: null, complete: true },
    }
    const warm = await (await openAction(h.deployment())).action.resume(third, h.ports)
    const cold = await (await openAction(h.deployment())).action.resume(third, h.ports)
    expect(cold.children).toHaveLength(0)
    expect(h.log.computes).toBe(1)
    expect(h.log.prepared).toHaveLength(1)
    expect(canonicalJsonDigest(mediaOf(cold) as never)).toBe(canonicalJsonDigest(mediaOf(warm) as never))
    void plan
  })

  it('a replayed preflighted step may get a different prepared reference but keeps the same child key', async () => {
    const { h, action, second, waiting } = await runToChild()
    const replay = await action.resume(second, h.ports) // the first transition was never committed
    expect(h.log.computes).toBe(2)
    expect(replay.children).toHaveLength(1)
    expect(replay.children[0]!.input).not.toEqual(h.log.prepared[0]!.input)
    expect(replay.children[0]!.key).toBe(waiting.children[0]!.key)
  })

  it('keeps waiting before the deadline and reports an unknown effect after it, never a second child', async () => {
    const { h, action, second, waiting } = await runToChild()
    const pending = { ...second, providerRevision: 2, continuation: waiting.continuation }
    const again = await action.resume(pending, h.ports)
    expect(again.children).toHaveLength(0)
    expect(again.next.kind).toBe('wait')
    const late = {
      ...pending,
      context: { ...pending.context, deadline: new Date(Date.now() - 1000).toISOString() },
    }
    const unknown = await action.resume(late, h.ports)
    expect(detail(unknown)).toBe('unknown_effect/media_conversion_unknown')
    expect(unknown.next.kind === 'fail' && validateRuntimeErrorDetail(unknown.next.error).ok).toBe(true)
    expect(unknown.children).toHaveLength(0)
    expect(h.log.prepared).toHaveLength(1)
  })

  it('maps child outcomes: failed and cancelled fail by name; an unknown effect waits, then fails', async () => {
    const expected = {
      failed: 'internal/media_conversion_failed',
      cancelled: 'cancelled/media_conversion_failed',
    } as const
    for (const outcome of ['failed', 'cancelled'] as const) {
      const { h, action, second, waiting } = await runToChild()
      const receipt = h.childReceipt(waiting.children[0]!, null, outcome)
      const frame = {
        ...second,
        providerRevision: 2,
        continuation: waiting.continuation,
        receipts: { items: [receipt], snapshot: 's', nextCursor: null, complete: true },
      }
      const result = await action.resume(frame, h.ports)
      expect(result.children).toHaveLength(0)
      expect(detail(result)).toBe(expected[outcome])
    }
    const { h, action, second, waiting } = await runToChild()
    const receipt = h.childReceipt(waiting.children[0]!, null, 'unknown_effect')
    const open = {
      ...second,
      providerRevision: 2,
      continuation: waiting.continuation,
      receipts: { items: [receipt], snapshot: 's', nextCursor: null, complete: true },
    }
    const early = await action.resume(open, h.ports)
    expect(early.next.kind).toBe('wait')
    expect(early.children).toHaveLength(0)
    const late = await action.resume(
      { ...open, context: { ...open.context, deadline: new Date(Date.now() - 1000).toISOString() } },
      h.ports,
    )
    expect(detail(late)).toBe('unknown_effect/media_conversion_unknown')
    expect(late.next).toMatchObject({
      error: { retryAdvice: { kind: 'reconcile', ownerRef: { kind: 'action', id: expect.any(String) } } },
    })
    expect(h.log.prepared).toHaveLength(1)
  })

  it('does not adopt a receipt that belongs to another action', async () => {
    const { h, action, second, waiting } = await runToChild()
    const real = waiting.children[0]!
    h.publish(
      readyView({
        actionId: 'other-child',
        receiptId: 'other-receipt',
        bindingId: real.target.bindingId,
        inputDigest: 'e'.repeat(64),
        outcome: 'succeeded',
        result: must(pack(RuntimeMethodSchemaRefs['agh.model'].infer.output, modelOutput())),
      }),
    )
    const frame = {
      ...second,
      providerRevision: 2,
      continuation: waiting.continuation,
      receipts: {
        items: [{ actionId: 'other-child', receiptId: 'other-receipt', outcome: 'succeeded' as const }],
        snapshot: 's',
        nextCursor: null,
        complete: true,
      },
    }
    const result = await action.resume(frame, h.ports)
    expect(result.next.kind).toBe('wait')
    expect(result.children).toHaveLength(0)
  })

  it('refuses a resume whose persisted media hash no longer matches the re-read sources', async () => {
    const h = harness()
    const { action } = await openAction(h.deployment())
    const frame = frameFor(planOf(images, 'convert'))
    const preflighted = await action.start(frame, h.ports)
    const saved = preflighted.continuation.data
    if (saved.kind !== 'inline') throw new Error('continuation')
    const tampered = must(pack(saved.schema, { ...(saved.value as object), mediaHash: 'f'.repeat(64) }))
    const result = await action.resume(
      { ...frame, providerRevision: 1, continuation: { ...preflighted.continuation, data: tampered } },
      h.ports,
    )
    expect(detail(result)).toBe('conflict/media_source_drift')
    expect(result.children).toHaveLength(0)
  })

  it('does not publish a converted result when access is withdrawn after the child finished', async () => {
    const { h, action, second, waiting } = await runToChild()
    const receipt = h.childReceipt(waiting.children[0]!)
    const frame = {
      ...second,
      providerRevision: 2,
      continuation: waiting.continuation,
      receipts: { items: [receipt], snapshot: 's', nextCursor: null, complete: true },
    }
    const revoking = {
      ...h.ports,
      query: async (request: Parameters<typeof h.ports.query>[0]) => {
        h.setEpoch('revoked')
        return h.ports.query(request)
      },
    }
    const result = await action.resume(frame, revoking)
    expect(detail(result)).toBe('denied/media_source_denied')
  })

  it('refuses a result whose text is missing or too large', async () => {
    const { h, action, second, waiting } = await runToChild()
    const receipt = h.childReceipt(waiting.children[0]!, null)
    const frame = {
      ...second,
      providerRevision: 2,
      continuation: waiting.continuation,
      receipts: { items: [receipt], snapshot: 's', nextCursor: null, complete: true },
    }
    expect(detail(await action.resume(frame, h.ports))).toBe('incompatible/media_conversion_result_invalid')
    const big = h.childReceipt(waiting.children[0]!, 'x'.repeat(50_000))
    const bigFrame = { ...frame, receipts: { ...frame.receipts, items: [big] } }
    expect(detail(await action.resume(bigFrame, h.ports))).toBe('quota/media_derived_too_large')
  })

  it('detects drift of a source or of the vision route between the two steps, without creating a child', async () => {
    const h = harness()
    const { action } = await openAction(h.deployment())
    const plan = planOf(images, 'convert')
    const frame = frameFor(plan)
    const preflighted = await action.start(frame, h.ports)
    h.setVision(visionTarget({ route: { ...visionTarget().route, routeRevision: 2 } }))
    const drifted = await action.resume(
      { ...frame, providerRevision: 1, continuation: preflighted.continuation },
      h.ports,
    )
    expect(detail(drifted)).toBe('conflict/media_route_drift')
    expect(drifted.children).toHaveLength(0)
    expect(h.log.prepared).toHaveLength(0)
    h.setVision(visionTarget())
    const firstDigest = plan.sourceRefs[0]!.kind === 'blob' ? plan.sourceRefs[0]!.value.digest : ''
    h.bytes.set(firstDigest, legacyImage(1, 0, 99).bytes)
    const changed = await action.resume(
      { ...frame, providerRevision: 1, continuation: preflighted.continuation },
      h.ports,
    )
    expect(detail(changed)).toBe('conflict/media_source_drift')
    expect(h.log.prepared).toHaveLength(0)
  })

  it('refuses conversion when no vision target exists, when depth is exhausted, or an edge is too large', async () => {
    const h = harness()
    h.setVision(null)
    const { action } = await openAction(h.deployment({ vision: null }))
    expect(detail(await action.start(frameFor(planOf(images, 'convert')), h.ports))).toBe(
      'incompatible/media_conversion_unavailable',
    )
    const h2 = harness()
    const { action: a2 } = await openAction(h2.deployment())
    expect(
      detail(await a2.start(frameFor(planOf(images, 'convert', { allowConversion: false })), h2.ports)),
    ).toBe('incompatible/media_conversion_depth')
    expect(detail(await a2.start(frameFor(planOf(images, 'native', { maxEdge: 7 })), h2.ports))).toBe(
      'incompatible/media_image_resize_required',
    )
  })

  it('degrades only when the plan asks for it', async () => {
    const h = harness()
    const { action } = await openAction(h.deployment())
    const plan = planOf(images, 'convert', { failurePolicy: 'degrade' })
    const frame = frameFor(plan)
    const preflighted = await action.start(frame, h.ports)
    const waiting = await action.resume(
      { ...frame, providerRevision: 1, continuation: preflighted.continuation },
      h.ports,
    )
    const receipt = h.childReceipt(waiting.children[0]!, null, 'failed')
    const done = await action.resume(
      {
        ...frame,
        providerRevision: 2,
        continuation: waiting.continuation,
        receipts: { items: [receipt], snapshot: 's', nextCursor: null, complete: true },
      },
      h.ports,
    )
    const media = mediaOf(done)
    expect(media.usageRefs).toEqual([])
    expect(verifyPreparedMedia(plan, media, { child: null }).ok).toBe(true)
  })
})

describe('authorization, cancellation and lifecycle', () => {
  it('refuses with no effect when permission is gone or a source is denied', async () => {
    for (const plan of [planOf(images, 'native'), planOf(images, 'convert')]) {
      const h = harness()
      h.setAllowed(false)
      const { action } = await openAction(h.deployment())
      const refused = await action.start(frameFor(plan), h.ports)
      expect(detail(refused)).toBe('denied/media_source_denied')
      expect(h.log.computes).toBe(0)
      expect(h.log.prepared).toHaveLength(0)
    }
  })

  it('refuses when the deployment permission is gone even though the sources would answer', async () => {
    const h = harness()
    const { action } = await openAction(h.deployment({ authorize: () => false }))
    const refused = await action.start(frameFor(planOf(images, 'native')), h.ports)
    expect(detail(refused)).toBe('denied/media_source_denied')
    expect(h.log.opens).toBe(0)
  })

  it('does not publish a result when access is withdrawn while it is being prepared', async () => {
    const h = harness()
    const deployment = h.deployment()
    const original = deployment.sources.open
    const revoking = {
      ...deployment,
      sources: {
        epoch: deployment.sources.epoch,
        open: async (ref: W.PublicRef, context: never) => {
          const r = await original(ref, context)
          h.setEpoch('epoch-1')
          return r
        },
      },
    }
    const { action } = await openAction(revoking)
    const done = await action.start(frameFor(planOf(images, 'native')), h.ports)
    expect(detail(done)).toBe('denied/media_source_denied')
  })

  it('refuses a plan addressed to another binding, a foreign run and non-blob sources', async () => {
    const h = harness()
    const { action } = await openAction(h.deployment())
    const plan = planOf(images, 'native')
    expect(
      detail(
        await action.start(
          frameFor({ ...plan, provider: { ...plan.provider, bindingId: 'other' } }),
          h.ports,
        ),
      ),
    ).toBe('denied/media_binding_denied')
    expect(detail(await action.start({ ...frameFor(plan), runId: 'foreign' }, h.ports))).toBe(
      'denied/media_binding_denied',
    )
    const artifact = {
      ...plan,
      sourceRefs: [{ kind: 'artifact', value: { artifactId: 'a', version: 1 } }],
    } as unknown as W.MediaPlan
    expect(detail(await action.start(frameFor(artifact), h.ports))).toMatch(
      /media_source_kind|media_input_schema/,
    )
  })

  it('refuses before any effect when already cancelled, and after the provider is closed', async () => {
    const h = harness()
    const aborted = new AbortController()
    aborted.abort()
    const { action } = await openAction(h.deployment(), aborted.signal)
    expect(detail(await action.start(frameFor(planOf(images, 'convert')), h.ports))).toBe(
      'cancelled/request_cancelled',
    )
    expect(h.log.opens).toBe(0)
    const { provider, action: live } = await openAction(h.deployment())
    await provider.close('shutdown')
    expect(detail(await live.start(frameFor(planOf(images, 'native')), h.ports))).toBe(
      'denied/provider_closed',
    )
    expect((await provider.ready(callOf())).ok).toBe(false)
  })

  it('refuses a resume whose continuation does not belong to the plan', async () => {
    const h = harness()
    const { action } = await openAction(h.deployment())
    const frame = frameFor(planOf(images, 'convert'))
    const preflighted = await action.start(frame, h.ports)
    const other = frameFor(planOf([{ marker: 3, node: 1 }], 'convert'))
    const wrong = await action.resume(
      { ...other, providerRevision: 1, continuation: preflighted.continuation },
      h.ports,
    )
    expect(detail(wrong)).toBe('conflict/media_continuation_conflict')
    const missing = await action.resume({ ...frame, providerRevision: 1, continuation: null }, h.ports)
    expect(detail(missing)).toBe('conflict/media_continuation_conflict')
  })
})

describe('limits', () => {
  it('stays closed until every product limit is configured', async () => {
    const h = harness()
    for (const limits of [
      {},
      { ...LIMITS, maxBytesPerImage: 0 },
      { ...LIMITS, maxSelectedPixels: undefined },
    ]) {
      await expect(openAction(h.deployment({ limits: limits as never }))).rejects.toThrow(
        'Media limits are not configured',
      )
    }
  })

  it('refuses a plan that widens the deployment limits', async () => {
    const h = harness()
    const { action } = await openAction(h.deployment())
    const wide = planOf(images, 'native', {
      limits: { ...LIMITS, maxBytesPerImage: LIMITS.maxBytesPerImage + 1 },
    })
    expect(detail(await action.start(frameFor(wide), h.ports))).toBe('invalid_input/media_input_schema')
    expect(h.log.opens).toBe(0)
  })
})

describe('structure', () => {
  const root = fileURLToPath(new URL('../../src/runtime/', import.meta.url))
  const sources = [
    ...readdirSync(`${root}media`).map((name) => `${root}media/${name}`),
    `${root}providers/media.ts`,
  ]
  it('imports only what the media service may depend on', () => {
    const forbidden =
      /(usage-ledger|billing|pricing|\/ledger\/|\/cost\/|SessionImpl|\.\.\/step\/|\.\.\/\.\.\/step\/|orchestrator\/(?!request-media|auxiliary-vision))/
    for (const file of sources) {
      const imports = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => /^\s*(import|export)\b.*from\s/.test(line))
      for (const line of imports) expect(line, file).not.toMatch(forbidden)
    }
  })
})
