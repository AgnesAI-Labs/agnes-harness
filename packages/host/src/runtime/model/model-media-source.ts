import {
  collectPreparedMedia,
  type MediaByteReader,
  type PreparedEntry,
  type ResolvedMedia,
  resolveMediaParts,
} from '@agnes/core'
import type { CallContext, LoopReadPorts, Outcome, StateStoreControl } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { boundedCanonicalJson, canonicalJsonDigest, RuntimeMethodSchemaRefs } from '@agnes/protocol/runtime'

/** The detail code of every refusal this port makes; the reader forwards it. */
export const MODEL_SOURCE_MEDIA = 'model_source_media'

/**
 * The receipts of the children one parent action has published. The State has no read that lists them
 * by parent; this is the seam a production State fills.
 */
export interface MediaChildReceipts {
  list(
    parent: Readonly<{ runId: string; actionId: string }>,
    context: CallContext,
  ): Promise<Outcome<readonly { actionId: string; receiptId: string }[]>>
}

/** What the model source reader asks for when a prepared call carries media plans. */
export interface MediaResultSource {
  read(
    entry: Pick<PreparedEntry, 'prepared' | 'header'>,
    frame: W.ActionFrame,
    context: CallContext,
  ): Promise<Outcome<readonly ResolvedMedia[]>>
  /** Changes whenever access to the media sources may have been withdrawn. */
  epoch(context: CallContext): string
}

const refuse = (
  code: W.RuntimeError['code'],
  detailCode: string,
): Readonly<{ ok: false; error: W.RuntimeError }> => ({
  ok: false,
  error: {
    code,
    detailCode,
    message: 'Model media source refused',
    retryAdvice: { kind: 'never' },
    diagnosticId: 'model-media-source',
  },
})

export function createMediaResultSource(deps: {
  state: W.BindingRef
  query: LoopReadPorts['query']
  children: MediaChildReceipts
  bytes: MediaByteReader
  limits: Parameters<typeof resolveMediaParts>[2]
  epoch(context: CallContext): string
}): MediaResultSource {
  return {
    epoch: (context) => deps.epoch(context),
    async read(entry, frame, context) {
      const { prepared, header } = entry
      if (prepared.mediaPlans.length === 0) return { ok: true, value: [] }
      // The plans the request carries are exactly the ones the handle header committed to.
      const planDigests = prepared.mediaPlans.map((plan) =>
        canonicalJsonDigest(plan as unknown as W.JsonValue),
      )
      if (canonicalJsonDigest(planDigests) !== canonicalJsonDigest(header.mediaPlanDigests))
        return refuse('denied', MODEL_SOURCE_MEDIA)
      // The media children are published under the same parent as the adapter call; no parent, no media.
      if (frame.parentActionId === null) return refuse('denied', MODEL_SOURCE_MEDIA)
      const before = deps.epoch(context)
      const listed = await deps.children.list({ runId: frame.runId, actionId: frame.parentActionId }, context)
      if (!listed.ok) return refuse('retryable', 'model_source_not_ready')
      const collected = await collectPreparedMedia({
        plans: prepared.mediaPlans,
        receipts: listed.value,
        ports: { query: deps.query },
        state: deps.state,
        context,
      })
      if (collected.kind === 'pending') return refuse('retryable', 'model_source_not_ready')
      if (collected.kind === 'failed') return refuse('denied', MODEL_SOURCE_MEDIA)
      const resolved: ResolvedMedia[] = []
      for (const verified of collected.media) {
        const part = await resolveMediaParts(verified, deps.bytes, deps.limits, context)
        if (!part.ok) return refuse('denied', MODEL_SOURCE_MEDIA)
        resolved.push(part.value)
      }
      // Access withdrawn while reading: nothing is handed to the request builder.
      if (deps.epoch(context) !== before) return refuse('denied', MODEL_SOURCE_MEDIA)
      return { ok: true, value: resolved }
    },
  }
}

/** Presents the State's own `probeActionResult` as the read the media collector needs. */
export function stateQuery(
  store: Pick<StateStoreControl, 'probeActionResult'>,
  context: CallContext,
): LoopReadPorts['query'] {
  return async (request) => {
    const input =
      request.input.kind === 'inline'
        ? (request.input.value as { actionId?: unknown; sourceReceiptId?: unknown } | null)
        : null
    if (
      request.method !== 'probeActionResult' ||
      typeof input?.actionId !== 'string' ||
      typeof input.sourceReceiptId !== 'string'
    )
      return refuse('incompatible', MODEL_SOURCE_MEDIA)
    const probed = await store.probeActionResult(
      { actionId: input.actionId, sourceReceiptId: input.sourceReceiptId },
      context,
    )
    if (!probed.ok) return probed
    const bounded = boundedCanonicalJson(probed.value, { maxBytes: 65_536, maxDepth: 32, maxMembers: 10_000 })
    if (!bounded.ok) return refuse('quota', MODEL_SOURCE_MEDIA)
    return {
      ok: true,
      value: {
        kind: 'value',
        output: {
          kind: 'inline',
          schema: RuntimeMethodSchemaRefs['agh.state'].probeActionResult.output,
          value: bounded.value.json,
          digest: canonicalJsonDigest(bounded.value.json),
          bytes: bounded.value.bytes,
        },
        snapshot: 'state',
      },
    }
  }
}
