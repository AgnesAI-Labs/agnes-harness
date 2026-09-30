import { createHash } from 'node:crypto'
import type { SchemaRef, StateAuthorityRef } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'

/** Session catalogue does not register these types yet. Rows are still appended. */
export const FORMAT_EVENT = 'runtime/format'
export const STATE_COMMIT_EVENT = 'runtime/state-commit'
export const LEDGER_INTEGRITY_ALGORITHM = 'agnes-ledger-jcs-sha256-v1'
export const FORMAT_VERSION = 2
export const RUNTIME_SCHEMA_MAJOR = 1
export const MIN_READER = 1

const DIGEST = /^[0-9a-f]{64}$/

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
  return createHash('sha256').update(jcs(value)).digest('hex')
}

function schemaRef(typeId: string, document: unknown): SchemaRef {
  return { typeId, revision: 1, digest: digestOf(document) }
}

export const SESSION_IDENTITY_SCHEMA = schemaRef(
  'agh.runtime/session-identity-record@1',
  sessionIdentitySchema,
)
export const RUN_RECORD_SCHEMA = schemaRef('agh.runtime/run-record@1', runRecordSchema)
export const RUN_TAINT_SCHEMA = schemaRef('agh.runtime/run-taint-record@1', runTaintSchema)

const SCHEMAS: Readonly<Record<string, SchemaRef>> = {
  [SESSION_IDENTITY_SCHEMA.typeId]: SESSION_IDENTITY_SCHEMA,
  [RUN_RECORD_SCHEMA.typeId]: RUN_RECORD_SCHEMA,
  [RUN_TAINT_SCHEMA.typeId]: RUN_TAINT_SCHEMA,
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

export function bodyDigest(owner: RecordOwner, value: unknown): string {
  return digestOf({ owner, value })
}

export function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

export function mutationDigest(manifests: readonly CommitMutationManifest[]): string {
  const body = manifests
    .map((manifest) => ({
      recordId: manifest.recordId,
      previousRevision: manifest.previousRevision,
      next: manifest.next,
    }))
    .sort((left, right) => compareUtf8(left.recordId, right.recordId))
  return digestOf(body)
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

export function sideListsDigest(entries: readonly CommitSideEntry[]): string {
  const body = [...entries]
    .sort((left, right) => compareIdentity(sideIdentity(left), sideIdentity(right)))
    .map((entry) => {
      const { commitId: _commitId, ...rest } = entry
      return rest
    })
  return digestOf(body)
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

export function createManifest(commitId: string, record: StoredRecord): CommitMutationManifest {
  return {
    commitId,
    recordId: record.recordId,
    previousRevision: null,
    next: {
      recordRevision: record.recordRevision,
      schema: record.schema,
      digest: bodyDigest(record.owner, record.value),
    },
  }
}

function sameDigest(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let different = 0
  for (let index = 0; index < left.length; index++)
    different |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return different === 0
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

export function verifyChain(sessionKey: string, rows: readonly ChainRow[]): IntegrityState {
  let state: IntegrityState = { lastSeq: 0, legacyThroughSeq: 0, headDigest: null }
  for (const row of rows) {
    if (row.event.seq !== state.lastSeq + 1) throw new Error('ledger sequence is not contiguous')
    if (!row.integrity) throw new Error('runtime ledger row is missing integrity')
    if (!DIGEST.test(row.integrity.digest)) throw new Error('malformed ledger digest')
    const expected =
      row.integrity.mode === 'anchor'
        ? state.headDigest !== null || row.integrity.previousDigest !== null
          ? null
          : anchorDigest(sessionKey, state.legacyThroughSeq, row.event)
        : row.integrity.mode === 'chain' &&
            state.headDigest !== null &&
            row.integrity.previousDigest !== null &&
            DIGEST.test(row.integrity.previousDigest) &&
            sameDigest(row.integrity.previousDigest, state.headDigest)
          ? chainDigest(sessionKey, row.integrity.previousDigest, row.event)
          : null
    if (expected === null) throw new Error('ledger chain predecessor mismatch')
    if (!sameDigest(row.integrity.digest, expected)) throw new Error('ledger digest mismatch')
    state = { ...state, lastSeq: row.event.seq, headDigest: row.integrity.digest }
  }
  return state
}

export function knownSchema(typeId: string): SchemaRef | undefined {
  return SCHEMAS[typeId]
}

export function sameJson(left: unknown, right: unknown): boolean {
  return jcs(left) === jcs(right)
}

export function emptyIntegrity(): IntegrityState {
  return { lastSeq: 0, legacyThroughSeq: 0, headDigest: null }
}

export function isFormatData(value: unknown): value is FormatEventData {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const data = value as FormatEventData
  return (
    data.formatVersion === FORMAT_VERSION &&
    data.runtimeSchemaMajor === RUNTIME_SCHEMA_MAJOR &&
    data.minReader === MIN_READER &&
    (data.previousFormat === 1 || data.previousFormat === 2) &&
    typeof data.legacyThroughSeq === 'number' &&
    (data.sourceHeadDigest === null || typeof data.sourceHeadDigest === 'string')
  )
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

export function isCommitData(value: unknown): value is RuntimeCommitData {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const data = value as RuntimeCommitData
  return (
    typeof data.commitId === 'string' &&
    typeof data.transactionFingerprint === 'string' &&
    typeof data.mutationsDigest === 'string' &&
    typeof data.sideListsDigest === 'string' &&
    typeof data.mutationCount === 'number' &&
    data.counts !== null &&
    typeof data.counts === 'object'
  )
}
