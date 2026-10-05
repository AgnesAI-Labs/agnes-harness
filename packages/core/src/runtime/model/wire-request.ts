import type { Outcome } from '@agnes/extension-api/runtime'
import type { ModelRecord, RequestBody, SlotName } from '@agnes/protocol'
import { validateAgainst } from '@agnes/protocol'
import { RequestBody as WireSchema } from '@agnes/protocol/gen/model'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import type { ResolvedMedia } from '../media/resolve.js'

/** What the retained catalog contributes to the digest: the adapter package, the route and the whole model record. */
export type ModelCapture = Readonly<{
  adapterPackageDigest: string
  route: Readonly<{ route: string; api: string; baseUrl: string; compat?: Wire.JsonValue; keyless?: boolean }>
  model: ModelRecord
}>

/** The wire identity that shapes the external request, resolved by the issuing boundary, never by the caller. */
export type WireIdentity = Readonly<{ sessionKey: string; slot: SlotName; contractId: string | null }>

export const MODEL_INPUT_KIND = 'agh.model/input@1' as const

/**
 * The digest preimage. It leaves out the digest itself, the random prepared id and the units estimated
 * afterwards; everything else, including any field a later revision adds, is kept so nothing is dropped silently.
 */
export function modelInputPreimage(
  prepared: Wire.PreparedModelRequest,
  capture: ModelCapture,
  wire: WireIdentity,
): Wire.JsonValue {
  const { preparedId: _id, inputDigest: _digest, estimatedUnits: _units, ...rest } = prepared
  return { kind: MODEL_INPUT_KIND, ...rest, wire, capture } as unknown as Wire.JsonValue
}

export function modelInputDigest(
  prepared: Wire.PreparedModelRequest,
  capture: ModelCapture,
  wire: WireIdentity,
): Wire.Digest {
  return canonicalJsonDigest(modelInputPreimage(prepared, capture, wire))
}

const incompatible = (detailCode: string): Outcome<never> => ({
  ok: false,
  error: {
    code: 'incompatible',
    detailCode,
    message: 'Model request cannot be expressed on the wire',
    retryAdvice: { kind: 'never' },
    diagnosticId: 'model-wire-request',
  },
})

type UserBlock = Extract<RequestBody['messages'][number], { role: 'user' }>['content'][number]

/** Maps each verified part to the one user message that carries its source; nothing is dropped or guessed. */
function mediaBlocks(
  prepared: Wire.PreparedModelRequest,
  capture: ModelCapture,
  media: readonly ResolvedMedia[],
): Outcome<Map<number, UserBlock[]>> {
  const blocks = new Map<number, UserBlock[]>()
  if (prepared.mediaPlans.length !== media.length) return incompatible('model_wire_media')
  for (const [index, plan] of prepared.mediaPlans.entries()) {
    const resolved = media[index]
    if (
      !resolved ||
      resolved.planKey !== plan.key ||
      resolved.planDigest !== canonicalJsonDigest(plan as unknown as Wire.JsonValue)
    )
      return incompatible('model_wire_media')
    for (const part of resolved.parts) {
      const anchors = prepared.view.items.flatMap((item, at) =>
        item.kind === 'message' &&
        item.trust === 'user' &&
        item.sourceRefs.some((ref) => ref.kind === 'blob' && ref.value.blobId === part.anchor)
          ? [at]
          : [],
      )
      const anchor = anchors[0]
      if (anchors.length !== 1 || anchor === undefined) return incompatible('model_wire_media_anchor')
      if (
        part.kind === 'image' &&
        !(capture.model.input.includes('image') && prepared.target.features.input.includes('image'))
      )
        return incompatible('model_wire_media_feature')
      const block: UserBlock =
        part.kind === 'text'
          ? { type: 'text', text: part.text }
          : { type: 'image', data: part.data, mimeType: part.mimeType }
      blocks.set(anchor, [...(blocks.get(anchor) ?? []), block])
    }
  }
  return { ok: true, value: blocks }
}

/**
 * The wire request the adapter sends. First slice: plain text system and user messages, images and
 * verified media text on the user message that carries their source, and no tools.
 * Anything else is refused by name; a role is never guessed and an item is never dropped.
 */
export function buildWireRequest(
  prepared: Wire.PreparedModelRequest,
  capture: ModelCapture,
  wire: WireIdentity,
  media: readonly ResolvedMedia[] = [],
): Outcome<RequestBody> {
  if (prepared.toolCatalog !== null) return incompatible('model_wire_tools')
  if (prepared.outputSchema !== null) return incompatible('model_wire_output_schema')
  const attached = mediaBlocks(prepared, capture, media)
  if (!attached.ok) return attached
  if (prepared.hookResults !== null || prepared.legacyRequestOverrides !== null)
    return incompatible('model_wire_overrides')
  const { generation } = prepared
  if (generation.seed !== undefined) return incompatible('model_wire_seed')
  const system: string[] = []
  const messages: RequestBody['messages'] = []
  for (const [at, item] of prepared.view.items.entries()) {
    const text = item.body.kind === 'inline' && typeof item.body.value === 'string' ? item.body.value : null
    if (item.kind !== 'message' || text === null) return incompatible('model_wire_item')
    if (item.trust === 'system') system.push(text)
    else if (item.trust === 'user')
      messages.push({ role: 'user', content: [{ type: 'text', text }, ...(attached.value.get(at) ?? [])] })
    else return incompatible('model_wire_item')
  }
  if (messages.length === 0) return incompatible('model_wire_empty')
  const body = {
    kind: 'inference',
    sessionKey: wire.sessionKey,
    slot: wire.slot,
    route: capture.route.route,
    model: prepared.target.model,
    contractId: wire.contractId,
    derivedHash: modelInputDigest(prepared, capture, wire),
    system: system.join('\n\n'),
    messages,
    tools: [],
    sampling: {
      maxTokens: generation.maxOutputTokens,
      ...(generation.temperature === undefined ? {} : { temperature: generation.temperature }),
      ...(generation.thinking === null ? {} : { thinking: generation.thinking }),
    },
  }
  const checked = validateAgainst<RequestBody>(WireSchema, body)
  return checked.ok ? { ok: true, value: checked.value } : incompatible('model_wire_schema')
}
