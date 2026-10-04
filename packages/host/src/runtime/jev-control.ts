import { CoreError } from '@agnes/core'
import type { IntentId } from '@agnes/jev-runtime'
import type { JsonValue } from '@agnes/protocol'

/** Match the reference SDK's strict UNKNOWN resolution payload at the runtime boundary. */
export function parseJevResolution(payload: JsonValue): {
  intentId: IntentId
  resolution: 'confirmed_applied' | 'confirmed_not_applied' | 'accepted_uncertainty'
  explanation: string
  evidence: string[]
} {
  const invalid = () =>
    new CoreError(
      'E_FORMAT',
      'UNKNOWN resolution requires intentId, resolution, non-empty explanation and evidence',
    )
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw invalid()
  const { intentId, resolution, explanation, evidence } = payload
  if (
    Object.keys(payload).some(
      (key) => !['intentId', 'resolution', 'explanation', 'evidence'].includes(key),
    ) ||
    typeof intentId !== 'string' ||
    intentId.length === 0 ||
    (resolution !== 'confirmed_applied' &&
      resolution !== 'confirmed_not_applied' &&
      resolution !== 'accepted_uncertainty') ||
    typeof explanation !== 'string' ||
    !explanation.trim() ||
    !Array.isArray(evidence) ||
    !evidence.length ||
    evidence.some((item) => typeof item !== 'string' || !item.trim())
  )
    throw invalid()
  return {
    intentId: intentId as IntentId,
    resolution,
    explanation: explanation.trim(),
    evidence: evidence.map((item) => String(item).trim()),
  }
}
