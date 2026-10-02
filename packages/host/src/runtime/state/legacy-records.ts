import type {
  CommitSideEntry,
  JsonValue,
  RecordOwner,
  RuntimeWireTypes,
  SchemaRef,
} from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { decodeLegacyOutbox } from './legacy-outbox.js'
import { integrity, refuse } from './refusal.js'

export const legacyStateConversions = Object.freeze({
  SessionIdentityValue: 'V',
  RunRecordValue: 'V',
  RunTaintRecordValue: 'V',
  ActionRecordValue: 'V',
  AttemptRecordValue: 'V',
  RunQuotaValue: 'V',
  InvocationValue: 'V',
  PrepareQueryQuotaValue: 'V',
  QueryGrantValue: 'V',
  DispatchAdmissionRecordValue: 'V',
  ReceiptRecordValue: 'R',
  QuotaReservationMirrorValue: 'V',
  SignalRecordValue: 'S',
  ActionVisibilityValue: 'V',
  UsageMirrorValue: 'U',
  OutboxRecord: 'O',
  ReferenceRecordValue: 'F',
} as const)
export const legacyStateProfiles = Object.freeze({
  SessionIdentityValue: 'state85-session-identity-record',
  RunRecordValue: 'state85-run-record',
  RunTaintRecordValue: 'state85-run-taint-record',
  ActionRecordValue: 'state85-action-record',
  AttemptRecordValue: 'state85-attempt-record',
  RunQuotaValue: 'state85-run-quota',
  InvocationValue: 'state85-invocation',
  PrepareQueryQuotaValue: 'state85-prepare-query-quota',
  QueryGrantValue: 'state85-query-grant',
  DispatchAdmissionRecordValue: 'state85-dispatch-admission',
  ReceiptRecordValue: 'state85-receipt-record',
  QuotaReservationMirrorValue: 'state85-quota-mirror',
  SignalRecordValue: 'state85-signal-record',
  ActionVisibilityValue: 'state85-action-visibility',
  UsageMirrorValue: 'state85-usage-mirror',
  OutboxRecord: 'state85-outbox-created',
  ReferenceRecordValue: 'state85-reference-record',
} as const)
export type LegacyStateDefinition = keyof typeof legacyStateConversions
export type LegacyStateEntry = {
  readonly source: SchemaRef
  readonly targetDefinition: LegacyStateDefinition
  readonly targetRevision: number
  readonly decoderProfile: string
  readonly conversionRule: 'V' | 'R' | 'S' | 'U' | 'O' | 'F'
}

/** Source identity and body are taken from immutable versions, never request-result caches. */
export type LegacyStateSource = {
  readonly schema: SchemaRef
  readonly minReader: number
  readonly physicalSessionId: string
  readonly recordId: string
  readonly recordRevision: number
  readonly commitId: string
  readonly eventId: string
  readonly owner: RecordOwner
  readonly value: JsonValue
  readonly digest: string
  readonly sideEntries: readonly CommitSideEntry[]
}
export type DecodedLegacyStateRecord = {
  readonly definition: LegacyStateDefinition
  readonly value: JsonValue
  readonly source: LegacyStateSource
}
export type LegacySourceVerifier = (source: LegacyStateSource) => void

/** The injected verifier must prove physical owner, chain, manifest and current read authority. */
export function createLegacyStateDecoder(entries: readonly LegacyStateEntry[], verify: LegacySourceVerifier) {
  if (typeof verify !== 'function' || entries.length !== Object.keys(legacyStateConversions).length)
    integrity('incomplete legacy State reader registration')
  const byRef = new Map<string, LegacyStateEntry>(),
    targets = new Set<string>()
  for (const entry of entries) {
    if (
      !Object.hasOwn(legacyStateConversions, entry.targetDefinition) ||
      legacyStateConversions[entry.targetDefinition] !== entry.conversionRule ||
      !validateRuntime('SchemaRef', entry.source).ok ||
      entry.source.revision !== 1 ||
      !Number.isSafeInteger(entry.targetRevision) ||
      entry.targetRevision < 2 ||
      entry.decoderProfile !== legacyStateProfiles[entry.targetDefinition] ||
      targets.has(entry.targetDefinition) ||
      byRef.has(refKey(entry.source))
    )
      integrity('invalid legacy State reader registration')
    targets.add(entry.targetDefinition)
    byRef.set(refKey(entry.source), Object.freeze({ ...entry, source: Object.freeze({ ...entry.source }) }))
  }
  const tokens = new WeakMap<object, LegacyStateEntry>()
  return Object.freeze({
    decode(input: LegacyStateSource): DecodedLegacyStateRecord {
      const json = validateRuntime('JsonValue', input)
      if (!json.ok) integrity('invalid legacy State source JSON')
      const source = json.value as unknown as LegacyStateSource
      assertSourceShape(source)
      const entry = byRef.get(refKey(source.schema))
      if (!entry) refuse('incompatible', 'unknown_schema', 'unknown complete legacy State schema reference')
      // A correct self hash is necessary, but it is never an alternative to the trusted verifier.
      synchronousLegacyCheck(() => verify(source))
      const value = decodeBody(entry, source.value)
      deepFreeze(source)
      deepFreeze(value)
      const decoded = Object.freeze({ definition: entry.targetDefinition, value, source })
      tokens.set(decoded, entry)
      return decoded
    },
    authenticate(decoded: DecodedLegacyStateRecord): LegacyStateEntry {
      const entry = tokens.get(decoded)
      if (!entry) integrity('legacy State value was not decoded by this source registry')
      synchronousLegacyCheck(() => verify(decoded.source))
      return entry
    },
  })
}

function assertSourceShape(source: LegacyStateSource): void {
  if (
    !source ||
    !validateRuntime('SchemaRef', source.schema).ok ||
    source.minReader !== 1 ||
    !validateRuntime('RecordOwner', source.owner).ok ||
    !validateRuntime('Digest', source.digest).ok ||
    !validateRuntime('UInt53', source.recordRevision).ok ||
    source.recordRevision < 1 ||
    ![source.physicalSessionId, source.recordId, source.commitId, source.eventId].every(
      (id) => validateRuntime('Id', id).ok,
    ) ||
    !Array.isArray(source.sideEntries) ||
    source.sideEntries.some(
      (side) => !validateRuntime('CommitSideEntry', side).ok || side.commitId !== source.commitId,
    )
  )
    integrity('invalid legacy State source version')
  if (
    canonicalJsonDigest({ owner: source.owner as unknown as JsonValue, value: source.value }) !==
    source.digest
  )
    integrity('legacy State source body digest mismatch')
}

function decodeBody(entry: LegacyStateEntry, value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    integrity('legacy State value is not a record object')
  if (entry.conversionRule === 'V') {
    if (entry.targetDefinition === 'SessionIdentityValue' && value.minReader !== 1)
      refuse('incompatible', 'unknown_reader', 'unsupported historical State session reader')
    return checked(entry.targetDefinition, value)
  }
  if (entry.conversionRule === 'O')
    return decodeLegacyOutbox('state85-outbox-created', value) as unknown as JsonValue
  if (entry.conversionRule === 'R') {
    const { intakeId, contentFingerprint, ...base } = value
    if (
      (Object.hasOwn(value, 'intakeId') && intakeId !== null && !validateRuntime('Id', intakeId).ok) ||
      (Object.hasOwn(value, 'contentFingerprint') &&
        contentFingerprint !== null &&
        !validateRuntime('Digest', contentFingerprint).ok) ||
      Object.hasOwn(value, 'intakeId') !== Object.hasOwn(value, 'contentFingerprint')
    )
      integrity('invalid legacy receipt intake identity')
    checked('ReceiptRecordValue', base)
    return value
  }
  if (entry.conversionRule === 'S') {
    const { sourceReceiptId, ...base } = value
    if (!validateRuntime('Id', sourceReceiptId).ok) integrity('invalid legacy signal receipt source')
    checked('SignalRecordValue', base)
    return value
  }
  if (entry.conversionRule === 'U') {
    assertKeys(value, ['usageId', 'sourceAuthorityId', 'originKey', 'usage', 'status'])
    if (
      ![value.usageId, value.sourceAuthorityId].every((id) => validateRuntime('Id', id).ok) ||
      typeof value.originKey !== 'string' ||
      value.status !== 'recorded' ||
      !validateRuntime('UsageFact', value.usage).ok
    )
      integrity('invalid legacy usage source profile')
    const usage = value.usage as unknown as RuntimeWireTypes['UsageFact']
    if (usage.originKey !== value.originKey) integrity('legacy usage origin does not match its fact')
    return value
  }
  assertKeys(value, ['referenceId', 'status', 'target'])
  if (
    !validateRuntime('Id', value.referenceId).ok ||
    value.status !== 'confirmed' ||
    !validateRuntime('RetentionRef', value.target).ok
  )
    integrity('invalid legacy retention source profile')
  return value
}

export function checked<K extends keyof RuntimeWireTypes>(
  definition: K,
  input: unknown,
): RuntimeWireTypes[K] {
  const parsed = validateRuntime(definition, input)
  if (!parsed.ok) refuse('incompatible', 'legacy_profile', `legacy State value does not match ${definition}`)
  return parsed.value
}
export function assertKeys(value: Record<string, JsonValue>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    integrity('legacy State emitted profile has missing or unknown fields')
}
function refKey(ref: SchemaRef): string {
  return JSON.stringify([ref?.typeId, ref?.revision, ref?.digest])
}
function deepFreeze(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
}

/** Async or boolean-returning checks cannot silently become proof or permission. */
export function synchronousLegacyCheck(check: () => void): void {
  const result: unknown = check()
  if (result !== undefined)
    refuse(
      'internal',
      'invalid_verifier',
      'legacy State verifier must finish synchronously and throw on rejection',
    )
}
