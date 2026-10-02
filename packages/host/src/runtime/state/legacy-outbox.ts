import type { OutboxRecord, RuntimeError } from '@agnes/protocol/runtime'
import { validateRuntime } from '@agnes/protocol/runtime'
import { integrity, refuse } from './refusal.js'

export type LegacyOutboxProfile = 'state85-outbox-created' | 'state85-outbox-delivery'
export type LegacyOutboxSource = Omit<OutboxRecord, 'consecutiveFailures' | 'lastError'> & {
  sessionId?: string
  sourceReceiptId?: string
}
const baseKeys = [
  'eventId',
  'sourceAuthorityId',
  'sourceCommitId',
  'destination',
  'typeId',
  'payload',
  'fingerprint',
  'delivery',
  'attempts',
  'nextAttemptAt',
  'claim',
  'ackRef',
] as const

/** Parse an explicitly selected historical profile; the caller must separately authenticate its source. */
export function decodeLegacyOutbox(profile: LegacyOutboxProfile, input: unknown): LegacyOutboxSource {
  const json = validateRuntime('JsonValue', input)
  if (!json.ok || json.value === null || typeof json.value !== 'object' || Array.isArray(json.value))
    integrity('legacy outbox source is not a JSON object')
  const value = json.value
  const keys =
    profile === 'state85-outbox-created' ? [...baseKeys, 'sessionId', 'sourceReceiptId'] : [...baseKeys]
  if (
    (profile !== 'state85-outbox-created' && profile !== 'state85-outbox-delivery') ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    integrity('legacy outbox source does not match its emitted profile')
  for (const key of [
    'eventId',
    'sourceAuthorityId',
    'sourceCommitId',
    'destination',
    'sessionId',
    'sourceReceiptId',
  ])
    if (Object.hasOwn(value, key) && !validateRuntime('Id', value[key]).ok)
      integrity('legacy outbox source has an invalid identity')
  if (
    !validateRuntime('TypeId', value.typeId).ok ||
    !validateRuntime('DataRef', value.payload).ok ||
    !validateRuntime('Digest', value.fingerprint).ok ||
    !validateRuntime('UInt53', value.attempts).ok ||
    !validateRuntime('Timestamp', value.nextAttemptAt).ok ||
    typeof value.delivery !== 'string' ||
    !['pending', 'claimed', 'acked', 'dead'].includes(value.delivery) ||
    (value.ackRef !== null && !validateRuntime('Id', value.ackRef).ok)
  )
    integrity('legacy outbox source has invalid delivery fields')
  if (value.claim !== null) {
    const claim = value.claim
    if (
      typeof claim !== 'object' ||
      Array.isArray(claim) ||
      Object.keys(claim).length !== 3 ||
      !Object.hasOwn(claim, 'ownerId') ||
      !Object.hasOwn(claim, 'epoch') ||
      !Object.hasOwn(claim, 'until') ||
      !validateRuntime('Id', claim.ownerId).ok ||
      !validateRuntime('UInt53', claim.epoch).ok ||
      !validateRuntime('Timestamp', claim.until).ok
    )
      integrity('legacy outbox source has an invalid claim')
  }
  if (
    profile === 'state85-outbox-created' &&
    (value.delivery !== 'pending' || value.attempts !== 0 || value.claim !== null || value.ackRef !== null)
  )
    integrity('legacy outbox creation profile cannot attest delivery progress')
  return value as LegacyOutboxSource
}

/** Supply only failure state already reconstructed from authenticated delivery history, never defaults. */
export function convertLegacyOutbox(
  source: LegacyOutboxSource,
  failureState: { consecutiveFailures: number; lastError: RuntimeError | null } | null,
): OutboxRecord {
  if (failureState === null)
    refuse('incompatible', 'unproven_history', 'legacy outbox failure history cannot be proved')
  const { sessionId: _sessionId, sourceReceiptId: _sourceReceiptId, ...delivery } = source
  const parsed = validateRuntime('OutboxRecord', {
    ...delivery,
    consecutiveFailures: failureState.consecutiveFailures,
    lastError: failureState.lastError,
  })
  if (!parsed.ok) integrity('reconstructed legacy outbox does not match the registered target')
  return parsed.value
}
