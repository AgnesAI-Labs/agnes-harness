import type { Outcome } from '@agnes/extension-api/runtime'
import type { ModelRecord, RequestBody, SlotName } from '@agnes/protocol'
import { validateAgainst } from '@agnes/protocol'
import { RequestBody as WireSchema } from '@agnes/protocol/gen/model'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'

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

/**
 * The wire request the adapter sends. First slice: plain text system and user messages and no tools.
 * Anything else is refused by name; a role is never guessed and an item is never dropped.
 */
export function buildWireRequest(
  prepared: Wire.PreparedModelRequest,
  capture: ModelCapture,
  wire: WireIdentity,
): Outcome<RequestBody> {
  if (prepared.toolCatalog !== null) return incompatible('model_wire_tools')
  if (prepared.mediaPlans.length > 0) return incompatible('model_wire_media')
  if (prepared.hookResults !== null || prepared.legacyRequestOverrides !== null)
    return incompatible('model_wire_overrides')
  const { generation } = prepared
  if (generation.seed !== undefined) return incompatible('model_wire_seed')
  const system: string[] = []
  const messages: RequestBody['messages'] = []
  for (const item of prepared.view.items) {
    const text = item.body.kind === 'inline' && typeof item.body.value === 'string' ? item.body.value : null
    if (item.kind !== 'message' || text === null) return incompatible('model_wire_item')
    if (item.trust === 'system') system.push(text)
    else if (item.trust === 'user') messages.push({ role: 'user', content: [{ type: 'text', text }] })
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
