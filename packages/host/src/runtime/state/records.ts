import { hash } from 'node:crypto'
import type { SchemaRef, StateAuthorityRef } from '@agnes/extension-api/runtime'
import {
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  RuntimeStateLegacyReaders,
  type RuntimeWireTypes,
} from '@agnes/protocol/runtime'
import { canonicalJson } from './canonical-json.js'
import { noteSha, profiling } from './profile.js'

/** Registered session-ledger proofs. Rows are appended in the session database. */
export const FORMAT_EVENT = 'runtime/format'
export const STATE_COMMIT_EVENT = 'runtime/state-commit'
export const LEDGER_INTEGRITY_ALGORITHM = 'agnes-ledger-jcs-sha256-v1'
export const FORMAT_VERSION = 2
export const RUNTIME_SCHEMA_MAJOR = 1
export const MIN_READER = 2

export type RecordOwner = {
  authority: StateAuthorityRef
  scope: unknown
  ownerBinding: {
    bindingId: string
    contract: string
    logicalName: string
    providerId: string
  }
}

export type SessionIdentityValue = {
  sessionId: string
  workspaceId: string
  formatVersion: 2
  runtimeSchemaMajor: 1
  minReader: number
  parent: null | { sessionId: string; boundarySeq: number; boundaryDigest: string | null }
}

export type RunRecordValue = {
  runId: string
  sessionId: string
  lane: string
  admissionTicketId: string
  bindingId: string
  input: unknown
  conversation: unknown
  deadline: string
  revision: number
  state: string
  continuation: unknown
  writerEpoch: number
  waitId: unknown
  cancellation: unknown
  terminal: unknown
  suspension: unknown
}

export type RunTaintValue = {
  runId: string
  sourceSeq: number
  clearedThroughSeq: number
}

export type StoredRecord = {
  recordId: string
  schema: SchemaRef
  minReader: number
  recordRevision: number
  owner: RecordOwner
  value: unknown
}

export type MutationNext = {
  recordRevision: number
  schema: SchemaRef
  digest: string
}

export type CommitMutationManifest = {
  commitId: string
  recordId: string
  previousRevision: number | null
  next: MutationNext | null
}

export type CommitSideEntry =
  | { commitId: string; kind: 'action-created'; actionId: string }
  | { commitId: string; kind: 'signal-consumed'; signalId: string }
  | { commitId: string; kind: 'outbox-created'; eventId: string }
  | { commitId: string; kind: 'receipt-created'; receiptId: string }
  | { commitId: string; kind: 'usage-origin'; sourceAuthorityId: string; originKey: string }

export type RuntimeCommitData = {
  commitId: string
  transactionFingerprint: string
  runId: string | null
  actionId: string | null
  authorityEpoch: number
  writerEpoch: number
  previousCommitId: string | null
  mutationsDigest: string
  mutationCount: number
  sideListsDigest: string
  counts: {
    createdActions: number
    consumedSignals: number
    outboxEvents: number
    receipts: number
    usageOrigins: number
  }
}

export type FormatEventData = {
  formatVersion: 2
  runtimeSchemaMajor: 1
  minReader: 1 | 2
  previousFormat: 1 | 2
  legacyThroughSeq: number
  sourceHeadDigest: string | null
}

export type LedgerEvent = {
  seq: number
  ts: string
  id: string
  type: string
  lane: string
  v: number
  actor: { id: string; org: string; role: string; deptPath: string[]; attrs: Record<string, never> }
  origin: string
  trust: string
  data: unknown
}

export type IntegrityMetadata = {
  mode: 'anchor' | 'chain'
  previousDigest: string | null
  digest: string
}

export type IntegrityState = {
  lastSeq: number
  legacyThroughSeq: number
  headDigest: string | null
}

export const RUNTIME_ACTOR: LedgerEvent['actor'] = {
  id: 'runtime-state',
  org: 'agnes',
  role: 'system',
  deptPath: [],
  attrs: {},
}

export function digestOf(value: unknown): string {
  return digestText(canonicalJson(value))
}

function digestText(text: string): string {
  if (!profiling) return hash('sha256', text, 'hex')
  const started = performance.now()
  const digest = hash('sha256', text, 'hex')
  noteSha(performance.now() - started, Buffer.byteLength(text))
  return digest
}

/** sha256 of the JCS object `{"owner":<ownerJson>,"value":<valueJson>}`. Matches `bodyDigest` when both texts are already canonical. */
export function canonicalStoredBodyDigest(ownerJson: string, valueJson: string): string {
  return digestText(`{"owner":${ownerJson},"value":${valueJson}}`)
}

export type EncodedStoredRecord = {
  schemaJson: string
  ownerJson: string
  valueJson: string
  digest: string
}

/** One JCS pass over schema, owner, and value. The digest matches `bodyDigest(owner, value)`. */
export function encodeStoredRecord(record: {
  schema: SchemaRef
  owner: RecordOwner
  value: unknown
}): EncodedStoredRecord {
  const schemaJson = canonicalJson(record.schema)
  const ownerJson = canonicalJson(record.owner)
  const valueJson = canonicalJson(record.value)
  return {
    schemaJson,
    ownerJson,
    valueJson,
    digest: canonicalStoredBodyDigest(ownerJson, valueJson),
  }
}

/** Canonical JSON of a mutation `next` when `schemaJson` is already the canonical schema. */
export function storedMutationNextJson(recordRevision: number, digest: string, schemaJson: string): string {
  return `{"digest":${JSON.stringify(digest)},"recordRevision":${JSON.stringify(recordRevision)},"schema":${schemaJson}}`
}

export const SESSION_IDENTITY_SCHEMA = RuntimeSchemaRefs.SessionIdentityValue
export const RUN_RECORD_SCHEMA = RuntimeSchemaRefs.RunRecordValue
export const RUN_BINDING_SCHEMA = RuntimeSchemaRefs.RunBinding
export const RUN_TAINT_SCHEMA = RuntimeSchemaRefs.RunTaintRecordValue
export const ACTION_SCHEMA = RuntimeSchemaRefs.ActionRecordValue
export const ATTEMPT_SCHEMA = RuntimeSchemaRefs.AttemptRecordValue
export const RUN_QUOTA_SCHEMA = RuntimeSchemaRefs.RunQuotaValue
export const INVOCATION_SCHEMA = RuntimeSchemaRefs.InvocationValue
export const PREPARE_QUOTA_SCHEMA = RuntimeSchemaRefs.PrepareQueryQuotaValue
export const QUERY_GRANT_SCHEMA = RuntimeSchemaRefs.QueryGrantValue
export const DISPATCH_ADMISSION_SCHEMA = RuntimeSchemaRefs.DispatchAdmissionRecordValue
export const RECEIPT_SCHEMA = RuntimeSchemaRefs.ReceiptRecordValue
export const QUOTA_MIRROR_SCHEMA = RuntimeSchemaRefs.QuotaReservationMirrorValue
export const SIGNAL_SCHEMA = RuntimeSchemaRefs.SignalRecordValue
export const VISIBILITY_SCHEMA = RuntimeSchemaRefs.ActionVisibilityValue
export const USAGE_MIRROR_SCHEMA = RuntimeSchemaRefs.UsageMirrorValue
export const OUTBOX_SCHEMA = RuntimeSchemaRefs.OutboxRecord
export const REFERENCE_SCHEMA = RuntimeSchemaRefs.ReferenceRecordValue
export const STATE_LEASE_SCHEMA = RuntimeSchemaRefs.StateLeaseRecordValue
export const STATE_OPEN_PROOF_SCHEMA = RuntimeSchemaRefs.StateWriteOpenProofValue
export const STATE_LEASE_PROOF_SCHEMA = RuntimeSchemaRefs.StateLeaseProofValue
export const INTERACTION_SCHEMA = RuntimeSchemaRefs.InteractionRecord
export const INBOX_SCHEMA = RuntimeSchemaRefs.InboxRecord
export const APPROVAL_TAINT_ACK_SCHEMA = RuntimeSchemaRefs.ApprovalTaintAckRecordValue
export const AUTHORIZATION_PREPARATION_SCHEMA = RuntimeSchemaRefs.AuthorizationPreparation
export const APPROVAL_RESPONSE_SOURCE_SCHEMA = RuntimeSchemaRefs.ApprovalRespondRequest
export const CONTROL_REQUEST_SOURCE_SCHEMA = RuntimeSchemaRefs.CommitControlRequest
/** Official supervisor method fullrefs are the stored SessionControl payload codecs. */
export const SESSION_CONTROL_REQUEST_SCHEMA =
  RuntimeMethodSchemaRefs['agh.supervisor'].submitSessionControl.input
export const SESSION_CONTROL_RESULT_SCHEMA =
  RuntimeMethodSchemaRefs['agh.supervisor'].submitSessionControl.output
export const SESSION_CONTROL_STATE_SCHEMA =
  RuntimeMethodSchemaRefs['agh.supervisor'].readSessionControl.output

const SCHEMAS: Readonly<Record<string, SchemaRef>> = {
  [SESSION_IDENTITY_SCHEMA.typeId]: SESSION_IDENTITY_SCHEMA,
  [RUN_RECORD_SCHEMA.typeId]: RUN_RECORD_SCHEMA,
  [RUN_BINDING_SCHEMA.typeId]: RUN_BINDING_SCHEMA,
  [RUN_TAINT_SCHEMA.typeId]: RUN_TAINT_SCHEMA,
  [ACTION_SCHEMA.typeId]: ACTION_SCHEMA,
  [ATTEMPT_SCHEMA.typeId]: ATTEMPT_SCHEMA,
  [RUN_QUOTA_SCHEMA.typeId]: RUN_QUOTA_SCHEMA,
  [INVOCATION_SCHEMA.typeId]: INVOCATION_SCHEMA,
  [PREPARE_QUOTA_SCHEMA.typeId]: PREPARE_QUOTA_SCHEMA,
  [QUERY_GRANT_SCHEMA.typeId]: QUERY_GRANT_SCHEMA,
  [DISPATCH_ADMISSION_SCHEMA.typeId]: DISPATCH_ADMISSION_SCHEMA,
  [RECEIPT_SCHEMA.typeId]: RECEIPT_SCHEMA,
  [QUOTA_MIRROR_SCHEMA.typeId]: QUOTA_MIRROR_SCHEMA,
  [SIGNAL_SCHEMA.typeId]: SIGNAL_SCHEMA,
  [VISIBILITY_SCHEMA.typeId]: VISIBILITY_SCHEMA,
  [USAGE_MIRROR_SCHEMA.typeId]: USAGE_MIRROR_SCHEMA,
  [OUTBOX_SCHEMA.typeId]: OUTBOX_SCHEMA,
  [REFERENCE_SCHEMA.typeId]: REFERENCE_SCHEMA,
  [STATE_LEASE_SCHEMA.typeId]: STATE_LEASE_SCHEMA,
  [STATE_OPEN_PROOF_SCHEMA.typeId]: STATE_OPEN_PROOF_SCHEMA,
  [STATE_LEASE_PROOF_SCHEMA.typeId]: STATE_LEASE_PROOF_SCHEMA,
  [INTERACTION_SCHEMA.typeId]: INTERACTION_SCHEMA,
  [INBOX_SCHEMA.typeId]: INBOX_SCHEMA,
  [APPROVAL_TAINT_ACK_SCHEMA.typeId]: APPROVAL_TAINT_ACK_SCHEMA,
  [AUTHORIZATION_PREPARATION_SCHEMA.typeId]: AUTHORIZATION_PREPARATION_SCHEMA,
  [APPROVAL_RESPONSE_SOURCE_SCHEMA.typeId]: APPROVAL_RESPONSE_SOURCE_SCHEMA,
  [CONTROL_REQUEST_SOURCE_SCHEMA.typeId]: CONTROL_REQUEST_SOURCE_SCHEMA,
  [SESSION_CONTROL_REQUEST_SCHEMA.typeId]: SESSION_CONTROL_REQUEST_SCHEMA,
  [SESSION_CONTROL_RESULT_SCHEMA.typeId]: SESSION_CONTROL_RESULT_SCHEMA,
  [SESSION_CONTROL_STATE_SCHEMA.typeId]: SESSION_CONTROL_STATE_SCHEMA,
}

export function sessionIdentityRecordId(sessionId: string): string {
  return `session-identity:${sessionId}`
}

export function runRecordId(runId: string): string {
  return `run:${runId}`
}

export function runBindingRecordId(runId: string): string {
  return `run-binding:${runId}`
}

export function taintRecordId(runId: string): string {
  return `taint:${runId}`
}

export function actionRecordId(actionId: string): string {
  return `action:${actionId}`
}

export function attemptRecordId(attemptId: string): string {
  return `attempt:${attemptId}`
}

export function dispatchRecordId(admissionId: string): string {
  return `dispatch:${admissionId}`
}

export function receiptRecordId(receiptId: string): string {
  return `receipt:${receiptId}`
}

export function quotaRecordId(reservationId: string): string {
  return `quota:${reservationId}`
}

export function invocationRecordId(invocationId: string): string {
  return `invocation:${invocationId}`
}

export function prepareRecordId(prepareId: string): string {
  return `prepare:${prepareId}`
}

export function grantRecordId(grantId: string): string {
  return `grant:${grantId}`
}

export function runQuotaRecordId(runId: string): string {
  return `run-quota:${runId}`
}

export function signalRecordId(signalId: string): string {
  return `signal:${signalId}`
}

export function visibilityRecordId(sourceReceiptId: string): string {
  return `visibility:${sourceReceiptId}`
}

export function usageMirrorRecordId(usageId: string): string {
  return `usage:${usageId}`
}

export function outboxRecordId(eventId: string): string {
  return `outbox:${eventId}`
}

export function referenceRecordId(referenceId: string): string {
  return `reference:${referenceId}`
}

export function stableId(prefix: string, material: string): string {
  return `${prefix}-${digestText(material).slice(0, 40)}`
}

export function bodyDigest(owner: RecordOwner, value: unknown): string {
  return digestOf({ owner, value })
}

export function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

export function mutationDigest(manifests: readonly CommitMutationManifest[]): string {
  const encoded = canonicalMutations(manifests)
  if (encoded !== null) return digestText(encoded)
  const body = manifests
    .map((manifest) => ({
      recordId: manifest.recordId,
      previousRevision: manifest.previousRevision,
      next: manifest.next,
    }))
    .sort((left, right) => compareUtf8(left.recordId, right.recordId))
  return digestOf(body)
}

function canonicalMutations(manifests: readonly CommitMutationManifest[]): string | null {
  const ordered =
    manifests.length < 2
      ? manifests
      : [...manifests].sort((left, right) => compareUtf8(left.recordId, right.recordId))
  let encoded = '['
  for (let index = 0; index < ordered.length; index++) {
    const manifest = ordered[index]
    if (!manifest || !jsonString(manifest.recordId)) return null
    const previous = manifest.previousRevision === null ? 'null' : jsonNumber(manifest.previousRevision)
    if (previous === null) return null
    const next = canonicalNext(manifest.next)
    if (next === null) return null
    if (index > 0) encoded += ','
    encoded += `{"next":${next},"previousRevision":${previous},"recordId":${JSON.stringify(manifest.recordId)}}`
  }
  return `${encoded}]`
}

function canonicalNext(next: MutationNext | null): string | null {
  if (next === null) return 'null'
  if (Object.keys(next).length !== 3 || !jsonString(next.digest)) return null
  const revision = jsonNumber(next.recordRevision)
  const schema = canonicalSchema(next.schema)
  if (revision === null || schema === null) return null
  return `{"digest":${JSON.stringify(next.digest)},"recordRevision":${revision},"schema":${schema}}`
}

function canonicalSchema(schema: SchemaRef): string | null {
  if (Object.keys(schema).length !== 3 || !jsonString(schema.typeId) || !jsonString(schema.digest))
    return null
  const revision = jsonNumber(schema.revision)
  if (revision === null) return null
  return `{"digest":${JSON.stringify(schema.digest)},"revision":${revision},"typeId":${JSON.stringify(schema.typeId)}}`
}

function jsonNumber(value: number): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return JSON.stringify(value)
}

function jsonString(value: string): boolean {
  if (typeof value !== 'string') return false
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

export function sideEntryIdentity(entry: CommitSideEntry): string {
  return sideIdentity(entry).slice(1).join('\0')
}

function sideIdentity(entry: CommitSideEntry): readonly string[] {
  switch (entry.kind) {
    case 'action-created':
      return [entry.kind, entry.actionId]
    case 'signal-consumed':
      return [entry.kind, entry.signalId]
    case 'outbox-created':
      return [entry.kind, entry.eventId]
    case 'receipt-created':
      return [entry.kind, entry.receiptId]
    case 'usage-origin':
      return [entry.kind, entry.sourceAuthorityId, entry.originKey]
  }
}

function compareIdentity(left: readonly string[], right: readonly string[]): number {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index++) {
    const compared = compareUtf8(left[index] ?? '', right[index] ?? '')
    if (compared !== 0) return compared
  }
  return 0
}

let emptySideDigest: string | undefined

export function sideListsDigest(entries: readonly CommitSideEntry[]): string {
  if (entries.length === 0) {
    emptySideDigest ??= digestOf([])
    return emptySideDigest
  }
  const body = [...entries]
    .sort((left, right) => compareIdentity(sideIdentity(left), sideIdentity(right)))
    .map((entry) => {
      const { commitId: _commitId, ...rest } = entry
      return rest
    })
  return digestOf(body)
}

export function sameSideCounts(
  left: RuntimeCommitData['counts'],
  right: RuntimeCommitData['counts'],
): boolean {
  return (
    left.createdActions === right.createdActions &&
    left.consumedSignals === right.consumedSignals &&
    left.outboxEvents === right.outboxEvents &&
    left.receipts === right.receipts &&
    left.usageOrigins === right.usageOrigins
  )
}

export function sideCounts(entries: readonly CommitSideEntry[]): RuntimeCommitData['counts'] {
  const counts = { createdActions: 0, consumedSignals: 0, outboxEvents: 0, receipts: 0, usageOrigins: 0 }
  for (const entry of entries) {
    if (entry.kind === 'action-created') counts.createdActions++
    else if (entry.kind === 'signal-consumed') counts.consumedSignals++
    else if (entry.kind === 'outbox-created') counts.outboxEvents++
    else if (entry.kind === 'receipt-created') counts.receipts++
    else counts.usageOrigins++
  }
  return counts
}

export function createManifest(
  commitId: string,
  record: StoredRecord,
  previousRevision: number | null = null,
  digest?: string,
): CommitMutationManifest {
  return {
    commitId,
    recordId: record.recordId,
    previousRevision,
    next: {
      recordRevision: record.recordRevision,
      schema: record.schema,
      digest: digest ?? bodyDigest(record.owner, record.value),
    },
  }
}

function anchorDigest(sessionKey: string, legacyThroughSeq: number, event: LedgerEvent): string {
  return digestOf({ algorithm: LEDGER_INTEGRITY_ALGORITHM, sessionKey, legacyThroughSeq, event })
}

function chainDigest(sessionKey: string, previousDigest: string, event: LedgerEvent): string {
  return digestOf({ algorithm: LEDGER_INTEGRITY_ALGORITHM, sessionKey, previousDigest, event })
}

export function protectEvent(
  sessionKey: string,
  event: LedgerEvent,
  state: IntegrityState,
): { integrity: IntegrityMetadata; state: IntegrityState } {
  if (event.seq !== state.lastSeq + 1) throw new Error('append sequence is not contiguous')
  const integrity: IntegrityMetadata =
    state.headDigest === null
      ? {
          mode: 'anchor',
          previousDigest: null,
          digest: anchorDigest(sessionKey, state.legacyThroughSeq, event),
        }
      : {
          mode: 'chain',
          previousDigest: state.headDigest,
          digest: chainDigest(sessionKey, state.headDigest, event),
        }
  return {
    integrity,
    state: { ...state, lastSeq: event.seq, headDigest: integrity.digest },
  }
}

export type ChainRow = { event: LedgerEvent; integrity: IntegrityMetadata | null }

export function knownSchema(typeId: string): SchemaRef | undefined {
  return SCHEMAS[typeId]
}

const registeredSchemas = [
  ...Object.values(SCHEMAS),
  ...RuntimeStateLegacyReaders.entries.map((entry) => entry.source),
]
const registeredSchemaTexts = new Set(registeredSchemas.map((schema) => canonicalJson(schema)))

/** Exact fullref matching includes historical provenance, without treating tag documents as payload codecs. */
export function matchesKnownSchema(schema: unknown): boolean {
  if (
    schema === null ||
    typeof schema !== 'object' ||
    Array.isArray(schema) ||
    Object.keys(schema).length !== 3
  )
    return false
  const value = schema as SchemaRef
  return registeredSchemas.some(
    (ref) => ref.typeId === value.typeId && ref.revision === value.revision && ref.digest === value.digest,
  )
}
export function matchesKnownSchemaText(text: string): boolean {
  if (registeredSchemaTexts.has(text)) return true
  try {
    return matchesKnownSchema(JSON.parse(text))
  } catch {
    return false
  }
}
export function stateSchemaReader(schema: SchemaRef): 1 | 2 {
  return RuntimeStateLegacyReaders.entries.some((entry) => sameJson(entry.source, schema)) ? 1 : 2
}
const stateDefinitions = new Map<string, keyof RuntimeWireTypes>([
  ...Object.entries(RuntimeSchemaRefs)
    .filter(([_name, ref]) => SCHEMAS[ref.typeId])
    .map(([name, ref]) => [canonicalJson(ref), name as keyof typeof RuntimeSchemaRefs] as const),
  [canonicalJson(SESSION_CONTROL_REQUEST_SCHEMA), 'SessionControlRequest'],
  [canonicalJson(SESSION_CONTROL_RESULT_SCHEMA), 'SessionControlResult'],
  [canonicalJson(SESSION_CONTROL_STATE_SCHEMA), 'SessionControlState'],
])
export function stateSchemaDefinition(schema: SchemaRef): keyof RuntimeWireTypes | undefined {
  return stateDefinitions.get(canonicalJson(schema))
}

export function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

export function emptyIntegrity(): IntegrityState {
  return { lastSeq: 0, legacyThroughSeq: 0, headDigest: null }
}

export function isSideEntry(value: unknown): value is CommitSideEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as CommitSideEntry
  if (typeof entry.commitId !== 'string') return false
  switch (entry.kind) {
    case 'action-created':
      return typeof entry.actionId === 'string'
    case 'signal-consumed':
      return typeof entry.signalId === 'string'
    case 'outbox-created':
      return typeof entry.eventId === 'string'
    case 'receipt-created':
      return typeof entry.receiptId === 'string'
    case 'usage-origin':
      return typeof entry.sourceAuthorityId === 'string' && typeof entry.originKey === 'string'
    default:
      return false
  }
}
