import type { ModelRecord, SlotName } from '@agnes/protocol'
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
