import { hash } from 'node:crypto'
import type { SchemaRef, StateAuthorityRef } from '@agnes/extension-api/runtime'
import { canonicalJson } from './canonical-json.js'
import { noteSha, profiling } from './profile.js'

/** Registered session-ledger proofs. Rows are appended in the session database. */
export const FORMAT_EVENT = 'runtime/format'
export const STATE_COMMIT_EVENT = 'runtime/state-commit'
export const LEDGER_INTEGRITY_ALGORITHM = 'agnes-ledger-jcs-sha256-v1'
export const FORMAT_VERSION = 2
export const RUNTIME_SCHEMA_MAJOR = 1
export const MIN_READER = 1

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
  minReader: 1
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

const sessionIdentitySchema = {
  $id: 'agh.runtime/session-identity-record.value',
  type: 'object',
  additionalProperties: false,
  required: ['sessionId', 'workspaceId', 'formatVersion', 'runtimeSchemaMajor', 'minReader', 'parent'],
  properties: {
    sessionId: { type: 'string' },
    workspaceId: { type: 'string' },
    formatVersion: { const: 2 },
    runtimeSchemaMajor: { const: 1 },
    minReader: { type: 'integer', minimum: 0 },
    parent: {},
  },
}

const runRecordSchema = {
  $id: 'agh.runtime/run-record.value',
  type: 'object',
  additionalProperties: false,
  required: [
    'runId',
    'sessionId',
    'lane',
    'admissionTicketId',
    'bindingId',
    'input',
    'conversation',
    'deadline',
    'revision',
    'state',
    'continuation',
    'writerEpoch',
    'waitId',
    'cancellation',
    'terminal',
    'suspension',
  ],
  properties: {
    runId: { type: 'string' },
    sessionId: { type: 'string' },
    lane: { type: 'string' },
    admissionTicketId: { type: 'string' },
    bindingId: { type: 'string' },
    input: {},
    conversation: {},
    deadline: { type: 'string' },
    revision: { type: 'integer', minimum: 0 },
    state: {
      enum: [
        'admitted',
        'runnable',
        'waiting',
        'failing',
        'cancelling',
        'draining',
        'succeeded',
        'failed',
        'cancelled',
        'frozen',
        'migrating',
        'blocked_incompatible',
        'blocked_integrity',
      ],
    },
    continuation: {},
    writerEpoch: { type: 'integer', minimum: 0 },
    waitId: {},
    cancellation: {},
    terminal: {},
    suspension: {},
  },
}

const runTaintSchema = {
  $id: 'agh.runtime/run-taint-record.value',
  type: 'object',
  additionalProperties: false,
  required: ['runId', 'sourceSeq', 'clearedThroughSeq'],
  properties: {
    runId: { type: 'string' },
    sourceSeq: { type: 'integer', minimum: 0 },
    clearedThroughSeq: { type: 'integer', minimum: 0 },
  },
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

function schemaRef(typeId: string, document: unknown): SchemaRef {
  return { typeId, revision: 1, digest: digestOf(document) }
}

function recordSchema(id: string, required: readonly string[]) {
  const properties: Record<string, { type: 'string' }> = {}
  for (const key of required) properties[key] = { type: 'string' }
  return {
    $id: id,
    type: 'object' as const,
    additionalProperties: false,
    required: [...required],
    properties,
  }
}

const actionRecordSchema = recordSchema('agh.runtime/action-record.value', ['actionId', 'runId'])
const attemptRecordSchema = recordSchema('agh.runtime/attempt-record.value', ['attemptId', 'actionId'])
const runQuotaSchema = recordSchema('agh.runtime/run-quota.value', ['runId'])
const invocationSchema = recordSchema('agh.runtime/invocation.value', ['invocationId', 'runId'])
const prepareQuotaSchema = recordSchema('agh.runtime/prepare-query-quota.value', ['prepareId', 'runId'])
const queryGrantSchema = recordSchema('agh.runtime/query-grant.value', ['grantId', 'invocationId'])
const dispatchAdmissionSchema = recordSchema('agh.runtime/dispatch-admission.value', ['admissionId'])
const receiptRecordSchema = recordSchema('agh.runtime/receipt-record.value', ['receipt'])
const quotaMirrorSchema = recordSchema('agh.runtime/quota-mirror.value', ['reservationId'])
const signalRecordSchema = recordSchema('agh.runtime/signal-record.value', ['signalId'])
const actionVisibilitySchema = recordSchema('agh.runtime/action-visibility.value', [
  'actionId',
  'sourceReceiptId',
])
const usageMirrorSchema = recordSchema('agh.runtime/usage-mirror.value', ['usageId'])
const outboxRecordSchema = recordSchema('agh.runtime/outbox-record.value', ['eventId'])
const referenceRecordSchema = recordSchema('agh.runtime/reference-record.value', ['referenceId'])

export const SESSION_IDENTITY_SCHEMA = schemaRef(
  'agh.runtime/session-identity-record@1',
  sessionIdentitySchema,
)
export const RUN_RECORD_SCHEMA = schemaRef('agh.runtime/run-record@1', runRecordSchema)
export const RUN_TAINT_SCHEMA = schemaRef('agh.runtime/run-taint-record@1', runTaintSchema)
export const ACTION_SCHEMA = schemaRef('agh.runtime/action-record@1', actionRecordSchema)
export const ATTEMPT_SCHEMA = schemaRef('agh.runtime/attempt-record@1', attemptRecordSchema)
export const RUN_QUOTA_SCHEMA = schemaRef('agh.runtime/run-quota@1', runQuotaSchema)
export const INVOCATION_SCHEMA = schemaRef('agh.runtime/invocation@1', invocationSchema)
export const PREPARE_QUOTA_SCHEMA = schemaRef('agh.runtime/prepare-query-quota@1', prepareQuotaSchema)
export const QUERY_GRANT_SCHEMA = schemaRef('agh.runtime/query-grant@1', queryGrantSchema)
export const DISPATCH_ADMISSION_SCHEMA = schemaRef(
  'agh.runtime/dispatch-admission@1',
  dispatchAdmissionSchema,
)
export const RECEIPT_SCHEMA = schemaRef('agh.runtime/receipt-record@1', receiptRecordSchema)
export const QUOTA_MIRROR_SCHEMA = schemaRef('agh.runtime/quota-mirror@1', quotaMirrorSchema)
export const SIGNAL_SCHEMA = schemaRef('agh.runtime/signal-record@1', signalRecordSchema)
export const VISIBILITY_SCHEMA = schemaRef('agh.runtime/action-visibility@1', actionVisibilitySchema)
export const USAGE_MIRROR_SCHEMA = schemaRef('agh.runtime/usage-mirror@1', usageMirrorSchema)
export const OUTBOX_SCHEMA = schemaRef('agh.runtime/outbox-record@1', outboxRecordSchema)
export const REFERENCE_SCHEMA = schemaRef('agh.runtime/reference-record@1', referenceRecordSchema)

const SCHEMAS: Readonly<Record<string, SchemaRef>> = {
  [SESSION_IDENTITY_SCHEMA.typeId]: SESSION_IDENTITY_SCHEMA,
  [RUN_RECORD_SCHEMA.typeId]: RUN_RECORD_SCHEMA,
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
}

export function sessionIdentityRecordId(sessionId: string): string {
  return `session-identity:${sessionId}`
}

export function runRecordId(runId: string): string {
  return `run:${runId}`
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

const knownSchemaCanonical = new Map<string, string>()

function canonicalSchemaText(typeId: string): string | undefined {
  const known = SCHEMAS[typeId]
  if (!known) return undefined
  let canonical = knownSchemaCanonical.get(typeId)
  if (canonical === undefined) {
    canonical = canonicalJson(known)
    knownSchemaCanonical.set(typeId, canonical)
  }
  return canonical
}

/** True when `schema` is exactly one of the registered runtime record schemas. */
export function matchesKnownSchema(schema: unknown): boolean {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return false
  const record = schema as { typeId?: unknown; revision?: unknown; digest?: unknown }
  if (typeof record.typeId !== 'string' || Object.keys(schema).length !== 3) return false
  const known = SCHEMAS[record.typeId]
  if (!known) return false
  return (
    record.typeId === known.typeId && record.revision === known.revision && record.digest === known.digest
  )
}

/** True when stored schema JSON is one of the registered schemas, including a non-canonical spelling. */
export function matchesKnownSchemaText(text: string): boolean {
  for (const typeId of Object.keys(SCHEMAS)) if (text === canonicalSchemaText(typeId)) return true
  try {
    return matchesKnownSchema(JSON.parse(text) as unknown)
  } catch {
    return false
  }
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
