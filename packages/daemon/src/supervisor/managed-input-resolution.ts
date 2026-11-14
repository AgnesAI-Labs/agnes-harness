import { createHash } from 'node:crypto'
import type { ManagedSessionStartInput } from '@agnes/extension-api'
import type { HostInputResolution, ManagedInputSource } from './managed-input-admission.js'
import { MANAGED_INPUT_TEXT_LIMIT } from './managed-session-inputs.js'
import type { ManagedSessionRecord, ManagedSessionRecords } from './managed-session-records.js'

type Fields = Record<string, unknown>
const name = (value: unknown, max = 512): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')

function parseSource(value: unknown): ManagedInputSource | undefined {
  const source = value as Fields | null
  if (
    typeof source !== 'object' ||
    source === null ||
    !name(source.instanceId) ||
    !name(source.pairingId) ||
    !name(source.eventId) ||
    !name(source.messageId) ||
    (source.kind !== 'message' && source.kind !== 'action') ||
    (source.actionId !== undefined && !name(source.actionId)) ||
    !name(source.at, 64)
  )
    return undefined
  return {
    instanceId: source.instanceId,
    pairingId: source.pairingId,
    eventId: source.eventId,
    messageId: source.messageId,
    kind: source.kind,
    ...(source.actionId !== undefined ? { actionId: source.actionId as string } : {}),
    at: source.at,
  }
}

/**
 * The Host's receipt resolution from the request beside `args`. The daemon does not depend on the
 * Host's declaration of this shape, so it is checked here; anything malformed reads as no resolution,
 * which admits an `ownerMessage` as `needsOwner` (`receiptUnknown`) and stores no text.
 */
export function parseResolution(value: unknown): HostInputResolution | undefined {
  const resolution = value as Fields | null
  if (typeof resolution !== 'object' || resolution === null || !name(resolution.receiptId, 256))
    return undefined
  if (resolution.kind === 'unresolved')
    return resolution.reason === 'receiptUnknown' || resolution.reason === 'pairingChanged'
      ? { kind: 'unresolved', receiptId: resolution.receiptId, reason: resolution.reason }
      : undefined
  const source = parseSource(resolution.source)
  if (
    resolution.kind !== 'receipt' ||
    !source ||
    !name(resolution.text, MANAGED_INPUT_TEXT_LIMIT) ||
    Buffer.byteLength(resolution.text, 'utf8') > MANAGED_INPUT_TEXT_LIMIT ||
    !name(resolution.contentDigest, 256)
  )
    return undefined
  return {
    kind: 'receipt',
    receiptId: resolution.receiptId,
    text: resolution.text,
    contentDigest: resolution.contentDigest,
    source,
  }
}

/** `undefined` when absent, `false` when malformed. */
export function parseTaskBinding(value: unknown): { id: string; generation: number } | undefined | false {
  if (value === undefined) return undefined
  const binding = value as Fields | null
  return typeof binding === 'object' &&
    binding !== null &&
    name(binding.id, 256) &&
    Number.isSafeInteger(binding.generation) &&
    (binding.generation as number) >= 0
    ? { id: binding.id, generation: binding.generation as number }
    : false
}

export const startInputDigest = (input: string) => createHash('sha256').update(input).digest('hex')

/** The binding a new session is recorded with, in the same transaction as its record. */
export const newBinding = (input: ManagedSessionStartInput) =>
  input.taskBinding
    ? {
        taskId: input.taskBinding.id,
        taskGeneration: input.taskBinding.generation,
        inputDigest: startInputDigest(input.input),
      }
    : undefined

/**
 * Whether a repeated start may return the session its key opened. A bound session also compares the
 * binding and, when it was bound at start, the first input. An unbound one keeps the old comparison,
 * and a start naming a binding binds it now, without a first-input digest.
 */
export function startBindingMatches(
  records: Pick<ManagedSessionRecords, 'binding' | 'bindLate'>,
  record: ManagedSessionRecord,
  input: ManagedSessionStartInput,
): boolean {
  const wanted = input.taskBinding
  let bound = records.binding(record.sessionId)
  if (!bound && !wanted) return true
  if (!bound && wanted) {
    const late = { sessionId: record.sessionId, taskId: wanted.id, taskGeneration: wanted.generation }
    if (records.bindLate({ ...late, inputDigest: null })) return true
    bound = records.binding(record.sessionId)
  }
  return (
    bound !== undefined &&
    wanted !== undefined &&
    bound.taskId === wanted.id &&
    bound.taskGeneration === wanted.generation &&
    (bound.inputDigest === null || bound.inputDigest === startInputDigest(input.input))
  )
}
