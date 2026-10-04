import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import {
  defaultIds,
  type Event,
  type InteractionTransaction,
  LedgerIntegrityFailure,
  type StoredInteractionResponse,
  verifyIntegrityRows,
} from '@agnes/core'
import type {
  AckOutboxRequest,
  AckOutboxResult,
  ActionVisibilityValue,
  AdmissionProbe,
  AdmitInvocationResult,
  AdmitQueryResult,
  AdvanceRunRequest,
  CallContext,
  ClaimOutboxRequest,
  ClaimOutboxResult,
  CloseInvocationRequest,
  CloseInvocationResult,
  CommitControlRequest,
  DispatchAdmissionProbe,
  DispatchAdmissionRequest,
  DispatchAdmissionResult,
  FailOutboxRequest,
  FailOutboxResult,
  InvocationAdmission,
  ProbeActionResultRequest,
  QueryAdmission,
  ReceiptIntakeRequest,
  ReceiptIntakeResult,
  RunAdmission,
  StateAuthorityRef,
  StateCommitReceipt,
  StateLeaseProofValue,
  StateLeaseRecordValue,
  StateLeaseRequest,
  StateLeaseResult,
  StateOpenRequest,
  StateOpenResult,
  StateWriteOpenProofValue,
  WriterClaim,
} from '@agnes/extension-api/runtime'
import {
  EventEnvelope,
  RuntimeCommitData as RuntimeCommitSchema,
  RuntimeFormatData,
} from '@agnes/protocol/gen/session-v1'
import type {
  SessionControlRequest,
  StateStoreControlSessionControlStatusRequest,
} from '@agnes/protocol/runtime'
import {
  type DataRef,
  type InboxRecord,
  type InteractionClientPendingRequest,
  type InteractionRecord,
  type InteractionResponseStatus,
  type JsonValue,
  type PageInteractionRecord,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  RuntimeStateLegacyReaders,
  type SchemaRef,
  type Signal,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { TypeCompiler } from '@sinclair/typebox/compiler'
import { DDL } from '../../adapters/ddl.js'
import { syncCheckpointsToMedium } from '../../adapters/sqlite-durability.js'
import {
  admissionSourceUsesDatabase,
  captureAdmissionStateFence,
  isRuntimeAdmissionSource,
  type RuntimeAdmissionCapture,
  type RuntimeAdmissionProof,
  type RuntimeAdmissionSource,
} from './admission.js'
import {
  type ApprovalJointPorts,
  type ApprovalPreparation,
  type ApprovalPreparationInput,
  type ApprovalResolutionInput,
  type ApprovalResponder,
  prepareApprovalInTransaction,
  resolveApprovalInTransaction,
} from './approval.js'
import { canonicalJson } from './canonical-json.js'
import {
  ackOutboxTx,
  admitInvocationTx,
  admitQueryTx,
  advanceRunTx,
  assertStoredOutbox,
  type ControlPorts,
  type ControlScan,
  claimOutboxTx,
  closeInvocationTx,
  commitControlTx,
  createControlScan,
  dispatchAdmissionTx,
  failOutboxTx,
  finishControlScan,
  intakeReceiptTx,
  noteControlSide,
  noteControlVersion,
  probeActionResultTx,
  probeDispatchTx,
  type StoredHead,
  type WriteCommitInput,
} from './control.js'
import {
  createInteractionReads,
  type InteractionReadCut,
  type InteractionReader,
  interactionCutIdentity,
  type RuntimeInteractionReadOwner,
} from './interaction-read.js'
import {
  createLegacyStateDecoder,
  type LegacySourceVerifier,
  type LegacyStateSource,
} from './legacy-records.js'
import {
  createLegacyStateSourceVerifier,
  type LegacyCommitSources,
  type LegacySourcePorts,
} from './legacy-source.js'
import {
  enterPhase,
  leavePhase,
  noteBoundary,
  noteJsonParse,
  noteJsonStringify,
  noteSql,
  profiling,
} from './profile.js'
import { assertStateReader } from './reader.js'
import {
  bodyDigest,
  type ChainRow,
  type CommitMutationManifest,
  type CommitSideEntry,
  canonicalStoredBodyDigest,
  compareUtf8,
  createManifest,
  digestOf,
  type EncodedStoredRecord,
  emptyIntegrity,
  encodeStoredRecord,
  FORMAT_EVENT,
  FORMAT_VERSION,
  type FormatEventData,
  type IntegrityState,
  isSideEntry,
  type LedgerEvent,
  MIN_READER,
  type MutationNext,
  matchesKnownSchema,
  matchesKnownSchemaText,
  mutationDigest,
  protectEvent,
  type RecordOwner,
  RUN_BINDING_SCHEMA,
  RUN_RECORD_SCHEMA,
  RUN_TAINT_SCHEMA,
  RUNTIME_ACTOR,
  RUNTIME_SCHEMA_MAJOR,
  type RunRecordValue,
  type RuntimeCommitData,
  runBindingRecordId,
  runRecordId,
  SESSION_IDENTITY_SCHEMA,
  type SessionIdentityValue,
  SIGNAL_SCHEMA,
  STATE_COMMIT_EVENT,
  STATE_LEASE_PROOF_SCHEMA,
  STATE_LEASE_SCHEMA,
  STATE_OPEN_PROOF_SCHEMA,
  type StoredRecord,
  sameJson,
  sameSideCounts,
  sessionIdentityRecordId,
  sideCounts,
  sideEntryIdentity,
  sideListsDigest,
  signalRecordId,
  stableId,
  stateSchemaDefinition,
  stateSchemaReader,
  storedMutationNextJson,
  taintRecordId,
} from './records.js'
import { integrity, refuse, StateRefusal } from './refusal.js'
import { createSessionControlOwner, type SessionControlOwner } from './session-control.js'
import type { SessionControlSource } from './session-control-source.js'

const SNAPSHOT_TTL_MS = 60_000
const PROOF_PAGE = 500
const proofChecks = {
  envelope: TypeCompiler.Compile(EventEnvelope),
  commit: TypeCompiler.Compile(RuntimeCommitSchema),
  format: TypeCompiler.Compile(RuntimeFormatData),
}
const HEAD_BY_ID = `SELECT h.record_id, h.schema_json, h.min_reader, h.record_revision, h.last_commit_id,
       h.owner_json, b.value_json, h.body_digest
  FROM runtime_record_heads h
  JOIN runtime_version_bodies b
    ON b.record_id = h.record_id AND b.record_revision = h.record_revision
 WHERE h.record_id = ?`
const HEADS_BY_COMMIT = `SELECT record_id, schema_json, min_reader, record_revision, last_commit_id, owner_json, body_digest
  FROM runtime_record_heads WHERE last_commit_id IN (SELECT value FROM json_each(?))`
const PROOFS_BY_COMMIT = `SELECT commit_id, ledger_seq, manifests_json, sides_json, versions_json
  FROM runtime_commit_proofs WHERE commit_id IN (SELECT value FROM json_each(?))`

const RUNTIME_DDL = [
  `CREATE TABLE IF NOT EXISTS runtime_state_control_requests (
    authority_id TEXT NOT NULL, tenant_id TEXT NOT NULL, authority_epoch INTEGER NOT NULL,
    session_id TEXT NOT NULL, method TEXT NOT NULL, request_id TEXT NOT NULL,
    record_id TEXT NOT NULL, record_revision INTEGER NOT NULL, commit_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, result_json TEXT,
    PRIMARY KEY(authority_id, tenant_id, authority_epoch, session_id, method, request_id)
  )`,
  `CREATE TABLE IF NOT EXISTS runtime_record_heads (
     record_id TEXT PRIMARY KEY,
     schema_json TEXT NOT NULL,
     min_reader INTEGER NOT NULL,
     record_revision INTEGER NOT NULL,
     last_commit_id TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     owner_json TEXT NOT NULL,
     body_digest TEXT NOT NULL
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS runtime_version_bodies (
     record_id TEXT NOT NULL,
     record_revision INTEGER NOT NULL,
     value_json TEXT NOT NULL,
     PRIMARY KEY (record_id, record_revision)
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS runtime_commit_proofs (
     commit_id TEXT PRIMARY KEY,
     ledger_seq INTEGER NOT NULL,
     manifests_json TEXT NOT NULL,
     sides_json TEXT NOT NULL,
     versions_json TEXT NOT NULL
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS runtime_admissions (
     ticket_id TEXT PRIMARY KEY,
     fingerprint TEXT NOT NULL,
     run_id TEXT NOT NULL,
     probe_json TEXT NOT NULL
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS runtime_admission_tombstones (ticket_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, tombstone_id TEXT NOT NULL UNIQUE, authority_json TEXT NOT NULL, source_json TEXT NOT NULL, source_digest TEXT NOT NULL, created_at TEXT NOT NULL, proof_json TEXT NOT NULL, proof_digest TEXT NOT NULL, body_digest TEXT NOT NULL) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS runtime_admission_source_proofs (ticket_id TEXT PRIMARY KEY, commit_id TEXT NOT NULL, proof_json TEXT NOT NULL, proof_digest TEXT NOT NULL) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS runtime_request_results (
     method TEXT NOT NULL,
     request_id TEXT NOT NULL,
     fingerprint TEXT NOT NULL,
     result_json TEXT NOT NULL,
     PRIMARY KEY (method, request_id)
   ) WITHOUT ROWID`,
  // Rebuilt from signal and invocation records when a session is opened. Outside the ledger digest.
  `CREATE TABLE IF NOT EXISTS runtime_signal_seq (
     run_id TEXT NOT NULL,
     target_key TEXT NOT NULL,
     next_seq INTEGER NOT NULL,
     PRIMARY KEY (run_id, target_key)
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS runtime_active_invocation (
     run_id TEXT PRIMARY KEY,
     invocation_id TEXT NOT NULL
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS runtime_leases (
     scope_id TEXT PRIMARY KEY,
     writer_id TEXT,
     writer_epoch INTEGER,
     lease_until INTEGER,
     authority_epoch INTEGER NOT NULL,
     last_writer_epoch INTEGER NOT NULL
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS runtime_session_meta (
     session_id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     format_version INTEGER NOT NULL,
     min_reader INTEGER NOT NULL,
     authority_json TEXT NOT NULL,
     parent_json TEXT NOT NULL,
     latest_commit_id TEXT,
     dispatch_domain_json TEXT
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS runtime_outbox_delivery (
     event_id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     destination TEXT NOT NULL,
     claim_epoch INTEGER NOT NULL,
     active_owner TEXT,
     active_epoch INTEGER,
     active_until INTEGER,
     acked_epoch INTEGER,
     attempts INTEGER NOT NULL,
     consecutive_failures INTEGER NOT NULL,
     next_attempt_at INTEGER NOT NULL,
     delivery TEXT NOT NULL,
     ack_ref TEXT,
     error_json TEXT,
     last_owner TEXT
   ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS runtime_outbox_delivery_due
     ON runtime_outbox_delivery (destination, delivery, next_attempt_at)`,
  `CREATE TABLE IF NOT EXISTS runtime_aux_commits (
     token TEXT PRIMARY KEY
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS runtime_commit_fingerprints (
     commit_id TEXT PRIMARY KEY,
     fingerprints_json TEXT NOT NULL
   ) WITHOUT ROWID`,
  `CREATE VIEW IF NOT EXISTS runtime_records AS
   SELECT h.record_id, h.schema_json, h.min_reader, h.record_revision, h.last_commit_id,
          h.created_at, h.updated_at, h.owner_json, b.value_json, h.body_digest
     FROM runtime_record_heads h
     JOIN runtime_version_bodies b
       ON b.record_id = h.record_id AND b.record_revision = h.record_revision`,
  `CREATE VIEW IF NOT EXISTS runtime_record_versions AS
   SELECT json_extract(v.value, '$.recordId') AS record_id,
          json_extract(v.value, '$.recordRevision') AS record_revision,
          json_extract(v.value, '$.schemaJson') AS schema_json,
          p.commit_id AS commit_id,
          json_extract(v.value, '$.digest') AS digest,
          json_extract(v.value, '$.ownerJson') AS owner_json,
          b.value_json AS value_json
     FROM runtime_commit_proofs p, json_each(p.versions_json) v
     LEFT JOIN runtime_version_bodies b
       ON b.record_id = json_extract(v.value, '$.recordId')
      AND b.record_revision = json_extract(v.value, '$.recordRevision')`,
  `CREATE VIEW IF NOT EXISTS runtime_mutation_manifests AS
   SELECT p.commit_id AS commit_id,
          json_extract(m.value, '$.recordId') AS record_id,
          json_extract(m.value, '$.previousRevision') AS previous_revision,
          json_extract(m.value, '$.nextJson') AS next_json
     FROM runtime_commit_proofs p, json_each(p.manifests_json) m`,
  `CREATE VIEW IF NOT EXISTS runtime_side_entries AS
   SELECT p.commit_id AS commit_id,
          json_extract(s.value, '$.kind') AS kind,
          json_extract(s.value, '$.identity') AS identity,
          json_extract(s.value, '$.entryJson') AS entry_json
     FROM runtime_commit_proofs p, json_each(p.sides_json) s`,
  `CREATE VIEW IF NOT EXISTS runtime_dispatch_domains AS
   SELECT session_id, dispatch_domain_json AS domain_json
     FROM runtime_session_meta
    WHERE dispatch_domain_json IS NOT NULL`,
  `CREATE TRIGGER IF NOT EXISTS runtime_records_insert
   INSTEAD OF INSERT ON runtime_records
   BEGIN
     INSERT INTO runtime_record_heads (
       record_id, schema_json, min_reader, record_revision, last_commit_id, created_at, updated_at,
       owner_json, body_digest
     ) VALUES (
       NEW.record_id, NEW.schema_json, NEW.min_reader, NEW.record_revision, NEW.last_commit_id,
       NEW.created_at, NEW.updated_at, NEW.owner_json, NEW.body_digest
     );
     INSERT INTO runtime_version_bodies (record_id, record_revision, value_json)
     VALUES (NEW.record_id, NEW.record_revision, NEW.value_json)
     ON CONFLICT(record_id, record_revision) DO UPDATE SET value_json = excluded.value_json;
   END`,
  `CREATE TRIGGER IF NOT EXISTS runtime_records_update
   INSTEAD OF UPDATE ON runtime_records
   BEGIN
     UPDATE runtime_record_heads
        SET schema_json = NEW.schema_json,
            min_reader = NEW.min_reader,
            record_revision = NEW.record_revision,
            last_commit_id = NEW.last_commit_id,
            created_at = NEW.created_at,
            updated_at = NEW.updated_at,
            owner_json = NEW.owner_json,
            body_digest = NEW.body_digest
      WHERE record_id = OLD.record_id;
     UPDATE runtime_version_bodies
        SET value_json = NEW.value_json
      WHERE record_id = OLD.record_id AND record_revision = OLD.record_revision;
   END`,
  `CREATE TRIGGER IF NOT EXISTS runtime_records_delete
   INSTEAD OF DELETE ON runtime_records
   BEGIN
     DELETE FROM runtime_record_heads WHERE record_id = OLD.record_id;
   END`,
  `CREATE TRIGGER IF NOT EXISTS runtime_record_versions_insert
   INSTEAD OF INSERT ON runtime_record_versions
   BEGIN
     INSERT INTO runtime_version_bodies (record_id, record_revision, value_json)
     VALUES (NEW.record_id, NEW.record_revision, NEW.value_json)
     ON CONFLICT(record_id, record_revision) DO UPDATE SET value_json = excluded.value_json;
     UPDATE runtime_commit_proofs
        SET versions_json = json_insert(
          versions_json,
          '$[#]',
          json_object(
            'digest', NEW.digest,
            'hasBody', json('true'),
            'ownerJson', NEW.owner_json,
            'recordId', NEW.record_id,
            'recordRevision', NEW.record_revision,
            'schemaJson', NEW.schema_json
          )
        )
      WHERE commit_id = NEW.commit_id;
   END`,
  `CREATE TRIGGER IF NOT EXISTS runtime_record_versions_update
   INSTEAD OF UPDATE ON runtime_record_versions
   BEGIN
     UPDATE runtime_version_bodies
        SET value_json = NEW.value_json
      WHERE record_id = OLD.record_id AND record_revision = OLD.record_revision;
     UPDATE runtime_commit_proofs
        SET versions_json = json_replace(
          versions_json,
          '$[' || (
            SELECT v.key FROM json_each(runtime_commit_proofs.versions_json) v
            WHERE json_extract(v.value, '$.recordId') = OLD.record_id
              AND json_extract(v.value, '$.recordRevision') = OLD.record_revision
          ) || ']',
          json_object(
            'digest', NEW.digest,
            'hasBody', json('true'),
            'ownerJson', NEW.owner_json,
            'recordId', NEW.record_id,
            'recordRevision', NEW.record_revision,
            'schemaJson', NEW.schema_json
          )
        )
      WHERE commit_id = OLD.commit_id;
   END`,
  `CREATE TRIGGER IF NOT EXISTS runtime_record_versions_delete
   INSTEAD OF DELETE ON runtime_record_versions
   BEGIN
     UPDATE runtime_commit_proofs
        SET versions_json = COALESCE((
          SELECT json_group_array(json(v.value))
            FROM json_each(runtime_commit_proofs.versions_json) v
           WHERE json_extract(v.value, '$.recordId') <> OLD.record_id
              OR json_extract(v.value, '$.recordRevision') <> OLD.record_revision
        ), '[]')
      WHERE commit_id = OLD.commit_id;
   END`,
  `CREATE TRIGGER IF NOT EXISTS runtime_mutation_manifests_insert
   INSTEAD OF INSERT ON runtime_mutation_manifests
   BEGIN
     UPDATE runtime_commit_proofs
        SET manifests_json = json_insert(
          manifests_json,
          '$[#]',
          json_object(
            'nextJson', NEW.next_json,
            'previousRevision', NEW.previous_revision,
            'recordId', NEW.record_id
          )
        )
      WHERE commit_id = NEW.commit_id;
   END`,
  `CREATE TRIGGER IF NOT EXISTS runtime_mutation_manifests_update
   INSTEAD OF UPDATE ON runtime_mutation_manifests
   BEGIN
     UPDATE runtime_commit_proofs
        SET manifests_json = json_replace(
          manifests_json,
          '$[' || (
            SELECT m.key FROM json_each(runtime_commit_proofs.manifests_json) m
            WHERE json_extract(m.value, '$.recordId') = OLD.record_id
          ) || ']',
          json_object(
            'nextJson', NEW.next_json,
            'previousRevision', NEW.previous_revision,
            'recordId', NEW.record_id
          )
        )
      WHERE commit_id = OLD.commit_id;
   END`,
  `CREATE TRIGGER IF NOT EXISTS runtime_mutation_manifests_delete
   INSTEAD OF DELETE ON runtime_mutation_manifests
   BEGIN
     UPDATE runtime_commit_proofs
        SET manifests_json = COALESCE((
          SELECT json_group_array(json(m.value))
            FROM json_each(runtime_commit_proofs.manifests_json) m
           WHERE json_extract(m.value, '$.recordId') <> OLD.record_id
        ), '[]')
      WHERE commit_id = OLD.commit_id;
   END`,
  `CREATE TRIGGER IF NOT EXISTS runtime_side_entries_insert
   INSTEAD OF INSERT ON runtime_side_entries
   BEGIN
     UPDATE runtime_commit_proofs
        SET sides_json = json_insert(
          sides_json,
          '$[#]',
          json_object(
            'entryJson', NEW.entry_json,
            'identity', NEW.identity,
            'kind', NEW.kind
          )
        )
      WHERE commit_id = NEW.commit_id;
   END`,
  `CREATE TRIGGER IF NOT EXISTS runtime_side_entries_delete
   INSTEAD OF DELETE ON runtime_side_entries
   BEGIN
     UPDATE runtime_commit_proofs
        SET sides_json = COALESCE((
          SELECT json_group_array(json(s.value))
            FROM json_each(runtime_commit_proofs.sides_json) s
           WHERE json_extract(s.value, '$.kind') <> OLD.kind
              OR json_extract(s.value, '$.identity') <> OLD.identity
        ), '[]')
      WHERE commit_id = OLD.commit_id;
   END`,
]

export type { StateFailure } from './refusal.js'
export { StateRefusal }

export type CreateRunInput = {
  admission: RunAdmission
  scope: unknown
}

export type RuntimeDurability = {
  journalMode: string
  synchronous: number
  checkpointFullfsync: number | null
}

const OUTBOX_OPEN_COLUMNS = `event_id, session_id, claim_epoch, acked_epoch, attempts, consecutive_failures,
  next_attempt_at, delivery, ack_ref, error_json, active_owner, active_epoch, active_until`

type OutboxDeliveryRow = {
  event_id: string
  session_id: string
  claim_epoch: number
  acked_epoch: number | null
  attempts: number
  consecutive_failures: number
  next_attempt_at: number
  delivery: string
  ack_ref: string | null
  error_json: string | null
  active_owner: string | null
  active_epoch: number | null
  active_until: number | null
}

type MetaRow = {
  session_id: string
  workspace_id: string
  format_version: number
  min_reader: number
  authority_json: string
  parent_json: string
  latest_commit_id: string | null
}

type EventRow = {
  session_key: string
  seq: number
  ts: string
  id: string
  type: string
  lane: Uint8Array
  v: number
  actor: string
  origin: string
  trust: string
  data: string
  integrity_mode: string | null
  integrity_prev: string | null
  integrity_digest: string | null
}

type ManifestRow = {
  commit_id: string
  record_id: string
  previous_revision: number | null
  next_json: string | null
}

type SideRow = { commit_id: string; entry_json: string }

type VersionRow = {
  record_id: string
  record_revision: number
  schema_json: string
  commit_id: string
  digest: string
  owner_json: string
  value_json: string
}

type HeadSummary = {
  record_id: string
  min_reader: number
  record_revision: number
  last_commit_id: string
  body_digest: string
  has_version: number | boolean
  same_text: number | boolean
  identity_json: string | null
}

function sqlFlag(value: number | boolean): boolean {
  return value === true || value === 1
}

type HeadRow = {
  record_id: string
  schema_json: string
  min_reader: number
  record_revision: number
  last_commit_id: string
  owner_json: string
  value_json: string
  body_digest: string
}

type LeaseRow = {
  writer_id: string | null
  writer_epoch: number | null
  lease_until: number | null
  authority_epoch: number
  last_writer_epoch: number
}

type AdmissionRow = {
  ticket_id: string
  fingerprint: string
  run_id: string
  probe_json: string
}

type RequestResultRow = {
  fingerprint: string
  result_json: string
}

type VerifiedSession = {
  lastSeq: number
  formatSeq: number
  headDigest: string
  latestCommitId: string
  workspaceId: string
  formatVersion: number
  minReader: number
  parent: SessionIdentityValue['parent']
  chain: IntegrityState
}

type LiveRecord = { revision: number | null; commitId: string }

type HeadScan = {
  sessionId: string
  meta: MetaRow
  parent: SessionIdentityValue['parent']
  seen: Set<string>
  sawIdentity: boolean
}

type RunMatch = {
  sessionId: string
  ticketId: string
  revision: number
  seq: number
  digest: string
  commitId: string
  transactionFingerprint: string
  previousCommitId: string | null
}

type RunEvidence = { count: number; match?: RunMatch }

type CommittedRun = { probe: AdmissionProbe; head?: { sessionId: string; verified: VerifiedSession } }

type ParsedCommit = { seq: number; data: RuntimeCommitData; digest: string; at: string; eventId: string }

type ValidatedProof =
  | { kind: 'format'; event: LedgerEvent; data: FormatEventData; digest: string }
  | { kind: 'commit'; event: LedgerEvent; data: RuntimeCommitData; digest: string }

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** TypeBox integers accept -0, and JCS then spells it as 0, so the chain digest cannot see it. */
function containsNegativeZero(value: unknown): boolean {
  if (typeof value === 'number') return Object.is(value, -0)
  if (Array.isArray(value)) {
    for (const item of value) if (containsNegativeZero(item)) return true
    return false
  }
  if (!isPlainRecord(value)) return false
  for (const key of Object.keys(value)) if (containsNegativeZero(value[key])) return true
  return false
}

function proofDataHolds(data: unknown, canonicalized: boolean): boolean {
  if (containsNegativeZero(data)) return false
  if (canonicalized) return true
  try {
    canonicalJson(data)
    return true
  } catch {
    return false
  }
}

export type CommitNotice = { method: string; requestId: string; wrote: boolean }

type QueryTicket = { fingerprint: string; ticketId: string; remainingQueries: number }

type QueryMeter = { capacity: number; observed: number; tickets: Map<string, QueryTicket> }

export type RuntimeApprovalJointOwner = {
  readonly owner: RecordOwner
  assertJoint(context: CallContext, stateAuthority: StateAuthorityRef, physicalSessionId: string): void
  currentResponder(context: CallContext, authentication: unknown): ApprovalResponder
  ask(
    context: CallContext,
    preparation: ApprovalPreparation,
    interaction: InteractionRecord,
  ):
    | Extract<CommitControlRequest['command'], { kind: 'authorize_action'; decision: 'ask' | 'deny' }>
    | undefined
  verifyAuthorizationPreparation?: ControlPorts['verifyAuthorizationPreparation']
  verifyApprovalAsk?: ControlPorts['verifyApprovalAsk']
}

export type RuntimeStateDatabaseOptions = {
  file: string
  authority: StateAuthorityRef
  admissionSource?: RuntimeAdmissionSource
  approvalJoint?: RuntimeApprovalJointOwner
  interactionRead?: RuntimeInteractionReadOwner
  now?: () => number
  verifyLegacySource?: LegacySourceVerifier
  legacySourcePolicy?: Pick<LegacySourcePorts, 'currentRead' | 'sourceProfile'>
  verifyUsageSettlement?: ControlPorts['verifyUsageSettlement']
  verifyRetentionPin?: ControlPorts['verifyRetentionPin']
  beforeCommit?: () => void
  onCommit?: (commit: CommitNotice) => void
}

function parseProfiled(text: string): unknown {
  if (!profiling) return JSON.parse(text) as unknown
  const started = performance.now()
  const value = JSON.parse(text) as unknown
  noteJsonParse(performance.now() - started, text.length)
  return value
}

function stringifyProfiled(value: unknown): string {
  if (!profiling) return JSON.stringify(value)
  const started = performance.now()
  const text = JSON.stringify(value)
  noteJsonStringify(performance.now() - started, text.length)
  return text
}

type StagedChange = {
  previousRevision: number | null
  created: boolean
  final: StoredRecord
  encoded: EncodedStoredRecord
}

type PackedManifest = { recordId: string; previousRevision: number | null; nextJson: string | null }

type PackedVersion = {
  recordId: string
  recordRevision: number
  schemaJson: string
  digest: string
  ownerJson: string
  hasBody: boolean
}

type PackedSide = { kind: string; identity: string; entryJson: string }

type ProofDraft = { manifests: PackedManifest[]; sides: PackedSide[]; versions: PackedVersion[] }

type ProofRow = {
  commit_id: string
  ledger_seq: number
  manifests_json: string
  sides_json: string
  versions_json: string
}

type PendingRequest = { method: string; requestId: string; fingerprint: string; result: unknown }

type CommitStaging = {
  commitId: string
  changes: Map<string, StagedChange>
  shadow: Map<string, StoredHead>
  sides: CommitSideEntry[]
  sideKeys: Set<string>
  memberFingerprints: string[]
  receipts: StateCommitReceipt[]
  pending: PendingRequest[]
  actionIds: { key: string; actionId: string }[]
  actionKeys: Set<string>
  eventActionIds: Set<string>
  sessionId: string
  verified: VerifiedSession | null
  at: string
  writerEpoch: number
  runId: string
  runRevision: number
}

const runtimeDatabaseConfigurations = new WeakMap<
  RuntimeStateDatabase,
  { database: DatabaseSync; options: RuntimeStateDatabaseOptions; authorityDigest: string }
>()
export function matchesRuntimeStateDatabaseOptions(
  database: RuntimeStateDatabase,
  options: RuntimeStateDatabaseOptions,
): boolean {
  const selected = runtimeDatabaseConfigurations.get(database)
  if (
    !selected ||
    Object.getPrototypeOf(database) !== RuntimeStateDatabase.prototype ||
    Object.getOwnPropertyDescriptor(database, 'db')?.value !== selected.database ||
    selected.authorityDigest !== digestOf(options.authority)
  )
    return false
  const original = selected.options
  return (
    original.file === options.file &&
    original.now === options.now &&
    original.beforeCommit === options.beforeCommit &&
    original.onCommit === options.onCommit &&
    original.admissionSource === options.admissionSource &&
    original.approvalJoint === options.approvalJoint &&
    original.interactionRead === options.interactionRead &&
    original.verifyUsageSettlement === options.verifyUsageSettlement &&
    original.verifyRetentionPin === options.verifyRetentionPin &&
    original.verifyLegacySource === options.verifyLegacySource &&
    original.legacySourcePolicy === options.legacySourcePolicy
  )
}

export class RuntimeStateDatabase {
  private readonly db: DatabaseSync
  private readonly statements = new Map<string, StatementSync>()
  private readonly authority: StateAuthorityRef
  private readonly now: () => number
  private readonly legacyCommitSources = new Map<string, LegacyCommitSources>()
  private readonly legacyDecoder: ReturnType<typeof createLegacyStateDecoder>
  private readonly verifyUsageSettlement: ControlPorts['verifyUsageSettlement']
  private readonly verifyRetentionPin: ControlPorts['verifyRetentionPin']
  private readonly approvalJoint: RuntimeApprovalJointOwner | undefined
  private readonly interactionRead: RuntimeInteractionReadOwner | undefined
  private readonly reservedCommitEvents = new Map<string, string>()
  private admissionSource: RuntimeAdmissionSource | undefined
  private sessionControl: SessionControlOwner | undefined
  private readonly beforeCommit: (() => void) | undefined
  private readonly onCommit: ((commit: CommitNotice) => void) | undefined
  private readonly ids: ReturnType<typeof defaultIds>
  private readonly verifiedHeads = new Map<string, VerifiedSession>()
  private readonly verifiedDataVersions = new Map<string, number>()
  private readonly verifiedSourceVersions = new WeakMap<VerifiedSession, number>()
  private readonly queryMeters = new Map<string, QueryMeter>()
  private pendingWrite = false
  private wroteCommit = false
  private notedAux = false
  private writeChain: Promise<void> = Promise.resolve()
  private staging: CommitStaging | null = null
  private draft: ProofDraft | null = null
  private closed = false

  constructor(options: RuntimeStateDatabaseOptions) {
    this.authority = options.authority
    this.now = options.now ?? (() => Date.now())
    const legacyPolicy = options.legacySourcePolicy
    if (
      legacyPolicy &&
      (typeof legacyPolicy.currentRead !== 'function' || typeof legacyPolicy.sourceProfile !== 'function')
    )
      refuse('incompatible', 'unproven_source', 'historical State source policy capabilities are incomplete')
    this.legacyDecoder = createLegacyStateDecoder(
      RuntimeStateLegacyReaders.entries,
      (legacyPolicy
        ? createLegacyStateSourceVerifier({
            currentRead: (source) => legacyPolicy.currentRead(source),
            sourceProfile: (source) => legacyPolicy.sourceProfile(source),
            verifiedCommit: (source) => this.legacyCommitSources.get(this.legacySourceKey(source)) ?? null,
          })
        : options.verifyLegacySource) ??
        (() =>
          refuse(
            'incompatible',
            'unproven_source',
            'historical State producer issuance/current read source is not proved',
          )),
    )
    this.approvalJoint = options.approvalJoint
    this.interactionRead = options.interactionRead
    this.verifyUsageSettlement = options.verifyUsageSettlement
    this.verifyRetentionPin = options.verifyRetentionPin
    this.admissionSource = options.admissionSource
    if (this.admissionSource && !isRuntimeAdmissionSource(this.admissionSource))
      refuse('denied', 'admission_source', 'unregistered admission source')
    this.beforeCommit = options.beforeCommit
    this.onCommit = options.onCommit
    this.ids = defaultIds(this.now)
    this.db = new DatabaseSync(options.file)
    try {
      this.db.exec('PRAGMA busy_timeout = 5000')
      this.db.exec('PRAGMA journal_mode = WAL')
      this.db.exec('PRAGMA synchronous = NORMAL')
      syncCheckpointsToMedium(this.db)
      this.db.exec('PRAGMA foreign_keys = ON')
      for (const statement of DDL) this.db.exec(statement)
      for (const statement of RUNTIME_DDL) this.db.exec(statement)
      if (this.admissionSource && !admissionSourceUsesDatabase(this.admissionSource, this.db))
        refuse('denied', 'admission_source', 'admission source belongs to another State connection')
      runtimeDatabaseConfigurations.set(this, {
        database: this.db,
        options: { ...options },
        authorityDigest: digestOf(options.authority),
      })
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  durability(): RuntimeDurability {
    const journal = this.one<{ journal_mode: string }>('PRAGMA journal_mode')
    const synchronous = this.one<{ synchronous: number }>('PRAGMA synchronous')
    let checkpointFullfsync: number | null = null
    try {
      checkpointFullfsync = this.one<{ checkpoint_fullfsync: number }>(
        'PRAGMA checkpoint_fullfsync',
      ).checkpoint_fullfsync
    } catch {
      checkpointFullfsync = null
    }
    return {
      journalMode: journal.journal_mode,
      synchronous: synchronous.synchronous,
      checkpointFullfsync,
    }
  }

  async open(request: StateOpenRequest): Promise<StateOpenResult> {
    if (!validateRuntime('StateOpenRequest', request).ok)
      refuse('invalid_input', 'request', 'invalid State open request')
    if (!sameJson(request.authority, this.authority))
      refuse('denied', 'authority', 'open authority does not match this store')
    const opened = await this.tx('open', request.requestId, async () => {
      const meta = this.sessionMeta(request.sessionId)
      if (!meta) refuse('invalid_input', 'session_absent', 'session does not exist')
      const verified = await this.verifySessionFully(meta)
      if (request.mode === 'read') return { verified, result: this.openResult(request, verified, null) }
      const replayed = this.replayAuthorityControl('open', request)
      if (replayed) return { verified, result: replayed as StateOpenResult }
      const sources = this.controlSources(request),
        at = this.now()
      if (!Number.isSafeInteger(at + request.ttlMs) || Math.abs(at + request.ttlMs) > 8.64e15)
        refuse('invalid_input', 'ttl', 'lease expiry is outside timestamp range')
      const claim = this.takeLease(request.sessionId, request.writerId, request.ttlMs, at)
      const written = this.writeAuthorityControl(
        'open',
        request,
        verified,
        sources,
        { claim, lastWriterEpoch: claim.writerEpoch },
        new Date(at).toISOString(),
      )
      return { verified: written.verified, result: written.result as StateOpenResult }
    })
    this.rememberVerified(request.sessionId, opened.verified)
    return opened.result
  }

  async lease(request: StateLeaseRequest): Promise<StateLeaseResult> {
    if (!validateRuntime('StateLeaseRequest', request).ok)
      refuse('invalid_input', 'request', 'invalid State lease request')
    if (!sameJson(request.authority, this.authority))
      refuse('denied', 'authority', 'lease authority does not match this store')
    const written = await this.tx('lease', request.requestId, async () => {
      const meta = this.sessionMeta(request.sessionId)
      if (!meta) refuse('invalid_input', 'session_absent', 'session does not exist')
      const verified = await this.verifySessionFully(meta)
      const replayed = this.replayAuthorityControl('lease', request)
      if (replayed) return { result: replayed as StateLeaseResult, verified }
      if (request.expectedWriterEpoch === null)
        refuse('invalid_input', 'writer_epoch', 'lease operation needs an expected writer epoch')
      if (request.expectedLastSeq !== verified.lastSeq)
        refuse('conflict', 'seq_mismatch', 'expected sequence does not match the verified head')
      const sources = this.controlSources(request),
        at = this.now()
      if (!Number.isSafeInteger(at + request.ttlMs) || Math.abs(at + request.ttlMs) > 8.64e15)
        refuse('invalid_input', 'ttl', 'lease expiry is outside timestamp range')
      const result = this.applyLease(request, this.loadLease(request.sessionId), at)
      const committed = this.writeAuthorityControl(
        'lease',
        request,
        verified,
        sources,
        result,
        new Date(at).toISOString(),
      )
      return { result: committed.result as StateLeaseResult, verified: committed.verified }
    })
    this.rememberVerified(request.sessionId, written.verified)
    return written.result
  }

  installAdmissionSource(source: RuntimeAdmissionSource): void {
    if (
      this.admissionSource ||
      !isRuntimeAdmissionSource(source) ||
      !admissionSourceUsesDatabase(source, this.db)
    )
      refuse(
        'denied',
        'admission_source',
        'admission source must be installed once on its original State connection',
      )
    this.admissionSource = source
  }

  installSessionControlSource(source: SessionControlSource): void {
    if (this.sessionControl)
      refuse('denied', 'session_control_source', 'session control source is already installed')
    this.sessionControl = createSessionControlOwner(
      this.db,
      source,
      this.controlPorts(),
      (method, id, body, final) => this.tx(method, id, body, final),
    )
  }

  readSessionControl(sessionId: string, context: CallContext) {
    if (!this.sessionControl)
      refuse('denied', 'session_control_source', 'session control source is not installed')
    return this.sessionControl.read(sessionId, context)
  }

  submitSessionControl(request: SessionControlRequest, context: CallContext) {
    if (!this.sessionControl)
      refuse('denied', 'session_control_source', 'session control source is not installed')
    return this.sessionControl.submit(request, context)
  }

  sessionControlStatus(request: StateStoreControlSessionControlStatusRequest, context: CallContext) {
    if (!this.sessionControl)
      refuse('denied', 'session_control_source', 'session control source is not installed')
    return this.sessionControl.status(request, context)
  }

  async createRun(input: CreateRunInput, context?: CallContext): Promise<AdmissionProbe> {
    const capture = context ? this.captureAdmission('create', input.admission, context) : undefined
    if (capture) input = { admission: capture.proof.facts.admission, scope: capture.proof.facts.scope }
    if (this.admissionSource && !capture)
      refuse('denied', 'identity', 'selected admission source requires original context')
    let nativeCheck: (() => void) | undefined
    const seal = () => {
      nativeCheck = captureAdmissionStateFence(this.db)
    }

    const committed = await this.tx(
      'createRun',
      input.admission.ticketId,
      async (): Promise<CommittedRun> => {
        const originalDecision = capture?.readDecision()
        capture?.dynamicCheck()
        if (this.admissionTombstone(input.admission.ticketId))
          refuse('conflict', 'admission_cancelled', 'admission was durably cancelled')
        const stored = this.get<AdmissionRow>(
          'SELECT ticket_id, fingerprint, run_id, probe_json FROM runtime_admissions WHERE ticket_id = ?',
          input.admission.ticketId,
        )
        if (stored) {
          if (stored.fingerprint !== input.admission.fingerprint)
            refuse(
              'conflict',
              'idempotency_conflict',
              'admission ticket was already committed with different content',
            )
          const verified = await this.requireSession(input.admission.sessionId)
          const probe = this.rebuildStoredAdmission(stored, verified, input.admission.sessionId)
          const storedProbe = this.parseJson<unknown>(
            stored.probe_json,
            'stored admission probe cannot be decoded',
          )
          if (!sameJson(storedProbe, probe) || probe.state !== 'created')
            integrity('admission replay does not match the attested run')
          if (probe.commit.transactionFingerprint !== digestOf(input.admission))
            integrity('admission replay does not match the attested commit')
          if (capture) this.verifyCreatedAdmissionSource(stored, probe, capture.proof)
          seal()
          return { probe }
        }
        if (originalDecision) integrity('original issuer consumed admission but State decision is absent')
        if (
          this.get(
            'SELECT record_id FROM runtime_record_heads WHERE record_id = ?',
            runRecordId(input.admission.runId),
          )
        )
          refuse('conflict', 'run_exists', 'run already exists')
        const existing = this.sessionMeta(input.admission.sessionId)
        const verified = existing
          ? await this.requireSession(input.admission.sessionId)
          : this.verifyEmptyOrOthers(input.admission.sessionId)
        if (existing && existing.workspace_id !== input.admission.workspaceId)
          refuse('conflict', 'session_workspace', 'session workspace does not match the admission')
        const started = verified?.chain ?? emptyIntegrity()
        const commitId = this.ids.ulid()
        const at = input.admission.admittedAt
        const owner = this.owner(input.admission.bindingId, input.scope)
        const records = this.createRunRecords(input, owner, existing === undefined)
        if (capture) {
          records.push({
            recordId: runBindingRecordId(input.admission.runId),
            schema: RUN_BINDING_SCHEMA,
            minReader: MIN_READER,
            recordRevision: 1,
            owner,
            value: capture.proof.facts.runBinding,
          })
        }
        const prepared = records.map((record) => {
          const encoded = this.encodeFreshRecord(record)
          return { record, encoded, manifest: createManifest(commitId, record, null, encoded.digest) }
        })
        const manifests = prepared.map((item) => item.manifest)
        const sides: CommitSideEntry[] = []
        const data: RuntimeCommitData = {
          commitId,
          transactionFingerprint: digestOf(input.admission),
          runId: input.admission.runId,
          actionId: null,
          authorityEpoch: this.authority.authorityEpoch,
          writerEpoch: 0,
          previousCommitId: verified?.latestCommitId ?? null,
          mutationsDigest: mutationDigest(manifests),
          mutationCount: manifests.length,
          sideListsDigest: sideListsDigest(sides),
          counts: sideCounts(sides),
        }
        let chain = started
        let firstSeq = 0
        if (!existing) {
          const format = this.event(this.ids.ulid(), at, FORMAT_EVENT, this.formatData(), chain)
          const protectedFormat = protectEvent(input.admission.sessionId, format, chain)
          this.appendEvent(input.admission.sessionId, format, protectedFormat.integrity)
          chain = protectedFormat.state
          firstSeq = format.seq
        }
        const commit = this.event(this.ids.ulid(), at, STATE_COMMIT_EVENT, data, chain)
        const protectedCommit = protectEvent(input.admission.sessionId, commit, chain)
        this.pendingWrite = true
        this.appendEvent(input.admission.sessionId, commit, protectedCommit.integrity)
        if (firstSeq === 0) firstSeq = commit.seq
        this.draft = { manifests: [], sides: [], versions: [] }
        try {
          for (const item of prepared)
            this.insertRecord(item.record, commitId, at, item.encoded, item.manifest)
          this.writeProof(commitId, commit.seq)
        } finally {
          this.draft = null
        }
        const parent = JSON.stringify(null)
        if (existing) {
          this.run(
            'UPDATE runtime_session_meta SET latest_commit_id = ? WHERE session_id = ?',
            commitId,
            input.admission.sessionId,
          )
        } else {
          this.run(
            `INSERT INTO runtime_session_meta (
             session_id, workspace_id, format_version, min_reader, authority_json, parent_json,
             latest_commit_id, dispatch_domain_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
            input.admission.sessionId,
            input.admission.workspaceId,
            FORMAT_VERSION,
            MIN_READER,
            JSON.stringify(this.authority),
            parent,
            commitId,
          )
          this.run(
            'INSERT INTO sessions (session_key, format_version, parent_key, boundary_seq, created_at) VALUES (?, ?, NULL, NULL, ?)',
            input.admission.sessionId,
            FORMAT_VERSION,
            at,
          )
        }
        const receipt: StateCommitReceipt = {
          commitId,
          transactionFingerprint: data.transactionFingerprint,
          sessionId: input.admission.sessionId,
          firstSeq,
          lastSeq: commit.seq,
          headDigest: protectedCommit.integrity.digest,
          runRevision: 0,
          actionIds: [],
        }
        const probe: AdmissionProbe = { state: 'created', runId: input.admission.runId, commit: receipt }
        this.run(
          'INSERT INTO runtime_admissions (ticket_id, fingerprint, run_id, probe_json) VALUES (?, ?, ?, ?)',
          input.admission.ticketId,
          input.admission.fingerprint,
          input.admission.runId,
          JSON.stringify(probe),
        )
        if (capture)
          this.run(
            'INSERT INTO runtime_admission_source_proofs (ticket_id, commit_id, proof_json, proof_digest) VALUES (?, ?, ?, ?)',
            input.admission.ticketId,
            commitId,
            JSON.stringify(capture.proof),
            digestOf(capture.proof),
          )
        capture?.recordDecision({
          ticketId: input.admission.ticketId,
          fingerprint: input.admission.fingerprint,
          sourceDigest: capture.proof.sourceDigest,
          kind: 'created',
          targetId: commitId,
          bodyDigest: digestOf(probe),
        })
        seal()
        // Remember the new head only after commit, so a rolled-back write cannot advance the cache.
        return {
          probe,
          head: {
            sessionId: input.admission.sessionId,
            verified: this.sealVerified({
              lastSeq: commit.seq,
              formatSeq: verified?.formatSeq ?? firstSeq,
              headDigest: protectedCommit.integrity.digest,
              latestCommitId: commitId,
              workspaceId: input.admission.workspaceId,
              formatVersion: FORMAT_VERSION,
              minReader: MIN_READER,
              parent: verified?.parent ?? null,
              chain: protectedCommit.state,
            }),
          },
        }
      },
      capture
        ? () => {
            capture.dynamicCheck()
            capture.finalCheck(() => {
              if (!nativeCheck) integrity('admission native seal absent')
              nativeCheck()
            })
          }
        : undefined,
    )
    if (committed.head) this.rememberVerified(committed.head.sessionId, committed.head.verified)
    return committed.probe
  }

  private captureAdmission(
    operation: 'create' | 'cancel' | 'probe',
    request: RunAdmission | { ticketId: string; fingerprint?: string },
    context: CallContext,
  ): RuntimeAdmissionCapture {
    if (!this.admissionSource)
      refuse('denied', 'admission_source', 'trusted admission source is not installed')
    const source = this.admissionSource
    const capture = source.capture(operation, request, context, this.authority)
    return Object.freeze({
      ...capture,
      finalCheck: (check?: () => void) =>
        capture.finalCheck(() => {
          if (Object.getOwnPropertyDescriptor(this, 'admissionSource')?.value !== source)
            refuse('denied', 'admission_source', 'selected admission source changed')
          check?.()
        }),
    })
  }

  private admissionTombstone(ticketId: string): AdmissionProbe | undefined {
    const row = this.get<Record<string, unknown>>(
      'SELECT * FROM runtime_admission_tombstones WHERE ticket_id = ?',
      ticketId,
    )
    if (!row) return undefined
    if (this.get('SELECT ticket_id FROM runtime_admissions WHERE ticket_id = ?', ticketId))
      integrity('ticket has both created and cancelled decisions')
    if (
      !this.admissionSource ||
      typeof row.proof_json !== 'string' ||
      typeof row.authority_json !== 'string' ||
      typeof row.source_json !== 'string' ||
      typeof row.tombstone_id !== 'string'
    )
      integrity('cancelled admission has no original authority proof')
    const link = this.get<{ commit_id: string; proof_json: string; proof_digest: string }>(
      'SELECT commit_id,proof_json,proof_digest FROM runtime_admission_source_proofs WHERE ticket_id = ?',
      ticketId,
    )
    if (
      !link ||
      link.commit_id !== row.tombstone_id ||
      link.proof_json !== row.proof_json ||
      link.proof_digest !== row.body_digest
    )
      integrity('cancelled ticket lost original authority proof link')
    const proof = this.parseJson<RuntimeAdmissionProof>(
      row.proof_json,
      'admission cancellation proof is invalid',
    )
    const { body_digest, ...body } = row
    if (
      digestOf(body) !== body_digest ||
      digestOf(proof) !== row.proof_digest ||
      row.source_digest !== proof.sourceDigest ||
      !sameJson(this.parseJson(row.authority_json, 'admission authority invalid'), this.authority) ||
      !sameJson(this.parseJson(row.source_json, 'admission source invalid'), proof.facts) ||
      proof.facts.admission.ticketId !== ticketId ||
      proof.facts.admission.fingerprint !== row.fingerprint
    )
      integrity('admission tombstone original proof differs')
    const source = this.admissionSource.readHistorical(proof, this.authority)
    if (
      !sameJson(source.decision, {
        ticketId,
        fingerprint: row.fingerprint,
        sourceDigest: proof.sourceDigest,
        kind: 'cancelled',
        targetId: row.tombstone_id,
        bodyDigest: row.body_digest,
      })
    )
      integrity('cancelled admission differs from original issuer consumption')
    source.staticCheck()
    return { state: 'cancelled', tombstoneId: row.tombstone_id }
  }

  private verifyCreatedAdmissionSource(
    row: AdmissionRow,
    probe: AdmissionProbe,
    expected?: RuntimeAdmissionProof,
  ): void {
    if (probe.state !== 'created' || !this.admissionSource) integrity('created admission source unavailable')
    const original = this.get<{ commit_id: string; proof_json: string; proof_digest: string }>(
      'SELECT commit_id, proof_json, proof_digest FROM runtime_admission_source_proofs WHERE ticket_id = ?',
      row.ticket_id,
    )
    if (!original || original.commit_id !== probe.commit.commitId)
      integrity('created admission lost original source proof')
    const proof = this.parseJson<RuntimeAdmissionProof>(
      original.proof_json,
      'created admission source invalid',
    )
    if (digestOf(proof) !== original.proof_digest || (expected !== undefined && !sameJson(proof, expected)))
      integrity('created admission original source changed')
    const source = this.admissionSource.readHistorical(proof, this.authority)
    if (
      !sameJson(source.decision, {
        ticketId: row.ticket_id,
        fingerprint: row.fingerprint,
        sourceDigest: proof.sourceDigest,
        kind: 'created',
        targetId: probe.commit.commitId,
        bodyDigest: digestOf(probe),
      })
    )
      integrity('created admission differs from original issuer consumption')
    source.staticCheck()
    const binding = this.get<{ value_json: string }>(
      'SELECT value_json FROM runtime_records WHERE record_id = ?',
      runBindingRecordId(row.run_id),
    )
    if (
      !binding ||
      !sameJson(this.parseJson(binding.value_json, 'run binding invalid'), proof.facts.runBinding)
    )
      integrity('created run binding differs from original ticket')
  }

  private async originalAdmission(capture: RuntimeAdmissionCapture): Promise<AdmissionProbe> {
    const ticketId = capture.proof.facts.admission.ticketId
    const originalDecision = capture.readDecision()
    const tombstone = this.admissionTombstone(ticketId)
    if (tombstone) return tombstone
    const row = this.get<AdmissionRow>(
      'SELECT ticket_id, fingerprint, run_id, probe_json FROM runtime_admissions WHERE ticket_id = ?',
      ticketId,
    )
    if (row) {
      const verified = await this.requireSession(capture.proof.facts.admission.sessionId)
      const probe = this.rebuildStoredAdmission(row, verified, capture.proof.facts.admission.sessionId)
      if (
        !sameJson(this.parseJson(row.probe_json, 'admission probe invalid'), probe) ||
        row.fingerprint !== capture.proof.facts.admission.fingerprint ||
        probe.state !== 'created' ||
        probe.commit.transactionFingerprint !== digestOf(capture.proof.facts.admission)
      )
        integrity('original admission differs from attested creation')
      this.verifyCreatedAdmissionSource(row, probe, capture.proof)
      return probe
    }
    const original = this.get(
      "SELECT v.record_id FROM runtime_record_versions v JOIN runtime_version_bodies b ON b.record_id = v.record_id AND b.record_revision = v.record_revision WHERE json_extract(b.value_json, '$.admissionTicketId') = ? LIMIT 1",
      ticketId,
    )
    if (
      originalDecision ||
      original ||
      this.get('SELECT ticket_id FROM runtime_admission_source_proofs WHERE ticket_id = ?', ticketId)
    )
      integrity('admission index absent but original decision remains')
    return { state: 'absent' }
  }

  async probeAdmission(ticketId: string, context: CallContext): Promise<AdmissionProbe> {
    const capture = this.captureAdmission('probe', { ticketId }, context)
    let check: (() => void) | undefined
    return this.interactionReadSnapshot(
      async () => {
        capture.readDecision()
        capture.dynamicCheck()
        const result = await this.originalAdmission(capture)
        if (result.state === 'absent')
          refuse(
            'denied',
            'admission_absence_unproven',
            'authority completeness proof for admission absence is not installed',
          )
        check = captureAdmissionStateFence(this.db)
        return result
      },
      () => {
        capture.dynamicCheck()
        capture.finalCheck(() => {
          if (!check) integrity('admission read seal absent')
          check()
        })
      },
    )
  }

  async cancelAdmission(
    ticketId: string,
    fingerprint: string,
    context: CallContext,
  ): Promise<AdmissionProbe> {
    const capture = this.captureAdmission('cancel', { ticketId, fingerprint }, context)
    let check: (() => void) | undefined
    return this.tx(
      'cancelAdmission',
      ticketId,
      async () => {
        capture.readDecision()
        capture.dynamicCheck()
        let probe = await this.originalAdmission(capture)
        if (probe.state === 'absent') {
          const body = {
            ticket_id: ticketId,
            fingerprint,
            tombstone_id: stableId('admission-cancel', `${this.authority.authorityId}\0${ticketId}`),
            authority_json: JSON.stringify(this.authority),
            source_json: JSON.stringify(capture.proof.facts),
            source_digest: capture.proof.sourceDigest,
            created_at: new Date(this.now()).toISOString(),
            proof_json: JSON.stringify(capture.proof),
            proof_digest: digestOf(capture.proof),
          }
          this.run(
            'INSERT INTO runtime_admission_tombstones (ticket_id,fingerprint,tombstone_id,authority_json,source_json,source_digest,created_at,proof_json,proof_digest,body_digest) VALUES (?,?,?,?,?,?,?,?,?,?)',
            ...Object.values(body),
            digestOf(body),
          )
          this.run(
            'INSERT INTO runtime_admission_source_proofs (ticket_id,commit_id,proof_json,proof_digest) VALUES (?,?,?,?)',
            ticketId,
            body.tombstone_id,
            body.proof_json,
            digestOf(body),
          )
          capture.recordDecision({
            ticketId,
            fingerprint,
            sourceDigest: capture.proof.sourceDigest,
            kind: 'cancelled',
            targetId: body.tombstone_id,
            bodyDigest: digestOf(body),
          })
          this.pendingWrite = true
          probe = { state: 'cancelled', tombstoneId: body.tombstone_id }
        }
        check = captureAdmissionStateFence(this.db)
        return probe
      },
      () => {
        capture.dynamicCheck()
        capture.finalCheck(() => {
          if (!check) integrity('admission cancellation seal absent')
          check()
        })
      },
    )
  }

  async admitInvocation(request: InvocationAdmission): Promise<AdmitInvocationResult> {
    return this.finishControl(
      await this.tx('admitInvocation', request.requestId, () =>
        admitInvocationTx(this.controlPorts(), request),
      ),
    )
  }

  async closeInvocation(request: CloseInvocationRequest): Promise<CloseInvocationResult> {
    return this.finishControl(
      await this.tx('closeInvocation', request.requestId, () =>
        closeInvocationTx(this.controlPorts(), request),
      ),
    )
  }

  async advanceRun(request: AdvanceRunRequest): Promise<StateCommitReceipt> {
    return this.finishControl(
      await this.tx('advanceRun', request.commitId, () => advanceRunTx(this.controlPorts(), request)),
    )
  }

  async dispatchAdmission(request: DispatchAdmissionRequest): Promise<DispatchAdmissionResult> {
    return this.finishControl(
      await this.tx('dispatchAdmission', request.admissionId, () =>
        dispatchAdmissionTx(this.controlPorts(), request),
      ),
    )
  }

  probeDispatchAdmission(admissionId: string): DispatchAdmissionProbe {
    return probeDispatchTx(this.controlPorts(), admissionId)
  }

  async commitControl(request: CommitControlRequest): Promise<StateCommitReceipt> {
    return this.finishControl(
      await this.tx('commitControl', request.commitId, () => commitControlTx(this.controlPorts(), request)),
    )
  }

  /** Default qualified providers share one State transaction; independent providers never enter here. */
  async prepareApproval(input: ApprovalPreparationInput): Promise<InteractionRecord> {
    const sources = this.requireApprovalOwner(input.context, input.preparation.guard.sessionId)
    const selectedOwner = canonicalJson(sources.owner)
    const result = await this.tx(
      'prepareApproval',
      input.preparation.commitId,
      async () => {
        const meta = this.sessionMeta(input.preparation.guard.sessionId)
        if (!meta) refuse('invalid_input', 'session_absent', 'approval session is absent')
        const verified = await this.verifySessionFully(meta)
        this.beginStaging(input.preparation.commitId)
        try {
          const record = await prepareApprovalInTransaction(
            this.approvalPorts(sources, input.context, input.preparation.guard.sessionId, verified),
            input,
          )
          this.requireApprovalOwner(input.context, input.preparation.guard.sessionId)
          const flushed = this.flushStaging()
          return {
            result: record,
            sessionId: input.preparation.guard.sessionId,
            verified: flushed?.verified ?? verified,
          }
        } finally {
          this.clearStaging()
        }
      },
      () => {
        this.requireApprovalOwner(input.context, input.preparation.guard.sessionId)
        if (canonicalJson(sources.owner) !== selectedOwner)
          refuse('denied', 'approval_owner', 'selected approval owner changed before commit')
      },
    )
    return this.finishControl(result)
  }

  async resolveApproval(input: ApprovalResolutionInput): Promise<InteractionResponseStatus> {
    let finalCheck: (() => void) | undefined
    const result = await this.tx(
      'resolveApproval',
      input.request.responseId,
      async () => {
        const initial = this.get<{ commit_id: string }>(
          'SELECT commit_id FROM runtime_record_versions WHERE record_id=? AND record_revision=1',
          `interaction:${input.request.interactionId}`,
        )
        if (!initial) refuse('invalid_input', 'interaction_absent', 'approval interaction is absent')
        const event = this.approvalEvent(initial.commit_id)
        const sources = this.requireApprovalOwner(input.context, event.session_key)
        const selectedOwner = canonicalJson(sources.owner)
        const responder = canonicalJson(sources.currentResponder(input.context, input.authentication))
        finalCheck = () => {
          this.requireApprovalOwner(input.context, event.session_key)
          if (canonicalJson(sources.owner) !== selectedOwner)
            refuse('denied', 'approval_owner', 'selected approval owner changed before commit')
          if (canonicalJson(sources.currentResponder(input.context, input.authentication)) !== responder)
            refuse('denied', 'approval_responder', 'actual approval responder changed before commit')
        }
        const meta = this.sessionMeta(event.session_key)
        if (!meta) integrity('approval original physical session is absent')
        const verified = await this.verifySessionFully(meta)
        this.beginStaging(
          stableId(
            'approval-resolve',
            canonicalJson({
              authority: sources.owner.authority,
              scope: sources.owner.scope,
              responseId: input.request.responseId,
            }),
          ),
        )
        try {
          const status = await resolveApprovalInTransaction(
            this.approvalPorts(sources, input.context, event.session_key, verified),
            input,
          )
          finalCheck()
          const flushed = this.flushStaging()
          return { result: status, sessionId: event.session_key, verified: flushed?.verified ?? verified }
        } finally {
          this.clearStaging()
        }
      },
      () => {
        if (!finalCheck) integrity('approval final source check is absent')
        finalCheck()
      },
    )
    return this.finishControl(result)
  }

  async readInteraction(interactionId: string, context: CallContext): Promise<InteractionRecord> {
    return this.interactionQueries(context).read(interactionId, context)
  }

  async readInteractionResponseStatus(
    responseId: string,
    context: CallContext,
  ): Promise<InteractionResponseStatus> {
    return this.interactionQueries(context).responseStatus(responseId, context)
  }

  async pendingInteractions(
    request: InteractionClientPendingRequest,
    context: CallContext,
  ): Promise<PageInteractionRecord> {
    return this.interactionQueries(context).pending(request, context)
  }

  private interactionQueries(context: CallContext) {
    const source = this.interactionRead
    if (
      !source ||
      !validateRuntime('RecordOwner', source.owner).ok ||
      source.owner.ownerBinding.contract !== 'agh.interaction' ||
      context.bindingId !== source.owner.ownerBinding.bindingId ||
      !sameJson(context.scope, source.owner.scope)
    )
      refuse('denied', 'interaction_owner', 'current selected interaction read owner is unavailable')
    const selectedOwner = canonicalJson(source.owner)
    let lastReader: InteractionReader | undefined
    let absentRealm: string | undefined
    const scopeSession = (reader: InteractionReader): string => {
      if (reader.scope.kind !== 'session')
        refuse('conflict', 'interaction_unavailable', 'complete workspace membership source is unavailable')
      const sourceScope = source.owner.scope as Record<string, unknown>
      const readerScope = reader.scope as Record<string, unknown>
      if (Object.entries(sourceScope).some(([key, value]) => key !== 'kind' && readerScope[key] !== value))
        refuse('denied', 'interaction_scope', 'reader realm differs from the selected source owner')
      return reader.scope.sessionId
    }
    const verify = async (reader: InteractionReader) => {
      lastReader = reader
      const sessionId = scopeSession(reader)
      const meta = this.sessionMeta(sessionId)
      if (!meta)
        refuse('conflict', 'interaction_unavailable', 'authoritative response session is unavailable')
      const verified = await this.verifySessionFully(meta)
      if (verified.workspaceId !== reader.scope.workspaceId)
        refuse('denied', 'interaction_scope', 'physical State workspace differs from the reader realm')
      return { sessionId, verified }
    }
    const original = (
      id: string,
      schema: SchemaRef,
      sessionId: string,
      revision?: number,
    ): VersionRow | undefined => {
      const selected =
        revision === undefined
          ? this.get<{ record_revision: number }>(
              'SELECT record_revision FROM runtime_record_heads WHERE record_id=?',
              id,
            )
          : this.get<{ record_revision: number }>(
              'SELECT record_revision FROM runtime_record_versions WHERE record_id=? AND record_revision=?',
              id,
              revision,
            )
      if (!selected) return undefined
      const version = this.recordVersion(id, selected.record_revision)
      if (
        !sameJson(this.parseJson(version.schema_json, 'interaction source schema invalid'), schema) ||
        !sameJson(this.parseJson(version.owner_json, 'interaction source owner invalid'), source.owner)
      )
        refuse('denied', 'interaction_source', 'interaction does not belong to the selected reader source')
      if (this.approvalEvent(version.commit_id).session_key !== sessionId)
        refuse('denied', 'interaction_scope', 'interaction original commit belongs to another session')
      return version
    }
    const sourceId = (prefix: string, id: string) =>
      stableId(
        prefix,
        canonicalJson({
          authority: source.owner.authority,
          binding: source.owner.ownerBinding,
          scope: source.owner.scope,
          id,
        }),
      )
    const readRecord = (version: VersionRow): InteractionRecord => {
      const parsed = validateRuntime(
        'InteractionRecord',
        this.parseJson(version.value_json, 'interaction original record invalid'),
      )
      if (
        !parsed.ok ||
        version.record_id !== `interaction:${parsed.value.interactionId}` ||
        version.record_revision !== parsed.value.version
      )
        integrity('interaction original identity or version differs')
      return parsed.value
    }
    return createInteractionReads(source, {
      snapshot: (body) =>
        this.interactionReadSnapshot(body, () => {
          const finalReader = source.current(context, lastReader?.scope)
          if (lastReader && !sameJson(finalReader, lastReader))
            refuse('denied', 'interaction_reader', 'interaction reader changed before read completion')
          if (absentRealm !== undefined && source.responseRealmComplete?.(context, absentRealm) !== true)
            refuse(
              'conflict',
              'interaction_unavailable',
              'complete response realm changed before read completion',
            )
          // No owner callbacks remain after this synchronous tail fence and before COMMIT.
          const at = source.now()
          const owner = canonicalJson(source.owner)
          if (context.signal.aborted || !(Date.parse(context.deadline) > at) || owner !== selectedOwner)
            refuse('denied', 'interaction_current', 'interaction reader source is no longer current')
        }),
      read: async (id, reader) => {
        const { sessionId } = await verify(reader)
        const version = original(`interaction:${id}`, RuntimeSchemaRefs.InteractionRecord, sessionId)
        return version ? readRecord(version) : undefined
      },
      response: async (id, reader) => {
        const { sessionId } = await verify(reader)
        const raw = original(
          sourceId('approval-response-source', id),
          RuntimeSchemaRefs.ApprovalRespondRequest,
          sessionId,
          1,
        )
        if (!raw) {
          // An answered interaction without this known raw source is not authoritative absence.
          const other = this.all<{ record_id: string; record_revision: number }>(
            "SELECT v.record_id,v.record_revision FROM runtime_record_versions v JOIN events e ON json_extract(e.data,'$.commitId')=v.commit_id WHERE e.type=? AND e.session_key=?",
            STATE_COMMIT_EVENT,
            sessionId,
          )
          for (const candidate of other) {
            const version = this.recordVersion(candidate.record_id, candidate.record_revision)
            if (
              !sameJson(
                this.parseJson(version.schema_json, 'interaction candidate schema invalid'),
                RuntimeSchemaRefs.InteractionRecord,
              ) ||
              !sameJson(
                this.parseJson(version.owner_json, 'interaction candidate owner invalid'),
                source.owner,
              )
            )
              continue
            const record = readRecord(version)
            if (record.status === 'answered' && record.resolution.responseId === id)
              refuse(
                'conflict',
                'interaction_unavailable',
                'response identity exists without a supported complete source',
              )
          }
          return undefined
        }
        const request = validateRuntime(
          'ApprovalRespondRequest',
          this.parseJson(raw.value_json, 'interaction response raw source invalid'),
        )
        if (!request.ok || request.value.responseId !== id)
          integrity('interaction raw response identity differs')
        const answer = original(
          `interaction:${request.value.interactionId}`,
          RuntimeSchemaRefs.InteractionRecord,
          sessionId,
          request.value.expectedVersion + 1,
        )
        if (!answer || answer.commit_id !== raw.commit_id)
          integrity('interaction original response membership differs')
        const record = readRecord(answer)
        if (record.status !== 'answered' || record.resolution.responseId !== id)
          integrity('interaction answer does not prove this response')
        const expectedAnswer =
          request.value.decision === 'approve'
            ? {
                decision: 'approve',
                intentDigest: request.value.intentDigest,
                grantScope: request.value.grantScope ?? 'once',
              }
            : { decision: 'deny', intentDigest: request.value.intentDigest }
        if (
          !sameJson(record.resolution.answer, {
            kind: 'inline',
            schema: RuntimeSchemaRefs.ApprovalAnswer,
            value: expectedAnswer,
            digest: digestOf(expectedAnswer),
            bytes: Buffer.byteLength(canonicalJson(expectedAnswer)),
          })
        )
          integrity('interaction original response differs from its raw request')
        const deliveryKey = `${record.interactionId}@${record.version}`
        const inboxRow = this.get<{ record_revision: number }>(
          'SELECT record_revision FROM runtime_record_heads WHERE record_id=?',
          sourceId('approval-inbox', deliveryKey),
        )
        let runtimeAdmission: 'pending' | 'acknowledged' = 'pending'
        if (inboxRow) {
          const inboxVersion = this.recordVersion(
            sourceId('approval-inbox', deliveryKey),
            inboxRow.record_revision,
          )
          const inbox = validateRuntime(
            'InboxRecord',
            this.parseJson(inboxVersion.value_json, 'interaction inbox original invalid'),
          )
          const runHead = this.controlPorts().loadHead(runRecordId(record.owner.runId))
          if (!runHead || !inbox.ok) integrity('interaction required target inbox is invalid')
          const runOwner = this.parseJson<RecordOwner>(runHead.owner_json, 'interaction target owner invalid')
          const wake = {
            deliveryKey,
            interactionId: record.interactionId,
            owner: record.owner,
            version: record.version,
            status: record.status,
            responseId: id,
          }
          const payload = {
            kind: 'inline',
            schema: RuntimeSchemaRefs.InteractionRecord,
            value: record,
            digest: digestOf(record),
            bytes: Buffer.byteLength(canonicalJson(record)),
          }
          if (
            !sameJson(
              this.parseJson(inboxVersion.schema_json, 'interaction inbox schema invalid'),
              RuntimeSchemaRefs.InboxRecord,
            ) ||
            !sameJson(this.parseJson(inboxVersion.owner_json, 'interaction inbox owner invalid'), runOwner) ||
            inboxVersion.commit_id !== raw.commit_id ||
            inbox.value.appliedCommitId !== raw.commit_id ||
            inbox.value.sourceAuthorityId !== source.owner.authority.authorityId ||
            inbox.value.eventId !== deliveryKey ||
            inbox.value.consumerId !== runOwner.ownerBinding.bindingId ||
            inbox.value.fingerprint !== digestOf(wake) ||
            !sameJson(inbox.value.acknowledgement, payload)
          )
            integrity('interaction Runtime acknowledgement provenance differs')
          const signalId = stableId(
            'approval-signal',
            canonicalJson({
              sourceAuthorityId: inbox.value.sourceAuthorityId,
              eventId: deliveryKey,
              consumerId: inbox.value.consumerId,
            }),
          )
          const signalExists = this.get<{ record_id: string }>(
            'SELECT record_id FROM runtime_record_versions WHERE record_id=? AND record_revision=1',
            signalRecordId(signalId),
          )
          if (!signalExists) integrity('interaction inbox has no original target signal')
          const signalVersion = this.recordVersion(signalRecordId(signalId), 1)
          if (
            signalVersion.commit_id !== raw.commit_id ||
            !sameJson(
              this.parseJson(signalVersion.schema_json, 'interaction signal schema invalid'),
              RuntimeSchemaRefs.SignalRecordValue,
            ) ||
            !sameJson(this.parseJson(signalVersion.owner_json, 'interaction signal owner invalid'), runOwner)
          )
            integrity('interaction inbox has no same-commit original target signal')
          const signal = this.parseJson<{ signal: Signal }>(
            signalVersion.value_json,
            'interaction target signal invalid',
          ).signal
          if (
            !signal ||
            signal.signalId !== signalId ||
            signal.runId !== record.owner.runId ||
            signal.targetActionId !== record.owner.actionId ||
            !sameJson(signal.source, source.owner.ownerBinding) ||
            !sameJson(signal.payload, payload) ||
            signal.causation?.interactionId !== record.interactionId ||
            signal.causation?.externalEventId !== deliveryKey
          )
            integrity('interaction Runtime signal acknowledgement differs')
          runtimeAdmission = 'acknowledged'
        }
        return {
          status: {
            interactionId: record.interactionId,
            responseId: id,
            status: 'accepted' as const,
            version: record.version,
            result: record,
            error: null,
          },
          runtimeAdmission,
        }
      },
      responseRealmComplete: async (reader) => {
        const { sessionId } = await verify(reader)
        const complete = source.responseRealmComplete?.(context, sessionId) === true
        if (complete) absentRealm = sessionId
        return complete
      },
      cut: async (scope, reader) => {
        const { sessionId, verified } = await verify(reader)
        const membership = {
          stateAuthority: this.authority,
          sessionId,
          throughSeq: verified.lastSeq,
          headDigest: verified.headDigest,
        }
        return { scope, snapshot: interactionCutIdentity(membership), membership }
      },
      recordsAt: async (cut: InteractionReadCut, reader) => {
        const { sessionId, verified } = await verify(reader)
        const membership = validateRuntime('JsonValue', cut.membership)
        if (
          !membership.ok ||
          !cut.membership ||
          typeof cut.membership !== 'object' ||
          Array.isArray(cut.membership)
        )
          integrity('interaction cut membership is invalid')
        const watermark = cut.membership as {
          stateAuthority?: unknown
          sessionId?: unknown
          throughSeq?: unknown
          headDigest?: unknown
        }
        if (
          !sameJson(watermark.stateAuthority, this.authority) ||
          watermark.sessionId !== sessionId ||
          typeof watermark.throughSeq !== 'number' ||
          !Number.isSafeInteger(watermark.throughSeq) ||
          watermark.throughSeq < 1 ||
          watermark.throughSeq > verified.lastSeq ||
          interactionCutIdentity(cut.membership) !== cut.snapshot
        )
          integrity('interaction cut has no original State watermark')
        const prefix = this.get<{ integrity_digest: string | null }>(
          'SELECT integrity_digest FROM events WHERE session_key=? AND seq=?',
          sessionId,
          watermark.throughSeq,
        )
        if (!prefix || prefix.integrity_digest !== watermark.headDigest)
          integrity('interaction cut original ledger prefix differs')
        const changes = this.all<ManifestRow>(
          `SELECT m.commit_id,m.record_id,m.previous_revision,m.next_json FROM runtime_mutation_manifests m JOIN events e ON json_extract(e.data,'$.commitId')=m.commit_id WHERE e.type=? AND e.session_key=? AND e.seq<=? ORDER BY e.seq DESC,m.record_id`,
          STATE_COMMIT_EVENT,
          sessionId,
          watermark.throughSeq,
        )
        const records: InteractionRecord[] = []
        const seen = new Set<string>()
        for (const change of changes) {
          if (seen.has(change.record_id)) continue
          seen.add(change.record_id)
          if (change.next_json === null) continue
          const next = this.parseJson<MutationNext>(change.next_json, 'interaction cut last mutation invalid')
          if (!sameJson(next.schema, RuntimeSchemaRefs.InteractionRecord)) continue
          const version = this.recordVersion(change.record_id, next.recordRevision)
          if (
            version.commit_id !== change.commit_id ||
            version.digest !== next.digest ||
            !sameJson(this.parseJson(version.schema_json, 'interaction cut schema invalid'), next.schema)
          )
            integrity('interaction cut version differs from its last original mutation')
          if (!sameJson(this.parseJson(version.owner_json, 'interaction cut owner invalid'), source.owner))
            continue
          records.push(readRecord(version))
        }
        return records
      },
    })
  }

  private interactionReadSnapshot<T>(body: () => Promise<T>, finalCheck: () => void): Promise<T> {
    const run = this.writeChain.then(async () => {
      if (this.closed) refuse('internal', 'closed', 'State store is closed')
      const queryOnly = this.get<{ query_only: number }>('PRAGMA query_only')?.query_only ?? 0
      this.db.exec('PRAGMA query_only=ON')
      let opened = false
      try {
        this.execBoundary('BEGIN DEFERRED', 'begin')
        opened = true
        const result = await body()
        finalCheck()
        this.execBoundary('COMMIT', 'commit')
        opened = false
        return result
      } catch (error) {
        if (opened) this.db.exec('ROLLBACK')
        throw error
      } finally {
        this.db.exec(queryOnly ? 'PRAGMA query_only=ON' : 'PRAGMA query_only=OFF')
      }
    })
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private requireApprovalOwner(context: CallContext, sessionId: string): RuntimeApprovalJointOwner {
    const source = this.approvalJoint
    if (
      !source ||
      !source.assertJoint ||
      !source.currentResponder ||
      !source.ask ||
      !validateRuntime('RecordOwner', source.owner).ok ||
      source.owner.ownerBinding.contract !== 'agh.interaction' ||
      context.bindingId !== source.owner.ownerBinding.bindingId ||
      !sameJson(context.scope, source.owner.scope)
    )
      refuse('denied', 'approval_owner', 'actual selected default approval joint owners are missing')
    if (source.assertJoint(context, this.authority, sessionId) !== undefined)
      refuse('denied', 'approval_owner', 'approval joint qualification must finish synchronously')
    if (context.signal.aborted || !(Date.parse(context.deadline) > this.now()))
      refuse('denied', 'approval_current', 'approval caller is no longer current')
    return source
  }

  private approvalEvent(commitId: string): { session_key: string; data: string } {
    const events = this.all<{ session_key: string; data: string }>(
      "SELECT session_key,data FROM events WHERE type=? AND json_extract(data,'$.commitId')=?",
      STATE_COMMIT_EVENT,
      commitId,
    )
    const event = events[0]
    if (events.length !== 1 || !event) integrity('approval source has no unique physical original commit')
    return event
  }

  private approvalPorts(
    sources: RuntimeApprovalJointOwner,
    context: CallContext,
    sessionId: string,
    verified: VerifiedSession,
  ): ApprovalJointPorts {
    const owner = sources.owner
    const storageId = (id: string) => `interaction:${id}`
    const sourceId = (prefix: string, id: string) =>
      stableId(
        prefix,
        canonicalJson({
          authority: owner.authority,
          binding: owner.ownerBinding,
          scope: owner.scope,
          id,
        }),
      )
    const checkedHead = (id: string, schema: SchemaRef) => {
      const head = this.controlPorts().loadHead(id)
      if (!head) return undefined
      if (
        !sameJson(this.parseJson(head.schema_json, 'approval schema invalid'), schema) ||
        !sameJson(this.parseJson(head.owner_json, 'approval owner invalid'), owner)
      )
        integrity('approval source codec or original selected owner differs')
      return head
    }
    const original = (id: string, schema: SchemaRef, revision = 1): VersionRow | undefined => {
      const found = this.get<{ record_id: string }>(
        'SELECT record_id FROM runtime_record_versions WHERE record_id=? AND record_revision=?',
        id,
        revision,
      )
      if (!found) return undefined
      const version = this.recordVersion(id, revision)
      if (
        !sameJson(this.parseJson(version.schema_json, 'approval original schema invalid'), schema) ||
        !sameJson(this.parseJson(version.owner_json, 'approval original owner invalid'), owner) ||
        this.approvalEvent(version.commit_id).session_key !== sessionId
      )
        integrity('approval immutable source belongs to another physical owner')
      return version
    }
    const readRecord = (id: string): InteractionRecord | undefined => {
      const head = checkedHead(storageId(id), RuntimeSchemaRefs.InteractionRecord)
      if (!head) return undefined
      const parsed = validateRuntime(
        'InteractionRecord',
        this.parseJson(head.value_json, 'approval record invalid'),
      )
      if (!parsed.ok || parsed.value.interactionId !== id || parsed.value.version !== head.record_revision)
        integrity('approval record identity or version differs')
      return parsed.value
    }
    const fullResponse = (responseId: string) => {
      const raw = original(
        sourceId('approval-response-source', responseId),
        RuntimeSchemaRefs.ApprovalRespondRequest,
      )
      if (!raw) return undefined
      const request = validateRuntime(
        'ApprovalRespondRequest',
        this.parseJson(raw.value_json, 'approval response source invalid'),
      )
      if (!request.ok || request.value.responseId !== responseId)
        integrity('approval response source identity differs')
      const version = original(
        storageId(request.value.interactionId),
        RuntimeSchemaRefs.InteractionRecord,
        request.value.expectedVersion + 1,
      )
      if (!version || version.commit_id !== raw.commit_id)
        integrity('approval response is outside its original answer membership')
      const parsed = validateRuntime(
        'InteractionRecord',
        this.parseJson(version.value_json, 'approval answer original invalid'),
      )
      if (
        !parsed.ok ||
        parsed.value.status !== 'answered' ||
        parsed.value.resolution.responseId !== responseId ||
        parsed.value.interactionId !== request.value.interactionId
      )
        integrity('approval answer source differs')
      const record = parsed.value
      const expectedAnswer =
        request.value.decision === 'approve'
          ? {
              decision: 'approve',
              intentDigest: request.value.intentDigest,
              grantScope: request.value.grantScope ?? 'once',
            }
          : { decision: 'deny', intentDigest: request.value.intentDigest }
      if (
        !sameJson(record.resolution.answer, {
          kind: 'inline',
          schema: RuntimeSchemaRefs.ApprovalAnswer,
          value: expectedAnswer,
          digest: digestOf(expectedAnswer),
          bytes: Buffer.byteLength(canonicalJson(expectedAnswer)),
        })
      )
        integrity('approval original raw response differs from its actual answer')
      const response: StoredInteractionResponse = {
        responseId,
        fingerprint: digestOf({
          method: 'respondApproval',
          interactionId: record.interactionId,
          expectedVersion: request.value.expectedVersion,
          actorRef: record.resolution.actorRef,
          answer: record.resolution.answer,
        }),
        status: {
          interactionId: record.interactionId,
          responseId,
          status: 'accepted',
          version: record.version,
          result: record,
          error: null,
        },
      }
      return {
        fingerprint: digestOf({
          method: 'respondApproval',
          request: request.value,
          actorRef: record.resolution.actorRef,
          evidence: record.resolution.evidence,
          bindingId: owner.ownerBinding.bindingId,
          scope: owner.scope,
        }),
        response,
      }
    }
    const stage = (id: string, schema: SchemaRef, value: unknown, recordOwner = owner) => {
      const previous = this.controlPorts().loadHead(id)
      if (
        previous &&
        (!sameJson(this.parseJson(previous.schema_json, 'approval prior schema invalid'), schema) ||
          !sameJson(this.parseJson(previous.owner_json, 'approval prior owner invalid'), recordOwner))
      )
        integrity('approval staged version belongs to another codec or owner')
      this.stageRecord(
        {
          recordId: id,
          schema,
          minReader: 2,
          recordRevision: (previous?.record_revision ?? 0) + 1,
          owner: recordOwner,
          value,
        },
        previous?.record_revision ?? null,
        !previous,
      )
    }
    const interaction: InteractionTransaction = {
      record: readRecord,
      recordByIdempotencyKey: (key) => {
        const records = this.all<{ record_id: string }>(
          "SELECT h.record_id FROM runtime_record_heads h JOIN runtime_version_bodies b USING(record_id,record_revision) WHERE h.schema_json=? AND h.owner_json=? AND json_extract(b.value_json,'$.request.idempotencyKey')=?",
          canonicalJson(RuntimeSchemaRefs.InteractionRecord),
          canonicalJson(owner),
          key,
        )
        let result: InteractionRecord | undefined
        for (const item of records) {
          const value = readRecord(item.record_id.slice('interaction:'.length))
          if (value) {
            if (result) integrity('approval idempotency key has multiple sources')
            result = value
          }
        }
        return result
      },
      response: (id) => fullResponse(id)?.response,
      putRecord: (record) =>
        stage(storageId(record.interactionId), RuntimeSchemaRefs.InteractionRecord, record),
      putResponse: () => integrity('approval response requires complete original input source'),
      wake: () => undefined,
      dueWakes: () => [],
      putWake: () => {},
    }
    return {
      now: () => new Date(this.now()).toISOString(),
      assertTransaction: () => {
        if (!this.db.isTransaction || !this.staging)
          integrity('approval original State staging transaction is absent')
      },
      assertJoint: (call) => {
        this.requireApprovalOwner(call, sessionId)
      },
      currentResponder: (call, authentication) => sources.currentResponder(call, authentication),
      interaction,
      prepared: (id) => {
        const raw = original(
          sourceId('approval-prepare-source', id),
          RuntimeMethodSchemaRefs['agh.state'].commitControl.input,
        )
        if (!raw) return undefined
        const creation = original(storageId(id), RuntimeSchemaRefs.InteractionRecord)
        if (!creation || creation.commit_id !== raw.commit_id)
          integrity('approval preparation source is outside original question membership')
        const request = validateRuntime(
          'CommitControlRequest',
          this.parseJson(raw.value_json, 'approval preparation source invalid'),
        )
        const record = validateRuntime(
          'InteractionRecord',
          this.parseJson(creation.value_json, 'approval question source invalid'),
        )
        if (
          !request.ok ||
          !record.ok ||
          request.value.command.kind !== 'prepare_authorization' ||
          record.value.interactionId !== id ||
          !sameJson(request.value.command.preparation.approvalRequest, record.value.request)
        )
          integrity('approval complete preparation source differs')
        return {
          record: record.value,
          fingerprint: digestOf({
            request: record.value.request,
            owner: record.value.owner,
            preparation: request.value,
            bindingId: owner.ownerBinding.bindingId,
            scope: owner.scope,
          }),
        }
      },
      stagePreparation: async (id, _fingerprint, record, request) => {
        stage(
          sourceId('approval-prepare-source', id),
          RuntimeMethodSchemaRefs['agh.state'].commitControl.input,
          request,
        )
        await commitControlTx(this.controlPorts(), request)
        const ask = sources.ask(context, request, record)
        if (
          !ask ||
          ask.decision !== 'ask' ||
          ask.interactionId !== record.interactionId ||
          ask.actionId !== record.owner.actionId
        )
          refuse('denied', 'approval_ask', 'actual original policy ask decision source is missing')
        const askRequest: CommitControlRequest = {
          commitId: stableId('approval-ask', id),
          guard: request.guard,
          command: ask,
        }
        stage(
          sourceId('approval-ask-source', id),
          RuntimeMethodSchemaRefs['agh.state'].commitControl.input,
          askRequest,
        )
        await commitControlTx(this.controlPorts(), askRequest)
      },
      fullResponse,
      stageFullResponse: (fingerprint, response, request) => {
        const record = readRecord(request.interactionId)
        if (!record || record.status !== 'answered' || record.resolution.responseId !== response.responseId)
          integrity('approval answer was not staged')
        stage(
          sourceId('approval-response-source', request.responseId),
          RuntimeSchemaRefs.ApprovalRespondRequest,
          request,
        )
        const runHead = this.controlPorts().loadHead(runRecordId(record.owner.runId))
        const run =
          runHead &&
          validateRuntime('RunRecordValue', this.parseJson(runHead.value_json, 'approval actual run invalid'))
        if (!runHead || !run || !run.ok || run.value.sessionId !== sessionId)
          integrity('approval reply actual run is absent')
        this.writeCommit({
          sessionId,
          verified,
          commitId: this.staging!.commitId,
          at: new Date(this.now()).toISOString(),
          fingerprint,
          runId: run.value.runId,
          actionId: record.owner.actionId,
          writerEpoch: run.value.writerEpoch,
          runRevision: run.value.revision,
          actionIds: [],
          creates: [],
          updates: [],
          sides: [],
        })
      },
      stageResolvedWake: (wake) => {
        const record = readRecord(wake.wake.interactionId)
        if (
          !record ||
          record.status !== 'answered' ||
          wake.wake.deliveryKey !== `${record.interactionId}@${record.version}` ||
          wake.wake.responseId !== record.resolution.responseId ||
          !sameJson(wake.wake.owner, record.owner)
        )
          integrity('approval wake differs from actual answer')
        const runHead = this.controlPorts().loadHead(runRecordId(record.owner.runId))
        const run =
          runHead &&
          validateRuntime('RunRecordValue', this.parseJson(runHead.value_json, 'approval wake run invalid'))
        if (!runHead || !run || !run.ok) integrity('approval wake actual run is absent')
        const runOwner = this.parseJson<RecordOwner>(
          runHead.owner_json,
          'approval actual State owner invalid',
        )
        const payload: DataRef = {
          kind: 'inline',
          schema: RuntimeSchemaRefs.InteractionRecord,
          value: record as unknown as JsonValue,
          digest: digestOf(record),
          bytes: Buffer.byteLength(canonicalJson(record)),
        }
        const sourceAuthorityId = owner.authority.authorityId,
          eventId = wake.wake.deliveryKey,
          consumerId = runOwner.ownerBinding.bindingId
        const inboxId = sourceId('approval-inbox', eventId)
        if (this.controlPorts().loadHead(inboxId))
          integrity('approval inbox terminal delivery was already applied')
        const next = this.get<{ seq: number }>(
          "SELECT MAX(json_extract(value_json,'$.inboxSeq')) AS seq FROM runtime_record_heads h JOIN runtime_version_bodies b USING(record_id,record_revision) WHERE schema_json=? AND json_extract(value_json,'$.consumerId')=?",
          canonicalJson(RuntimeSchemaRefs.InboxRecord),
          consumerId,
        )
        const inbox: InboxRecord = {
          sourceAuthorityId,
          eventId,
          consumerId,
          fingerprint: digestOf(wake.wake),
          receivedAt: new Date(this.now()).toISOString(),
          appliedCommitId: this.staging!.commitId,
          acknowledgement: payload,
          inboxSeq: (next?.seq ?? 0) + 1,
        }
        stage(inboxId, RuntimeSchemaRefs.InboxRecord, inbox, runOwner)
        const target = record.owner.actionId
        const current = this.get<{ next_seq: number }>(
          'SELECT next_seq FROM runtime_signal_seq WHERE run_id=? AND target_key=?',
          record.owner.runId,
          target,
        )
        const seq = current?.next_seq ?? 1
        if (!Number.isSafeInteger(seq) || seq < 1) integrity('approval signal sequence index is invalid')
        this.run(
          'INSERT INTO runtime_signal_seq(run_id,target_key,next_seq) VALUES(?,?,?) ON CONFLICT(run_id,target_key) DO UPDATE SET next_seq=excluded.next_seq',
          record.owner.runId,
          target,
          seq + 1,
        )
        const signalId = stableId(
          'approval-signal',
          canonicalJson({ sourceAuthorityId, eventId, consumerId }),
        )
        const signal: Signal = {
          signalId,
          runId: record.owner.runId,
          targetActionId: target,
          seq,
          typeId: RuntimeSchemaRefs.InteractionRecord.typeId,
          schema: RuntimeSchemaRefs.InteractionRecord,
          source: owner.ownerBinding,
          payload,
          createdAt: inbox.receivedAt,
          causation: { actionId: target, interactionId: record.interactionId, externalEventId: eventId },
        }
        stage(
          signalRecordId(signalId),
          SIGNAL_SCHEMA,
          { signal, targetRevisionAtCreation: run.value.revision, consumedByCommitId: null },
          runOwner,
        )
      },
    }
  }

  async intakeReceipt(request: ReceiptIntakeRequest): Promise<ReceiptIntakeResult> {
    return this.finishControl(
      await this.tx('intakeReceipt', request.intakeId, () => intakeReceiptTx(this.controlPorts(), request)),
    )
  }

  probeActionResult(request: ProbeActionResultRequest): ActionVisibilityValue | null {
    return probeActionResultTx(this.controlPorts(), request)
  }

  async admitQuery(request: QueryAdmission): Promise<AdmitQueryResult> {
    return admitQueryTx(this.controlPorts(), request)
  }

  async claimOutbox(request: ClaimOutboxRequest): Promise<ClaimOutboxResult> {
    return this.finishControl(
      await this.tx('claimOutbox', request.requestId, () => claimOutboxTx(this.controlPorts(), request)),
    )
  }

  async ackOutbox(request: AckOutboxRequest): Promise<AckOutboxResult> {
    return this.finishControl(
      await this.tx('ackOutbox', request.requestId, () => ackOutboxTx(this.controlPorts(), request)),
    )
  }

  async failOutbox(request: FailOutboxRequest): Promise<FailOutboxResult> {
    return this.finishControl(
      await this.tx('failOutbox', request.requestId, () => failOutboxTx(this.controlPorts(), request)),
    )
  }

  /** Admit, close, and advance of one invocation share one state-commit. */
  async commitPreparedAdvance(
    commitId: string,
    admit: InvocationAdmission,
    close: CloseInvocationRequest,
    advance: AdvanceRunRequest,
  ): Promise<StateCommitReceipt> {
    return this.finishControl(
      await this.tx('commitPreparedAdvance', commitId, async () => {
        this.beginStaging(commitId)
        try {
          const admitted = await admitInvocationTx(this.controlPorts(), admit)
          const closed = await closeInvocationTx(this.controlPorts(), close)
          const advanced = await advanceRunTx(this.controlPorts(), advance)
          const flushed = this.flushStaging()
          const verified = flushed?.verified ?? closed.verified ?? admitted.verified
          return {
            result: advanced.result,
            sessionId: advanced.sessionId,
            ...(verified ? { verified } : {}),
          }
        } finally {
          this.clearStaging()
        }
      }),
    )
  }

  /** One model tool batch. A business rejection is committed per admission; a thrown refusal rolls the transaction back. */
  async commitDispatchBatch(
    commitId: string,
    requests: readonly DispatchAdmissionRequest[],
  ): Promise<DispatchAdmissionResult[]> {
    const first = requests[0]
    if (!first) return []
    return this.finishControl(
      await this.tx('dispatchAdmission', commitId, async () => {
        this.beginStaging(commitId)
        try {
          const results: DispatchAdmissionResult[] = []
          let sessionId = first.guard.sessionId
          let verified: VerifiedSession | undefined
          for (const request of requests) {
            const step = await dispatchAdmissionTx(this.controlPorts(), request)
            results.push(step.result)
            sessionId = step.sessionId
            if (step.verified) verified = step.verified
          }
          const flushed = this.flushStaging()
          const verifiedHead = flushed?.verified ?? verified
          return {
            result: results,
            sessionId,
            ...(verifiedHead ? { verified: verifiedHead } : {}),
          }
        } finally {
          this.clearStaging()
        }
      }),
    )
  }

  async ackOutboxMany(requests: readonly AckOutboxRequest[]): Promise<AckOutboxResult[]> {
    const first = requests[0]
    if (!first) return []
    return this.finishControl(
      await this.tx('ackOutbox', first.requestId, async () => {
        const results: AckOutboxResult[] = []
        let sessionId = ''
        for (const request of requests) {
          const step = await ackOutboxTx(this.controlPorts(), request)
          results.push(step.result)
          sessionId = step.sessionId
        }
        return { result: results, sessionId }
      }),
    )
  }

  private finishControl<T>(committed: { result: T; sessionId: string; verified?: VerifiedSession }): T {
    if (committed.verified) this.rememberVerified(committed.sessionId, committed.verified)
    return committed.result
  }

  private createRunRecords(
    input: CreateRunInput,
    owner: RecordOwner,
    creatingSession: boolean,
  ): StoredRecord[] {
    const run: StoredRecord = {
      recordId: runRecordId(input.admission.runId),
      schema: RUN_RECORD_SCHEMA,
      minReader: MIN_READER,
      recordRevision: 1,
      owner,
      value: {
        runId: input.admission.runId,
        sessionId: input.admission.sessionId,
        lane: input.admission.lane,
        admissionTicketId: input.admission.ticketId,
        bindingId: input.admission.bindingId,
        input: input.admission.input,
        conversation: input.admission.conversation,
        deadline: input.admission.deadline,
        revision: 0,
        state: 'admitted',
        continuation: null,
        writerEpoch: 0,
        waitId: null,
        cancellation: null,
        terminal: null,
        suspension: null,
      },
    }
    const taint: StoredRecord = {
      recordId: taintRecordId(input.admission.runId),
      schema: RUN_TAINT_SCHEMA,
      minReader: MIN_READER,
      recordRevision: 1,
      owner,
      value: { runId: input.admission.runId, sourceSeq: 0, clearedThroughSeq: 0 },
    }
    if (!creatingSession) return [run, taint]
    const identity: StoredRecord = {
      recordId: sessionIdentityRecordId(input.admission.sessionId),
      schema: SESSION_IDENTITY_SCHEMA,
      minReader: MIN_READER,
      recordRevision: 1,
      owner,
      value: {
        sessionId: input.admission.sessionId,
        workspaceId: input.admission.workspaceId,
        formatVersion: FORMAT_VERSION,
        runtimeSchemaMajor: RUNTIME_SCHEMA_MAJOR,
        minReader: MIN_READER,
        parent: null,
      } satisfies SessionIdentityValue,
    }
    const lease: StoredRecord = {
      recordId: this.leaseRecordId(input.admission.sessionId),
      schema: STATE_LEASE_SCHEMA,
      minReader: 2,
      recordRevision: 1,
      owner,
      value: {
        sessionId: input.admission.sessionId,
        lastWriterEpoch: 0,
        claim: null,
      } satisfies StateLeaseRecordValue,
    }
    this.saveLease(input.admission.sessionId, null, null, null, 0)
    return [identity, lease, run, taint]
  }

  private formatData(): FormatEventData {
    return {
      formatVersion: FORMAT_VERSION,
      runtimeSchemaMajor: RUNTIME_SCHEMA_MAJOR,
      minReader: MIN_READER,
      previousFormat: 1,
      legacyThroughSeq: 0,
      sourceHeadDigest: null,
    }
  }

  private owner(bindingId: string, scope: unknown): RecordOwner {
    return {
      authority: this.authority,
      scope,
      ownerBinding: {
        bindingId,
        contract: 'agh.runtime/run-admission',
        logicalName: 'run',
        providerId: 'runtime-state',
      },
    }
  }

  private event(id: string, ts: string, type: string, data: unknown, chain: IntegrityState): LedgerEvent {
    return {
      seq: chain.lastSeq + 1,
      ts,
      id,
      type,
      lane: 'main',
      v: 1,
      actor: RUNTIME_ACTOR,
      origin: 'system',
      trust: 'trusted',
      data,
    }
  }

  private legacySourceKey(source: LegacyStateSource): string {
    return JSON.stringify([
      source.physicalSessionId,
      source.recordId,
      source.recordRevision,
      source.commitId,
      source.eventId,
    ])
  }

  private dataVersion(): number {
    return this.one<{ data_version: number }>('PRAGMA data_version').data_version
  }
  private sealVerified(verified: VerifiedSession, sourceVersion = this.dataVersion()): VerifiedSession {
    this.verifiedSourceVersions.set(verified, sourceVersion)
    return verified
  }
  private rememberVerified(sessionId: string, verified: VerifiedSession): void {
    const sourceVersion = this.verifiedSourceVersions.get(verified)
    if (sourceVersion === undefined) integrity('verified prefix has no source generation')
    this.verifiedHeads.set(sessionId, verified)
    this.verifiedDataVersions.set(sessionId, sourceVersion)
  }

  private encodeFreshRecord(record: StoredRecord): EncodedStoredRecord {
    const definition = stateSchemaDefinition(record.schema)
    if (
      !definition ||
      record.minReader !== 2 ||
      !validateRuntime(definition, record.value).ok ||
      !validateRuntime('RecordOwner', record.owner).ok
    )
      integrity('fresh State after-image does not match its registered codec/reader/owner')
    return encodeStoredRecord(record)
  }

  private async requireSession(sessionId: string): Promise<VerifiedSession> {
    const meta = this.sessionMeta(sessionId)
    if (!meta) refuse('invalid_input', 'session_absent', 'session does not exist')
    const cached = this.verifiedHeads.get(sessionId)
    if (
      cached &&
      this.verifiedDataVersions.get(sessionId) === this.dataVersion() &&
      this.headMatches(sessionId, cached)
    )
      return cached
    const verified = await this.verifySessionFully(meta)
    this.rememberVerified(sessionId, verified)
    return verified
  }

  private headMatches(sessionId: string, cached: VerifiedSession): boolean {
    const tail = this.get<{ seq: number; integrity_digest: string | null }>(
      `SELECT seq, integrity_digest FROM events WHERE session_key = ? ORDER BY seq DESC LIMIT 1`,
      sessionId,
    )
    const meta = this.sessionMeta(sessionId)
    return (
      tail !== undefined &&
      meta !== undefined &&
      tail.seq === cached.lastSeq &&
      tail.integrity_digest === cached.headDigest &&
      meta.latest_commit_id === cached.latestCommitId
    )
  }

  private verifyEmptyOrOthers(sessionId: string): VerifiedSession | undefined {
    const stray = this.get<{ seq: number }>('SELECT seq FROM events WHERE session_key = ? LIMIT 1', sessionId)
    if (stray) integrity('ledger events have no session identity')
    return undefined
  }

  private async verifySessionFully(meta: MetaRow): Promise<VerifiedSession> {
    const sourceVersion = this.dataVersion()
    const sessionId = meta.session_id
    assertStateReader(meta.min_reader, 2)
    const authority = this.parseJson<StateAuthorityRef>(
      meta.authority_json,
      'session authority cannot be decoded',
    )
    if (!sameJson(authority, this.authority))
      refuse('conflict', 'authority', 'session authority does not match this store')
    if (
      meta.format_version !== FORMAT_VERSION ||
      !Number.isSafeInteger(meta.min_reader) ||
      (meta.min_reader !== 1 && meta.min_reader !== 2)
    )
      integrity('session format is not readable')
    const product = this.get<{ format_version: number }>(
      'SELECT format_version FROM sessions WHERE session_key = ?',
      sessionId,
    )
    if (!product || product.format_version !== FORMAT_VERSION) integrity('session format row is missing')

    let readerAfter = ''
    for (;;) {
      const declared = this.all<{ record_id: string; min_reader: number }>(
        `SELECT h.record_id,h.min_reader FROM runtime_record_heads h WHERE h.record_id>? AND h.last_commit_id IN (SELECT json_extract(data,'$.commitId') FROM events WHERE session_key=? AND type=?) ORDER BY h.record_id LIMIT ?`,
        readerAfter,
        sessionId,
        STATE_COMMIT_EVENT,
        PROOF_PAGE,
      )
      for (const head of declared) assertStateReader(head.min_reader, 2)
      const last = declared[declared.length - 1]
      if (!last || declared.length < PROOF_PAGE) break
      readerAfter = last.record_id
      await this.pageBreak()
    }
    let chain = emptyIntegrity()
    let formatSeq = 0
    let sawFormat = false
    let previousCommit: string | null = null
    let latestCommitId: string | null = null
    const commitIds = new Set<string>()
    const revisions = new Map<string, number | null>()
    const live = new Map<string, LiveRecord>()
    const runs = new Map<string, RunEvidence>()
    const control = createControlScan()
    const heads: HeadScan = {
      sessionId,
      meta,
      parent: this.parseJson<SessionIdentityValue['parent']>(
        meta.parent_json,
        'session parent cannot be decoded',
      ),
      seen: new Set<string>(),
      sawIdentity: false,
    }
    let after = 0
    for (;;) {
      const rows = this.all<EventRow>(
        `SELECT session_key, seq, ts, id, type, lane, v, actor, origin, trust, data,
                integrity_mode, integrity_prev, integrity_digest
         FROM events WHERE session_key = ? AND seq > ? ORDER BY seq LIMIT ?`,
        sessionId,
        after,
        PROOF_PAGE,
      )
      if (rows.length === 0) break
      const decoded = rows.map((row) => this.decodeEvent(row))
      try {
        chain = verifyIntegrityRows(
          decoded.map((row) => ({
            sessionKey: sessionId,
            event: row.event as Event,
            integrity: row.integrity,
          })),
          chain,
        )
      } catch (error) {
        integrity(
          error instanceof LedgerIntegrityFailure || error instanceof Error
            ? error.message
            : 'ledger integrity verification failed',
        )
      }
      const pageCommits: ParsedCommit[] = []
      for (const row of decoded) {
        // The chain digest already canonicalized this event, including its data.
        const proof = this.validatedProof(row, true)
        if (!sawFormat) {
          if (proof.kind !== 'format') integrity('session format declaration is missing')
          const format = proof.data
          if (!Number.isSafeInteger(format.minReader) || format.minReader !== meta.min_reader)
            integrity('session format reader requirement is not readable')
          if (
            format.legacyThroughSeq !== 0 ||
            format.sourceHeadDigest !== null ||
            format.previousFormat !== 1
          )
            integrity('session format declaration does not match the ledger anchor')
          sawFormat = true
          formatSeq = proof.event.seq
          continue
        }
        if (proof.kind !== 'commit') integrity('unexpected ledger event')
        if (proof.data.authorityEpoch !== this.authority.authorityEpoch)
          integrity('state commit authority does not match this store')
        if (proof.data.previousCommitId !== previousCommit)
          integrity('state commit predecessor does not match')
        if (commitIds.has(proof.data.commitId)) integrity('duplicate state commit')
        const commit = {
          seq: proof.event.seq,
          data: proof.data,
          digest: proof.digest,
          at: proof.event.ts,
          eventId: proof.event.id,
        }
        pageCommits.push(commit)
        commitIds.add(proof.data.commitId)
        previousCommit = proof.data.commitId
        latestCommitId = proof.data.commitId
      }
      this.verifyCommitPage(pageCommits, revisions, live, runs, heads, control)
      const last = rows[rows.length - 1]
      if (!last) break
      after = last.seq
      if (rows.length < PROOF_PAGE) break
      // A full page is synchronous. Yield before the next page so its parsed rows can be collected.
      await this.pageBreak()
    }
    if (!sawFormat) integrity('session has no ledger events')
    if (commitIds.size === 0) integrity('session has no state commit attestation')
    if (!latestCommitId || meta.latest_commit_id !== latestCommitId)
      integrity('session head commit does not match')
    if (chain.headDigest === null) integrity('session head digest is missing')
    for (const [recordId, record] of live) {
      if (record.revision === null) continue
      if (!heads.seen.has(recordId)) integrity('latest record version has no head')
    }
    if (!heads.sawIdentity) integrity('session identity record is missing')
    this.assertReferencedBodies()
    finishControlScan(control, {
      sessionId,
      requests: () =>
        this.all<{ request_id: string; fingerprint: string; result_json: string }>(
          `SELECT request_id, fingerprint, result_json
           FROM runtime_request_results WHERE method = 'dispatchAdmission'`,
        ),
      domainJson: () =>
        this.get<{ domain_json: string }>(
          `SELECT dispatch_domain_json AS domain_json FROM runtime_session_meta
            WHERE session_id = ? AND dispatch_domain_json IS NOT NULL`,
          sessionId,
        )?.domain_json,
      signalSeqIndex: () =>
        this.all<{ run_id: string; target_key: string; next_seq: unknown }>(
          'SELECT run_id, target_key, next_seq FROM runtime_signal_seq',
        ),
      activeInvocations: () =>
        this.all<{ run_id: string; invocation_id: string }>(
          'SELECT run_id, invocation_id FROM runtime_active_invocation',
        ),
    })
    await this.verifySessionAdmissions(sessionId, runs, formatSeq)
    if (meta.min_reader === 2) this.verifyLeaseHistory(sessionId)
    this.verifyOutboxDelivery(sessionId)
    if (sourceVersion !== this.dataVersion()) integrity('State sources changed while verifying the prefix')
    return this.sealVerified(
      {
        lastSeq: chain.lastSeq,
        formatSeq,
        headDigest: chain.headDigest,
        latestCommitId,
        workspaceId: meta.workspace_id,
        formatVersion: meta.format_version,
        minReader: meta.min_reader,
        parent: heads.parent,
        chain,
      },
      sourceVersion,
    )
  }

  private verifyCommitPage(
    commits: readonly ParsedCommit[],
    revisions: Map<string, number | null>,
    live: Map<string, LiveRecord>,
    runs: Map<string, RunEvidence>,
    scan: HeadScan,
    control: ControlScan,
  ): void {
    if (commits.length === 0) return
    const idsJson = JSON.stringify(commits.map((commit) => commit.data.commitId))
    const expanded = this.expandCommitProofs(commits)
    const manifests = expanded.manifests
    const sides = expanded.sides
    const versions = expanded.versions
    const manifestsByCommit = new Map<string, CommitMutationManifest[]>()
    for (const manifest of manifests) {
      const list = manifestsByCommit.get(manifest.commitId) ?? []
      list.push(manifest)
      manifestsByCommit.set(manifest.commitId, list)
    }
    const sidesByCommit = new Map<string, CommitSideEntry[]>()
    for (const side of sides) {
      const list = sidesByCommit.get(side.commitId) ?? []
      list.push(side)
      sidesByCommit.set(side.commitId, list)
    }
    const versionsByCommit = new Map<string, VersionRow[]>()
    for (const version of versions) {
      const list = versionsByCommit.get(version.commit_id) ?? []
      list.push(version)
      versionsByCommit.set(version.commit_id, list)
    }
    const versionsByKey = new Map<string, VersionRow>()
    for (const version of versions) {
      versionsByKey.set(
        this.versionKey(version.record_id, version.record_revision, version.commit_id),
        version,
      )
    }
    const claimed = new Set<string>()
    const parsedBodies = new Map<string, unknown>()
    for (const commit of commits) {
      const commitManifests = manifestsByCommit.get(commit.data.commitId) ?? []
      const commitSides = sidesByCommit.get(commit.data.commitId) ?? []
      if (commit.data.mutationCount !== commitManifests.length)
        integrity('mutation count does not match manifests')
      if (commit.data.mutationsDigest !== mutationDigest(commitManifests))
        integrity('mutation digest does not match manifests')
      if (commit.data.sideListsDigest !== sideListsDigest(commitSides))
        integrity('side list digest does not match entries')
      if (!sameSideCounts(commit.data.counts, sideCounts(commitSides)))
        integrity('side counts do not match entries')
      for (const manifest of commitManifests) {
        this.noteContinuity(manifest, revisions)
        live.set(manifest.recordId, {
          revision: manifest.next?.recordRevision ?? null,
          commitId: manifest.commitId,
        })
        if (manifest.next === null) {
          if (manifest.previousRevision === null) integrity('delete manifest has no previous revision')
          continue
        }
        const key = this.versionKey(manifest.recordId, manifest.next.recordRevision, manifest.commitId)
        if (claimed.has(key)) integrity('record version is claimed by more than one manifest')
        const version = versionsByKey.get(key)
        if (!version) integrity('mutation manifest has no version header')
        claimed.add(key)
        parsedBodies.set(key, this.verifyVersionRow(manifest, version))
      }
      for (const version of versionsByCommit.get(commit.data.commitId) ?? []) {
        const key = this.versionKey(version.record_id, version.record_revision, version.commit_id)
        if (!claimed.has(key)) integrity('record version has no mutation manifest')
        this.noteRunVersion(version, commit, runs, parsedBodies.get(key))
        const schema = this.parseJson<import('@agnes/protocol/runtime').SchemaRef>(
          version.schema_json,
          'version schema invalid',
        )
        if (stateSchemaReader(schema) === 1) {
          const source: LegacyStateSource = {
            schema,
            minReader: 1,
            physicalSessionId: scan.sessionId,
            recordId: version.record_id,
            recordRevision: version.record_revision,
            commitId: version.commit_id,
            eventId: commit.eventId,
            owner: this.parseJson<import('@agnes/protocol/runtime').RecordOwner>(
              version.owner_json,
              'legacy owner invalid',
            ),
            value: this.parseJson<import('@agnes/protocol/runtime').JsonValue>(
              version.value_json,
              'legacy body invalid',
            ),
            digest: version.digest,
            sideEntries: commitSides,
          }
          const key = this.legacySourceKey(source)
          if (this.legacyCommitSources.has(key))
            integrity('legacy source verifier reentered its evidence scope')
          this.legacyCommitSources.set(key, {
            physicalSessionId: scan.sessionId,
            eventId: commit.eventId,
            commit: commit.data,
            manifests: commitManifests,
            sideEntries: commitSides,
            version: {
              recordId: source.recordId,
              recordRevision: source.recordRevision,
              schema: source.schema,
              minReader: 1,
              owner: source.owner,
              value: source.value,
            },
          })
          try {
            this.legacyDecoder.decode(source)
          } finally {
            this.legacyCommitSources.delete(key)
          }
        }
        if (sameJson(schema, STATE_OPEN_PROOF_SCHEMA) || sameJson(schema, STATE_LEASE_PROOF_SCHEMA))
          this.verifyAuthorityControlProof(version, commit, scan.sessionId)
        noteControlVersion(control, { ...version, event_id: commit.eventId })
      }
      for (const side of commitSides) noteControlSide(control, side)
    }
    this.verifyPageHeads(idsJson, versionsByKey, live, scan)
  }

  private verifyVersionRow(manifest: CommitMutationManifest, version: VersionRow): unknown {
    if (manifest.next === null) return undefined
    if (!matchesKnownSchema(manifest.next.schema) || !matchesKnownSchemaText(version.schema_json))
      integrity('record schema digest does not match the codec')
    if (version.commit_id !== manifest.commitId || version.digest !== manifest.next.digest)
      integrity('version header does not match the mutation manifest')
    const canonicalBody = canonicalStoredBodyDigest(version.owner_json, version.value_json) === version.digest
    if (!canonicalBody) {
      const owner = this.parseJson<RecordOwner>(version.owner_json, 'record owner cannot be decoded')
      const value = this.parseJson<unknown>(version.value_json, 'record body cannot be decoded')
      if (bodyDigest(owner, value) !== version.digest) integrity('record body digest does not match')
      const definition = stateSchemaDefinition(manifest.next.schema)
      if (definition && !validateRuntime(definition, value).ok)
        integrity('record body does not match its registered payload codec')
      return value
    }
    const definition = stateSchemaDefinition(manifest.next.schema)
    if (
      definition &&
      !validateRuntime(definition, this.parseJson(version.value_json, 'record body cannot be decoded')).ok
    )
      integrity('record body does not match its registered payload codec')
    // Run evidence is read back from the stored body. Other records are identified by their digest.
    if (!version.record_id.startsWith('run:')) return undefined
    return this.parseJson<unknown>(version.value_json, 'record body cannot be decoded')
  }

  private noteContinuity(manifest: CommitMutationManifest, seen: Map<string, number | null>): void {
    const previous = seen.get(manifest.recordId) ?? null
    if (manifest.previousRevision !== previous) integrity('record revision is not continuous')
    if (previous === null && manifest.next?.recordRevision !== 1)
      integrity('new record revision must start at 1')
    if (previous !== null && manifest.next && manifest.next.recordRevision !== previous + 1)
      integrity('record revision is not continuous')
    if (previous !== null && manifest.next === null) seen.set(manifest.recordId, null)
    else seen.set(manifest.recordId, manifest.next?.recordRevision ?? null)
    if (seen.get(manifest.recordId) === null && manifest.next !== null && previous === null)
      integrity('deleted record was created again')
  }

  private noteRunVersion(
    version: VersionRow,
    commit: ParsedCommit,
    runs: Map<string, RunEvidence>,
    parsed: unknown,
  ): void {
    if (!commit.data.runId || version.record_id !== runRecordId(commit.data.runId)) return
    const value =
      parsed === undefined
        ? this.parseJson<RunRecordValue>(version.value_json, 'record body cannot be decoded')
        : (parsed as RunRecordValue)
    if (!Number.isSafeInteger(value.revision)) integrity('attested run revision is not readable')
    const slot = runs.get(commit.data.runId) ?? { count: 0 }
    // Only the creating version attests the admission. Later versions keep that identity.
    if (value.revision === 0) {
      slot.count += 1
      if (value.runId === commit.data.runId) {
        slot.match = {
          sessionId: value.sessionId,
          ticketId: value.admissionTicketId,
          revision: value.revision,
          seq: commit.seq,
          digest: commit.digest,
          commitId: commit.data.commitId,
          transactionFingerprint: commit.data.transactionFingerprint,
          previousCommitId: commit.data.previousCommitId,
        }
      }
    } else if (
      !slot.match ||
      value.runId !== commit.data.runId ||
      value.sessionId !== slot.match.sessionId ||
      value.admissionTicketId !== slot.match.ticketId
    ) {
      integrity('attested run identity changed')
    }
    runs.set(commit.data.runId, slot)
  }

  private verifyPageHeads(
    idsJson: string,
    versionsByKey: ReadonlyMap<string, VersionRow>,
    live: ReadonlyMap<string, LiveRecord>,
    scan: HeadScan,
  ): void {
    const identityId = sessionIdentityRecordId(scan.sessionId)
    const heads = this.all<HeadRow>(HEADS_BY_COMMIT, idsJson)
    const bodies = this.bodyMap(heads.map((head) => head.record_id))
    for (const head of heads) {
      const version = versionsByKey.get(
        this.versionKey(head.record_id, head.record_revision, head.last_commit_id),
      )
      const body = bodies.get(`${head.record_id}\0${head.record_revision}`)
      const summary: HeadSummary = {
        record_id: head.record_id,
        min_reader: head.min_reader,
        record_revision: head.record_revision,
        last_commit_id: head.last_commit_id,
        body_digest: head.body_digest,
        has_version: version !== undefined,
        same_text:
          version !== undefined &&
          body !== undefined &&
          head.schema_json === version.schema_json &&
          head.owner_json === version.owner_json &&
          head.body_digest === version.digest &&
          body === version.value_json,
        identity_json: head.record_id === identityId ? (body ?? null) : null,
      }
      this.verifyHeadSummary(summary, versionsByKey, live, scan, identityId)
    }
  }

  private verifyHeadSummary(
    head: HeadSummary,
    versionsByKey: ReadonlyMap<string, VersionRow>,
    live: ReadonlyMap<string, LiveRecord>,
    scan: HeadScan,
    identityId: string,
  ): void {
    if (scan.seen.has(head.record_id)) integrity('duplicate record head')
    scan.seen.add(head.record_id)
    const record = live.get(head.record_id)
    if (!record || record.revision === null) integrity('record head has no version')
    if (record.revision !== head.record_revision || record.commitId !== head.last_commit_id)
      integrity('record head does not match its latest version')
    const version = versionsByKey.get(this.versionKey(head.record_id, record.revision, record.commitId))
    if (!version || !sqlFlag(head.has_version)) integrity('latest record version is missing')
    // Equal stored JSON is the same body already digested on the version row. Any other spelling
    // still goes through the full head/version compare.
    if (!sqlFlag(head.same_text)) {
      const loaded = this.get<HeadRow>(HEAD_BY_ID, head.record_id)
      if (!loaded) integrity('latest record version is missing')
      this.verifyHeadMatches(loaded, version)
    } else if (
      !Number.isSafeInteger(head.min_reader) ||
      head.min_reader !==
        stateSchemaReader(
          this.parseJson<import('@agnes/protocol/runtime').SchemaRef>(
            version.schema_json,
            'version schema invalid',
          ),
        )
    )
      integrity('record reader requirement is not readable')
    if (head.record_id !== identityId) return
    scan.sawIdentity = true
    if (head.identity_json === null) integrity('session identity cannot be decoded')
    const value = this.parseJson<SessionIdentityValue>(
      head.identity_json,
      'session identity cannot be decoded',
    )
    if (
      value.sessionId !== scan.sessionId ||
      value.workspaceId !== scan.meta.workspace_id ||
      value.formatVersion !== scan.meta.format_version ||
      value.minReader !== scan.meta.min_reader ||
      value.runtimeSchemaMajor !== RUNTIME_SCHEMA_MAJOR ||
      !sameJson(value.parent, scan.parent) ||
      value.minReader !== head.min_reader
    )
      integrity('session identity does not match the session catalogue')
  }

  private admissionMatches(stored: unknown, rebuilt: AdmissionProbe): boolean {
    if (rebuilt.state !== 'created') return false
    if (!isPlainRecord(stored) || Object.keys(stored).length !== 3) return false
    if (stored.state !== rebuilt.state || stored.runId !== rebuilt.runId) return false
    const commit = stored.commit
    const expected = rebuilt.commit
    if (!isPlainRecord(commit) || Object.keys(commit).length !== 8) return false
    if (
      commit.commitId !== expected.commitId ||
      commit.transactionFingerprint !== expected.transactionFingerprint ||
      commit.sessionId !== expected.sessionId ||
      commit.firstSeq !== expected.firstSeq ||
      commit.lastSeq !== expected.lastSeq ||
      commit.headDigest !== expected.headDigest ||
      commit.runRevision !== expected.runRevision
    )
      return false
    const actions = commit.actionIds
    if (!Array.isArray(actions) || actions.length !== expected.actionIds.length) return false
    for (let index = 0; index < actions.length; index += 1) {
      const item = actions[index]
      const want = expected.actionIds[index]
      if (!want || !isPlainRecord(item) || Object.keys(item).length !== 2) return false
      if (item.key !== want.key || item.actionId !== want.actionId) return false
    }
    return true
  }

  private async verifySessionAdmissions(
    sessionId: string,
    runs: ReadonlyMap<string, RunEvidence>,
    formatSeq: number,
  ): Promise<void> {
    let after = ''
    for (;;) {
      const rows = this.all<AdmissionRow>(
        `SELECT ticket_id, fingerprint, run_id, probe_json
         FROM runtime_admissions WHERE ticket_id > ? ORDER BY ticket_id LIMIT ?`,
        after,
        PROOF_PAGE,
      )
      if (rows.length === 0) break
      for (const row of rows) {
        const slot = runs.get(row.run_id)
        if (!slot) continue
        const rebuilt = this.probeFromEvidence(row, slot, sessionId, formatSeq)
        const stored = this.parseJson<unknown>(row.probe_json, 'stored admission probe cannot be decoded')
        if (!this.admissionMatches(stored, rebuilt))
          integrity('admission replay does not match the attested run')
        if (
          this.get(
            'SELECT ticket_id FROM runtime_admission_source_proofs WHERE ticket_id = ?',
            row.ticket_id,
          ) ||
          this.get(
            'SELECT record_id FROM runtime_record_heads WHERE record_id = ?',
            runBindingRecordId(row.run_id),
          )
        )
          this.verifyCreatedAdmissionSource(row, rebuilt)
      }
      const last = rows[rows.length - 1]
      if (!last || rows.length < PROOF_PAGE) break
      after = last.ticket_id
      await this.pageBreak()
    }
  }

  private probeFromEvidence(
    row: AdmissionRow,
    slot: RunEvidence,
    sessionId: string,
    formatSeq: number,
  ): AdmissionProbe {
    if (slot.count !== 1 || !slot.match || slot.match.ticketId !== row.ticket_id)
      integrity('admission does not match one attested run')
    if (slot.match.sessionId !== sessionId) integrity('admission session failed verification')
    return {
      state: 'created',
      runId: row.run_id,
      commit: {
        commitId: slot.match.commitId,
        transactionFingerprint: slot.match.transactionFingerprint,
        sessionId: slot.match.sessionId,
        firstSeq: slot.match.previousCommitId === null ? formatSeq : slot.match.seq,
        lastSeq: slot.match.seq,
        headDigest: slot.match.digest,
        runRevision: slot.match.revision,
        actionIds: [],
      },
    }
  }

  private rebuildStoredAdmission(
    row: AdmissionRow,
    verified: VerifiedSession,
    sessionId: string,
  ): AdmissionProbe {
    const versions = this.versionRowsForRecord(runRecordId(row.run_id))
    const runs = new Map<string, RunEvidence>()
    for (const version of versions) {
      const stored = this.all<EventRow>(
        `SELECT session_key, seq, ts, id, type, lane, v, actor, origin, trust, data,
                integrity_mode, integrity_prev, integrity_digest
         FROM events WHERE session_key = ? AND type = ? AND json_extract(data, '$.commitId') = ?`,
        sessionId,
        STATE_COMMIT_EVENT,
        version.commit_id,
      )
      const event = stored[0]
      if (stored.length !== 1 || !event) integrity('admission does not match one attested run')
      const proof = this.validatedProof(this.decodeEvent(event), false)
      if (proof.kind !== 'commit') integrity('unexpected ledger event')
      this.noteRunVersion(
        version,
        {
          seq: proof.event.seq,
          data: proof.data,
          digest: proof.digest,
          at: proof.event.ts,
          eventId: proof.event.id,
        },
        runs,
        undefined,
      )
    }
    return this.probeFromEvidence(row, runs.get(row.run_id) ?? { count: 0 }, sessionId, verified.formatSeq)
  }

  private pageBreak(): Promise<void> {
    return new Promise((resolve) => {
      setImmediate(resolve)
    })
  }

  private openResult(
    request: StateOpenRequest,
    verified: VerifiedSession,
    claim: WriterClaim | null,
  ): StateOpenResult {
    return {
      snapshot: {
        snapshotId: this.ids.ulid(),
        authority: this.authority,
        sessionId: request.sessionId,
        throughSeq: verified.lastSeq,
        headDigest: verified.headDigest,
        expiresAt: new Date(this.now() + SNAPSHOT_TTL_MS).toISOString(),
      },
      formatVersion: verified.formatVersion,
      minReader: verified.minReader,
      claim,
      parent: verified.parent,
    }
  }

  private applyLease(request: StateLeaseRequest, current: LeaseRow, now: number): StateLeaseResult {
    if (request.operation === 'renew') return this.renewLease(request, current, now)
    if (request.operation === 'release') return this.releaseLease(request, current)
    if (request.operation === 'acquire' || request.operation === 'reclaim')
      return this.grantLease(request, current, now)
    refuse('invalid_input', 'operation', 'unknown lease operation')
  }

  private replayRequest<T>(method: string, requestId: string, fingerprint: string): T | undefined {
    const stored = this.get<RequestResultRow>(
      'SELECT fingerprint, result_json FROM runtime_request_results WHERE method = ? AND request_id = ?',
      method,
      requestId,
    )
    if (!stored) return undefined
    if (stored.fingerprint !== fingerprint)
      refuse('conflict', 'idempotency_conflict', 'request id was already committed with different content')
    return this.parseJson<T>(stored.result_json, 'stored request result cannot be decoded')
  }

  private rememberRequest(method: string, requestId: string, fingerprint: string, result: unknown): void {
    if (this.staging) {
      this.staging.pending.push({ method, requestId, fingerprint, result })
      return
    }
    this.insertRequest(method, requestId, fingerprint, result)
  }

  private insertRequest(method: string, requestId: string, fingerprint: string, result: unknown): void {
    this.run(
      'INSERT INTO runtime_request_results (method, request_id, fingerprint, result_json) VALUES (?, ?, ?, ?)',
      method,
      requestId,
      fingerprint,
      stringifyProfiled(result),
    )
  }

  private validatedProof(row: ChainRow, canonicalized: boolean): ValidatedProof {
    if (!row.integrity) integrity('runtime ledger row is missing integrity')
    const event = row.event as LedgerEvent & { ignorable?: boolean }
    if (!proofChecks.envelope.Check(event) || event.ignorable === true)
      integrity('stored ledger event is not a registered proof')
    if (event.type === FORMAT_EVENT) {
      if (!proofChecks.format.Check(event.data) || !proofDataHolds(event.data, canonicalized))
        integrity('stored ledger event is not a registered proof')
      return { kind: 'format', event, data: event.data as FormatEventData, digest: row.integrity.digest }
    }
    if (event.type === STATE_COMMIT_EVENT) {
      if (!proofChecks.commit.Check(event.data) || !proofDataHolds(event.data, canonicalized))
        integrity('stored ledger event is not a registered proof')
      return { kind: 'commit', event, data: event.data as RuntimeCommitData, digest: row.integrity.digest }
    }
    integrity('unexpected ledger event')
  }

  private versionKey(recordId: string, revision: number, commitId: string): string {
    return `${recordId}\0${revision}\0${commitId}`
  }

  private verifyHeadMatches(head: HeadRow, version: VersionRow): void {
    const headSchema = this.attestedSchema(head.schema_json)
    const versionSchema = this.attestedSchema(version.schema_json)
    if (!sameJson(headSchema, versionSchema))
      integrity('record head schema does not match its latest version')
    // The format event attests the reader requirement. It is checked on every live head, not copied onto the version row.
    if (
      !Number.isSafeInteger(head.min_reader) ||
      head.min_reader !==
        stateSchemaReader(
          this.parseJson<import('@agnes/protocol/runtime').SchemaRef>(
            version.schema_json,
            'version schema invalid',
          ),
        )
    )
      integrity('record reader requirement is not readable')
    const headValue = this.parseJson<unknown>(head.value_json, 'record body cannot be decoded')
    const versionValue = this.parseJson<unknown>(version.value_json, 'record body cannot be decoded')
    const headOwner = this.parseJson<RecordOwner>(head.owner_json, 'record owner cannot be decoded')
    const versionOwner = this.parseJson<RecordOwner>(version.owner_json, 'record owner cannot be decoded')
    if (
      head.record_revision !== version.record_revision ||
      head.last_commit_id !== version.commit_id ||
      head.body_digest !== version.digest ||
      bodyDigest(headOwner, headValue) !== version.digest ||
      !sameJson(headValue, versionValue) ||
      !sameJson(headOwner, versionOwner)
    )
      integrity('record head does not match its latest version')
  }

  private attestedSchema(text: string): unknown {
    const schema = this.parseJson<{ typeId?: string }>(text, 'record schema cannot be decoded')
    if (!matchesKnownSchema(schema)) integrity('record schema does not match the codec')
    return schema
  }

  private decodeEvent(row: EventRow): ChainRow {
    let actor: LedgerEvent['actor']
    let data: unknown
    try {
      actor = parseProfiled(row.actor) as LedgerEvent['actor']
      data = parseProfiled(row.data) as unknown
    } catch {
      integrity('stored event cannot be decoded')
    }
    const event: LedgerEvent = {
      seq: row.seq,
      ts: row.ts,
      id: row.id,
      type: row.type,
      lane: Buffer.from(row.lane).toString('utf8'),
      v: row.v,
      actor,
      origin: row.origin,
      trust: row.trust,
      data,
    }
    if (row.integrity_mode === null && row.integrity_prev === null && row.integrity_digest === null)
      return { event, integrity: null }
    if ((row.integrity_mode !== 'anchor' && row.integrity_mode !== 'chain') || row.integrity_digest === null)
      integrity('malformed stored integrity metadata')
    return {
      event,
      integrity: {
        mode: row.integrity_mode,
        previousDigest: row.integrity_prev,
        digest: row.integrity_digest,
      },
    }
  }

  private decodeManifest(row: ManifestRow): CommitMutationManifest {
    const next =
      row.next_json === null
        ? null
        : this.parseJson<MutationNext>(row.next_json, 'mutation manifest cannot be decoded')
    return {
      commitId: row.commit_id,
      recordId: row.record_id,
      previousRevision: row.previous_revision,
      next,
    }
  }

  private controlProofId(method: 'open' | 'lease', request: StateOpenRequest | StateLeaseRequest): string {
    return stableId(
      'state-control',
      canonicalJson({
        method,
        authority: request.authority,
        sessionId: request.sessionId,
        requestId: request.requestId,
      }),
    )
  }

  private leaseRecordId(sessionId: string): string {
    return `state-lease:${sessionId}`
  }

  private recordVersion(recordId: string, revision: number): VersionRow {
    const rows = this.all<VersionRow>(
      `SELECT record_id, record_revision, schema_json, commit_id, digest, owner_json, value_json FROM runtime_record_versions WHERE record_id = ? AND record_revision = ?`,
      recordId,
      revision,
    )
    const row = rows[0]
    if (rows.length !== 1 || !row || row.value_json === '')
      integrity('control proof source version is missing or pruned')
    return row
  }

  private controlHead(recordId: string): HeadRow | undefined {
    return this.get<HeadRow>(HEAD_BY_ID, recordId)
  }

  private readLeaseValue(row: VersionRow): StateLeaseRecordValue {
    if (!sameJson(this.parseJson(row.schema_json, 'lease schema cannot be decoded'), STATE_LEASE_SCHEMA))
      integrity('lease source schema is not registered')
    const value = validateRuntime(
      'StateLeaseRecordValue',
      this.parseJson(row.value_json, 'lease value cannot be decoded'),
    )
    if (!value.ok) integrity('lease source value is invalid')
    if (
      value.value.claim &&
      (value.value.claim.scopeId !== value.value.sessionId ||
        value.value.claim.writerEpoch < 1 ||
        value.value.claim.writerEpoch > value.value.lastWriterEpoch)
    )
      integrity('lease source claim is unrelated')
    return value.value
  }

  private leaseHead(sessionId: string): { head: HeadRow; value: StateLeaseRecordValue } {
    const head = this.controlHead(this.leaseRecordId(sessionId))
    if (!head)
      refuse(
        'incompatible',
        'unproven_history',
        'session has no immutable lease genesis; trusted maintenance is required',
      )
    const version = this.recordVersion(head.record_id, head.record_revision)
    this.verifyHeadMatches(head, version)
    const value = this.readLeaseValue(version)
    if (value.sessionId !== sessionId) integrity('lease physical session differs')
    return { head, value }
  }

  private controlSources(request: StateOpenRequest | StateLeaseRequest) {
    if (!sameJson(request.authority, this.authority))
      refuse('denied', 'authority', 'control request authority does not match this store')
    const identity = this.controlHead(sessionIdentityRecordId(request.sessionId))
    if (!identity) integrity('control request has no session identity')
    const lease = this.leaseHead(request.sessionId)
    if (
      !sameJson(
        this.parseJson(identity.owner_json, 'identity owner invalid'),
        this.parseJson(lease.head.owner_json, 'lease owner invalid'),
      )
    )
      integrity('lease and session identity owners differ')
    return { identity, lease }
  }

  private replayAuthorityControl(
    method: 'open' | 'lease',
    request: StateOpenRequest | StateLeaseRequest,
  ): StateOpenResult | StateLeaseResult | undefined {
    const id = this.controlProofId(method, request),
      head = this.controlHead(id)
    const indexed = this.get<{
      record_id: string
      record_revision: number
      commit_id: string
      fingerprint: string
      result_json: string | null
    }>(
      `SELECT record_id,record_revision,commit_id,fingerprint,result_json FROM runtime_state_control_requests WHERE authority_id=? AND tenant_id=? AND authority_epoch=? AND session_id=? AND method=? AND request_id=?`,
      request.authority.authorityId,
      request.authority.tenantId,
      request.authority.authorityEpoch,
      request.sessionId,
      method,
      request.requestId,
    )
    if (!head) {
      if (
        indexed ||
        this.get(
          'SELECT 1 FROM runtime_request_results WHERE method=? AND request_id=?',
          method,
          request.requestId,
        )
      )
        refuse('incompatible', 'unproven_history', 'historical control result has no immutable proof')
      return undefined
    }
    if (head.record_revision !== 1) integrity('immutable control proof was revised')
    const version = this.recordVersion(id, 1),
      commit = this.commitForVersion(request.sessionId, version)
    const proof = this.verifyAuthorityControlProof(version, commit, request.sessionId)
    if (!sameJson(proof.request, request))
      refuse('conflict', 'idempotency_conflict', 'control request identity has different content')
    const result = this.controlResult(proof, version, commit)
    if (
      indexed &&
      (indexed.record_id !== id ||
        indexed.record_revision !== 1 ||
        indexed.commit_id !== version.commit_id ||
        indexed.fingerprint !== proof.requestFingerprint ||
        (indexed.result_json !== null &&
          !sameJson(this.parseJson(indexed.result_json, 'control result cache is invalid'), result)))
    )
      integrity('control result index does not match its immutable proof')
    if (!indexed) this.indexAuthorityControl(method, request, version.commit_id, result)
    return result
  }

  private indexAuthorityControl(
    method: 'open' | 'lease',
    request: StateOpenRequest | StateLeaseRequest,
    commitId: string,
    result: StateOpenResult | StateLeaseResult,
  ): void {
    this.pendingWrite = true
    this.notedAux = true
    this.run(
      `INSERT INTO runtime_state_control_requests (authority_id,tenant_id,authority_epoch,session_id,method,request_id,record_id,record_revision,commit_id,fingerprint,result_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      request.authority.authorityId,
      request.authority.tenantId,
      request.authority.authorityEpoch,
      request.sessionId,
      method,
      request.requestId,
      this.controlProofId(method, request),
      1,
      commitId,
      digestOf({ method, request }),
      stringifyProfiled(result),
    )
  }

  private commitForVersion(sessionId: string, version: VersionRow): ParsedCommit {
    const rows = this.all<EventRow>(
      `SELECT session_key,seq,ts,id,type,lane,v,actor,origin,trust,data,integrity_mode,integrity_prev,integrity_digest FROM events WHERE session_key=? AND type=? AND json_extract(data,'$.commitId')=?`,
      sessionId,
      STATE_COMMIT_EVENT,
      version.commit_id,
    )
    const row = rows[0]
    if (rows.length !== 1 || !row) integrity('control source has no unique original attestation')
    const proof = this.validatedProof(this.decodeEvent(row), false)
    if (proof.kind !== 'commit') integrity('control source is not a commit')
    return {
      seq: proof.event.seq,
      data: proof.data,
      digest: proof.digest,
      at: proof.event.ts,
      eventId: proof.event.id,
    }
  }

  private verifyAuthorityControlProof(
    version: VersionRow,
    commit: ParsedCommit,
    sessionId: string,
  ): StateLeaseProofValue | StateWriteOpenProofValue {
    const schema = this.parseJson(version.schema_json, 'control proof schema invalid')
    const open = sameJson(schema, STATE_OPEN_PROOF_SCHEMA)
    if (!open && !sameJson(schema, STATE_LEASE_PROOF_SCHEMA))
      integrity('control proof schema is unregistered')
    const parsed = validateRuntime(
      open ? 'StateWriteOpenProofValue' : 'StateLeaseProofValue',
      this.parseJson(version.value_json, 'control proof body invalid'),
    )
    if (!parsed.ok) integrity('control proof body does not match its schema')
    const proof = parsed.value as StateLeaseProofValue | StateWriteOpenProofValue,
      request = proof.request
    if (
      version.record_revision !== 1 ||
      version.record_id !== this.controlProofId(open ? 'open' : 'lease', request) ||
      request.sessionId !== sessionId ||
      !sameJson(request.authority, this.authority) ||
      proof.requestFingerprint !== digestOf({ method: open ? 'open' : 'lease', request }) ||
      commit.data.commitId !== version.commit_id ||
      commit.data.transactionFingerprint !== proof.requestFingerprint ||
      commit.data.runId !== null ||
      commit.data.actionId !== null ||
      commit.data.mutationCount !== 2
    )
      integrity('control proof original request/transaction relationship differs')
    const identityGuard = proof.sessionIdentityVersion,
      leaseGuard = proof.leaseVersion
    if (
      identityGuard.recordId !== sessionIdentityRecordId(sessionId) ||
      leaseGuard.recordId !== this.leaseRecordId(sessionId) ||
      identityGuard.expectedRecordRevision === null ||
      identityGuard.expectedRecordRevision < 1 ||
      leaseGuard.expectedRecordRevision === null ||
      leaseGuard.expectedRecordRevision < 1
    )
      integrity('control proof source guard cannot be proved')
    const identity = this.recordVersion(identityGuard.recordId, identityGuard.expectedRecordRevision),
      lease = this.recordVersion(leaseGuard.recordId, leaseGuard.expectedRecordRevision)
    if (
      !sameJson(this.parseJson(identity.schema_json, 'identity schema invalid'), SESSION_IDENTITY_SCHEMA) ||
      lease.commit_id !== version.commit_id ||
      !sameJson(
        this.parseJson(identity.owner_json, 'identity owner invalid'),
        this.parseJson(lease.owner_json, 'lease owner invalid'),
      ) ||
      !sameJson(
        this.parseJson(identity.owner_json, 'identity owner invalid'),
        this.parseJson(version.owner_json, 'proof owner invalid'),
      )
    )
      integrity('control proof physical owner or source transaction differs')
    const identityValue = validateRuntime(
      'SessionIdentityValue',
      this.parseJson(identity.value_json, 'identity body invalid'),
    )
    if (!identityValue.ok || identityValue.value.sessionId !== sessionId)
      integrity('control identity source is invalid')
    const next = this.readLeaseValue(lease),
      previousGuard = proof.previousLeaseVersion
    if (previousGuard === null) integrity('control proof must reference the existing lease genesis')
    if (
      previousGuard.recordId !== lease.record_id ||
      previousGuard.expectedRecordRevision !== lease.record_revision - 1 ||
      previousGuard.expectedRecordRevision === null ||
      previousGuard.expectedRecordRevision < 1
    )
      integrity('control proof lease predecessor is unrelated')
    const previousVersion = this.recordVersion(previousGuard.recordId, previousGuard.expectedRecordRevision)
    if (
      this.commitForVersion(sessionId, identity).seq >= commit.seq ||
      this.commitForVersion(sessionId, previousVersion).seq >= commit.seq
    )
      integrity('control proof source was not visible before its original decision')
    const previous = this.readLeaseValue(previousVersion)
    if (
      proof.evaluatedAt !== commit.at ||
      !sameJson(
        this.parseJson<RecordOwner>(identity.owner_json, 'identity owner invalid').authority,
        request.authority,
      ) ||
      previous.sessionId !== sessionId ||
      next.sessionId !== sessionId
    )
      integrity('control proof time/physical authority relation differs')
    const at = Date.parse(proof.evaluatedAt)
    if (!Number.isFinite(at)) integrity('control proof evaluation time invalid')
    const live = previous.claim !== null && Date.parse(previous.claim.leaseUntil) > at
    let expected: StateLeaseRecordValue
    const operation = 'operation' in request ? request.operation : 'open'
    if (operation === 'open' || operation === 'acquire' || operation === 'reclaim') {
      if (live || ('operation' in request && request.expectedWriterEpoch !== previous.lastWriterEpoch))
        integrity('control proof grant did not satisfy its original predecessor')
      const epoch = previous.lastWriterEpoch + 1
      if (!Number.isSafeInteger(epoch)) integrity('control proof epoch overflow')
      expected = {
        sessionId,
        lastWriterEpoch: epoch,
        claim: {
          scopeId: sessionId,
          writerId: request.writerId,
          writerEpoch: epoch,
          authorityEpoch: request.authority.authorityEpoch,
          leaseUntil: new Date(at + request.ttlMs).toISOString(),
        },
      }
    } else if (operation === 'renew') {
      if (
        !live ||
        !previous.claim ||
        previous.claim.writerId !== request.writerId ||
        previous.claim.writerEpoch !== (request as StateLeaseRequest).expectedWriterEpoch
      )
        integrity('control proof renew did not hold its original lease')
      expected = {
        ...previous,
        claim: { ...previous.claim, leaseUntil: new Date(at + request.ttlMs).toISOString() },
      }
    } else {
      const epoch = (request as StateLeaseRequest).expectedWriterEpoch
      if (
        previous.claim
          ? previous.claim.writerId !== request.writerId || previous.claim.writerEpoch !== epoch
          : epoch !== previous.lastWriterEpoch
      )
        integrity('control proof release did not hold its original lease')
      expected = { ...previous, claim: null }
    }
    if (
      !sameJson(expected, next) ||
      commit.data.writerEpoch !== (next.claim?.writerEpoch ?? previous.lastWriterEpoch) ||
      ('operation' in request && request.expectedLastSeq !== commit.seq - 1)
    )
      integrity('control proof transition does not match its original decision')
    if (open && Date.parse((proof as StateWriteOpenProofValue).snapshotExpiresAt) < at)
      integrity('write-open snapshot expires before its creation')
    if (open && (proof as StateWriteOpenProofValue).snapshotCommitId !== version.commit_id)
      integrity('write-open snapshot source is not its own original commit')
    return proof
  }

  private controlResult(
    proof: StateLeaseProofValue | StateWriteOpenProofValue,
    _version: VersionRow,
    commit: ParsedCommit,
  ): StateOpenResult | StateLeaseResult {
    const guard = proof.leaseVersion,
      lease = this.readLeaseValue(this.recordVersion(guard.recordId, guard.expectedRecordRevision as number))
    if ('operation' in proof.request) return { claim: lease.claim, lastWriterEpoch: lease.lastWriterEpoch }
    const open = proof as StateWriteOpenProofValue,
      identity = this.recordVersion(
        open.sessionIdentityVersion.recordId,
        open.sessionIdentityVersion.expectedRecordRevision as number,
      )
    const value = this.parseJson<SessionIdentityValue>(identity.value_json, 'identity source unavailable')
    return {
      snapshot: {
        snapshotId: open.snapshotId,
        authority: open.request.authority,
        sessionId: open.request.sessionId,
        throughSeq: commit.seq,
        headDigest: commit.digest,
        expiresAt: open.snapshotExpiresAt,
      },
      formatVersion: value.formatVersion,
      minReader: value.minReader,
      claim: lease.claim,
      parent: value.parent,
    }
  }

  private writeAuthorityControl(
    method: 'open' | 'lease',
    request: StateOpenRequest | StateLeaseRequest,
    verified: VerifiedSession,
    sources: ReturnType<RuntimeStateDatabase['controlSources']>,
    result: StateLeaseResult,
    evaluatedAt: string,
  ): { result: StateOpenResult | StateLeaseResult; verified: VerifiedSession } {
    if (!Number.isSafeInteger(sources.lease.head.record_revision + 1))
      refuse('conflict', 'revision_overflow', 'lease revision limit reached')
    const commitId = this.ids.ulid(),
      owner = this.parseJson<RecordOwner>(sources.identity.owner_json, 'identity owner invalid')
    const lease: StoredRecord = {
      recordId: sources.lease.head.record_id,
      schema: STATE_LEASE_SCHEMA,
      minReader: 2,
      recordRevision: sources.lease.head.record_revision + 1,
      owner,
      value: { sessionId: request.sessionId, lastWriterEpoch: result.lastWriterEpoch, claim: result.claim },
    }
    const base = {
      request,
      requestFingerprint: digestOf({ method, request }),
      evaluatedAt,
      sessionIdentityVersion: {
        recordId: sources.identity.record_id,
        expectedRecordRevision: sources.identity.record_revision,
      },
      previousLeaseVersion: {
        recordId: sources.lease.head.record_id,
        expectedRecordRevision: sources.lease.head.record_revision,
      },
      leaseVersion: { recordId: lease.recordId, expectedRecordRevision: lease.recordRevision },
    }
    const value =
      method === 'open'
        ? {
            ...base,
            snapshotId: this.ids.ulid(),
            snapshotExpiresAt: new Date(Date.parse(evaluatedAt) + SNAPSHOT_TTL_MS).toISOString(),
            snapshotCommitId: commitId,
          }
        : base
    if (!validateRuntime(method === 'open' ? 'StateWriteOpenProofValue' : 'StateLeaseProofValue', value).ok)
      integrity('new authority proof violates the registered schema')
    const proof: StoredRecord = {
      recordId: this.controlProofId(method, request),
      schema: method === 'open' ? STATE_OPEN_PROOF_SCHEMA : STATE_LEASE_PROOF_SCHEMA,
      minReader: 2,
      recordRevision: 1,
      owner,
      value,
    }
    const prepared = [lease, proof].map((record) => {
      const encoded = this.encodeFreshRecord(record)
      return {
        record,
        encoded,
        manifest: createManifest(
          commitId,
          record,
          record === lease ? sources.lease.head.record_revision : null,
          encoded.digest,
        ),
      }
    })
    const sides: CommitSideEntry[] = [],
      data: RuntimeCommitData = {
        commitId,
        transactionFingerprint: digestOf({ method, request }),
        runId: null,
        actionId: null,
        authorityEpoch: this.authority.authorityEpoch,
        writerEpoch: result.claim?.writerEpoch ?? sources.lease.value.lastWriterEpoch,
        previousCommitId: verified.latestCommitId,
        mutationsDigest: mutationDigest(prepared.map((p) => p.manifest)),
        mutationCount: 2,
        sideListsDigest: sideListsDigest(sides),
        counts: sideCounts(sides),
      }
    const event = this.event(this.ids.ulid(), evaluatedAt, STATE_COMMIT_EVENT, data, verified.chain),
      protectedEvent = protectEvent(request.sessionId, event, verified.chain)
    this.pendingWrite = true
    this.wroteCommit = true
    this.appendEvent(request.sessionId, event, protectedEvent.integrity)
    this.draft = { manifests: [], sides: [], versions: [] }
    try {
      for (const p of prepared) {
        if (p.record === lease)
          this.updateRecord(
            p.record,
            sources.lease.head.record_revision,
            commitId,
            evaluatedAt,
            p.encoded,
            p.manifest,
          )
        else this.insertRecord(p.record, commitId, evaluatedAt, p.encoded, p.manifest)
      }
      this.writeProof(commitId, event.seq)
    } finally {
      this.draft = null
    }
    this.run(
      'UPDATE runtime_session_meta SET latest_commit_id=? WHERE session_id=?',
      commitId,
      request.sessionId,
    )
    const next = this.sealVerified({
      ...verified,
      lastSeq: event.seq,
      headDigest: protectedEvent.integrity.digest,
      latestCommitId: commitId,
      chain: protectedEvent.state,
    })
    const storedProof = this.recordVersion(proof.recordId, 1)
    const originalCommit = {
      seq: event.seq,
      data,
      digest: protectedEvent.integrity.digest,
      at: event.ts,
      eventId: event.id,
    }
    const verifiedProof = this.verifyAuthorityControlProof(storedProof, originalCommit, request.sessionId)
    const rebuilt = this.controlResult(verifiedProof, storedProof, originalCommit)
    this.indexAuthorityControl(method, request, commitId, rebuilt)
    return { result: rebuilt, verified: next }
  }

  private verifyLeaseHistory(sessionId: string): void {
    const versions = this.versionRowsForRecord(this.leaseRecordId(sessionId)).sort(
      (a, b) => a.record_revision - b.record_revision,
    )
    const first = versions[0]
    if (first?.record_revision !== 1) integrity('session lease genesis is missing')
    const genesis = this.readLeaseValue(first)
    if (genesis.sessionId !== sessionId || genesis.lastWriterEpoch !== 0 || genesis.claim !== null)
      integrity('session lease genesis is not empty')
    const identity = this.recordVersion(sessionIdentityRecordId(sessionId), 1)
    if (
      identity.commit_id !== first.commit_id ||
      !sameJson(
        this.parseJson(identity.owner_json, 'identity owner invalid'),
        this.parseJson(first.owner_json, 'lease owner invalid'),
      )
    )
      integrity('lease genesis was not created with the original identity')
    for (const version of versions.slice(1)) {
      const proofs = this.all<VersionRow>(
        `SELECT record_id,record_revision,schema_json,commit_id,digest,owner_json,value_json FROM runtime_record_versions WHERE commit_id=?`,
        version.commit_id,
      ).filter((row) => {
        const schema = this.parseJson(row.schema_json, 'proof schema invalid')
        return sameJson(schema, STATE_OPEN_PROOF_SCHEMA) || sameJson(schema, STATE_LEASE_PROOF_SCHEMA)
      })
      const proof = proofs[0]
      if (proofs.length !== 1 || !proof) integrity('lease transition has no unique immutable request proof')
      const parsed = this.verifyAuthorityControlProof(
        proof,
        this.commitForVersion(sessionId, proof),
        sessionId,
      )
      if (parsed.leaseVersion.expectedRecordRevision !== version.record_revision)
        integrity('lease transition source revision differs')
    }
    this.loadLease(sessionId)
  }

  private takeLease(sessionId: string, writerId: string, ttlMs: number, at = this.now()): WriterClaim {
    const current = this.loadLease(sessionId)
    if (!Number.isSafeInteger(current.last_writer_epoch + 1))
      refuse('conflict', 'epoch_overflow', 'writer epoch limit reached')
    if (this.leaseIsLive(current, at)) refuse('conflict', 'writer_lease', 'writer lease is held')
    return this.saveClaim(
      sessionId,
      writerId,
      current.last_writer_epoch + 1,
      at + ttlMs,
      current.last_writer_epoch + 1,
    )
  }

  private grantLease(request: StateLeaseRequest, current: LeaseRow, now: number): StateLeaseResult {
    if (this.leaseIsLive(current, now) || request.expectedWriterEpoch !== current.last_writer_epoch)
      refuse('conflict', 'writer_lease', 'writer lease is held')
    if (!Number.isSafeInteger(current.last_writer_epoch + 1))
      refuse('conflict', 'epoch_overflow', 'writer epoch limit reached')
    const claim = this.saveClaim(
      request.sessionId,
      request.writerId,
      current.last_writer_epoch + 1,
      now + request.ttlMs,
      current.last_writer_epoch + 1,
    )
    return { claim, lastWriterEpoch: claim.writerEpoch }
  }

  private renewLease(request: StateLeaseRequest, current: LeaseRow, now: number): StateLeaseResult {
    const writerEpoch = current.writer_epoch
    if (writerEpoch === null) refuse('conflict', 'writer_lease', 'writer lease cannot be renewed')
    if (
      !this.leaseIsLive(current, now) ||
      current.writer_id !== request.writerId ||
      writerEpoch !== request.expectedWriterEpoch
    )
      refuse('conflict', 'writer_lease', 'writer lease cannot be renewed')
    const claim = this.saveClaim(
      request.sessionId,
      request.writerId,
      writerEpoch,
      now + request.ttlMs,
      current.last_writer_epoch,
    )
    return { claim, lastWriterEpoch: current.last_writer_epoch }
  }

  private releaseLease(request: StateLeaseRequest, current: LeaseRow): StateLeaseResult {
    const holds =
      current.writer_id === request.writerId && current.writer_epoch === request.expectedWriterEpoch
    if (!holds) {
      if (current.writer_id === null && request.expectedWriterEpoch === current.last_writer_epoch)
        return { claim: null, lastWriterEpoch: current.last_writer_epoch }
      refuse('conflict', 'writer_lease', 'writer lease cannot be released')
    }
    this.saveLease(request.sessionId, null, null, null, current.last_writer_epoch)
    return { claim: null, lastWriterEpoch: current.last_writer_epoch }
  }

  private loadLease(sessionId: string): LeaseRow {
    const { value } = this.leaseHead(sessionId)
    const expected: LeaseRow = {
      writer_id: value.claim?.writerId ?? null,
      writer_epoch: value.claim?.writerEpoch ?? null,
      lease_until: value.claim ? Date.parse(value.claim.leaseUntil) : null,
      authority_epoch: this.authority.authorityEpoch,
      last_writer_epoch: value.lastWriterEpoch,
    }
    const row = this.get<LeaseRow>(
      'SELECT writer_id,writer_epoch,lease_until,authority_epoch,last_writer_epoch FROM runtime_leases WHERE scope_id=?',
      sessionId,
    )
    if (!row || !sameJson(row, expected))
      integrity('lease projection does not match its immutable latest version')
    return row
  }

  private leaseIsLive(lease: LeaseRow, now: number): boolean {
    return lease.writer_id !== null && lease.lease_until !== null && lease.lease_until > now
  }

  private saveClaim(
    sessionId: string,
    writerId: string,
    writerEpoch: number,
    leaseUntil: number,
    lastWriterEpoch: number,
  ): WriterClaim {
    this.saveLease(sessionId, writerId, writerEpoch, leaseUntil, lastWriterEpoch)
    return {
      scopeId: sessionId,
      writerId,
      writerEpoch,
      leaseUntil: new Date(leaseUntil).toISOString(),
      authorityEpoch: this.authority.authorityEpoch,
    }
  }

  private saveLease(
    sessionId: string,
    writerId: string | null,
    writerEpoch: number | null,
    leaseUntil: number | null,
    lastWriterEpoch: number,
  ): void {
    this.run(
      `INSERT INTO runtime_leases (
         scope_id, writer_id, writer_epoch, lease_until, authority_epoch, last_writer_epoch
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope_id) DO UPDATE SET
         writer_id = excluded.writer_id,
         writer_epoch = excluded.writer_epoch,
         lease_until = excluded.lease_until,
         authority_epoch = excluded.authority_epoch,
         last_writer_epoch = excluded.last_writer_epoch`,
      sessionId,
      writerId,
      writerEpoch,
      leaseUntil,
      this.authority.authorityEpoch,
      lastWriterEpoch,
    )
  }

  private insertRecord(
    record: StoredRecord,
    commitId: string,
    at: string,
    encoded: EncodedStoredRecord,
    manifest: CommitMutationManifest,
  ): void {
    this.run(
      `INSERT INTO runtime_record_heads (
         record_id, schema_json, min_reader, record_revision, last_commit_id, created_at, updated_at,
         owner_json, body_digest
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.recordId,
      encoded.schemaJson,
      record.minReader,
      record.recordRevision,
      commitId,
      at,
      at,
      encoded.ownerJson,
      encoded.digest,
    )
    this.insertBody(record.recordId, record.recordRevision, encoded.valueJson)
    this.noteDraft(record, encoded, manifest)
  }

  private appendEvent(
    sessionKey: string,
    event: LedgerEvent,
    integrityMetadata: ChainRow['integrity'],
  ): void {
    if (!integrityMetadata) integrity('runtime ledger row is missing integrity')
    this.run(
      `INSERT INTO events (
         session_key, seq, ts, id, type, lane, v, actor, origin, trust,
         register, ignorable, surface_op, source_event_seqs, data,
         integrity_mode, integrity_prev, integrity_digest
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
      sessionKey,
      event.seq,
      event.ts,
      event.id,
      event.type,
      Buffer.from(event.lane, 'utf8'),
      event.v,
      stringifyProfiled(event.actor),
      event.origin,
      event.trust,
      stringifyProfiled(event.data),
      integrityMetadata.mode,
      integrityMetadata.previousDigest,
      integrityMetadata.digest,
    )
  }

  private sessionMeta(sessionId: string): MetaRow | undefined {
    return this.get<MetaRow>('SELECT * FROM runtime_session_meta WHERE session_id = ?', sessionId)
  }

  private tx<T>(
    method: string,
    requestId: string,
    body: () => T | Promise<T>,
    finalCheck?: () => void,
  ): Promise<T> {
    // The tail is replaced before this function awaits, so overlapping calls queue in order.
    const run = this.writeChain.then(() => this.runTx(method, requestId, body, finalCheck))
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async runTx<T>(
    method: string,
    requestId: string,
    body: () => T | Promise<T>,
    finalCheck?: () => void,
  ): Promise<T> {
    this.reservedCommitEvents.clear()
    this.pendingWrite = false
    this.wroteCommit = false
    this.notedAux = false
    this.execBoundary('BEGIN IMMEDIATE', 'begin')
    const profiled = profiling
    let inPhase = false
    if (profiled) {
      enterPhase('inTx')
      inPhase = true
    }
    try {
      const value = await body()
      if (inPhase) {
        leavePhase()
        inPhase = false
      }
      this.beforeCommit?.()
      if (this.notedAux && !this.wroteCommit) {
        this.run('INSERT INTO runtime_aux_commits (token) VALUES (?)', this.ids.ulid())
      }
      finalCheck?.()
      this.execBoundary('COMMIT', 'commit')
      this.onCommit?.({ method, requestId, wrote: this.pendingWrite })
      return value
    } catch (error) {
      if (inPhase) leavePhase()
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Report the original failure. A failed rollback has nothing further to commit.
      }
      throw error
    } finally {
      this.reservedCommitEvents.clear()
    }
  }

  private execBoundary(sql: string, kind: 'begin' | 'commit'): void {
    if (!profiling) {
      this.db.exec(sql)
      return
    }
    enterPhase(kind)
    const started = performance.now()
    try {
      this.db.exec(sql)
      noteBoundary(kind, performance.now() - started)
    } finally {
      leavePhase()
    }
  }

  private parseJson<T>(text: string, message: string): T {
    try {
      return parseProfiled(text) as T
    } catch {
      integrity(message)
    }
  }

  private statement(sql: string): StatementSync {
    const cached = this.statements.get(sql)
    if (cached) return cached
    const prepared = this.db.prepare(sql)
    this.statements.set(sql, prepared)
    return prepared
  }

  private get<T>(sql: string, ...args: SQLInputValue[]): T | undefined {
    const statement = this.statement(sql)
    if (!profiling) return statement.get(...args) as T | undefined
    const started = performance.now()
    const row = statement.get(...args) as T | undefined
    noteSql('read', performance.now() - started, sql)
    return row
  }

  private one<T>(sql: string, ...args: SQLInputValue[]): T {
    const row = this.get<T>(sql, ...args)
    if (row === undefined) integrity('required database row is missing')
    return row
  }

  private all<T>(sql: string, ...args: SQLInputValue[]): T[] {
    const statement = this.statement(sql)
    if (!profiling) return statement.all(...args) as T[]
    const started = performance.now()
    const rows = statement.all(...args) as T[]
    noteSql('read', performance.now() - started, sql)
    return rows
  }

  private run(sql: string, ...args: SQLInputValue[]): ReturnType<StatementSync['run']> {
    const statement = this.statement(sql)
    if (!profiling) return statement.run(...args)
    const started = performance.now()
    const result = statement.run(...args)
    noteSql('write', performance.now() - started, sql)
    return result
  }

  private reserveCommitEventId(commitId: string): string {
    const actualCommitId = this.staging?.commitId ?? commitId
    const existing = this.reservedCommitEvents.get(actualCommitId)
    if (existing) return existing
    const eventId = this.ids.ulid()
    this.reservedCommitEvents.set(actualCommitId, eventId)
    return eventId
  }

  private controlPorts(): ControlPorts {
    return {
      now: () => this.now(),
      authority: this.authority,
      ulid: () => this.ids.ulid(),
      reserveCommitEventId: (commitId) => this.reserveCommitEventId(commitId),
      ...(this.approvalJoint?.verifyAuthorizationPreparation
        ? {
            verifyAuthorizationPreparation: (
              ...args: Parameters<NonNullable<ControlPorts['verifyAuthorizationPreparation']>>
            ) => this.approvalJoint!.verifyAuthorizationPreparation!(...args),
          }
        : {}),
      ...(this.approvalJoint?.verifyApprovalAsk
        ? {
            verifyApprovalAsk: (...args: Parameters<NonNullable<ControlPorts['verifyApprovalAsk']>>) =>
              this.approvalJoint!.verifyApprovalAsk!(...args),
          }
        : {}),
      ...(this.verifyUsageSettlement ? { verifyUsageSettlement: this.verifyUsageSettlement } : {}),
      ...(this.verifyRetentionPin ? { verifyRetentionPin: this.verifyRetentionPin } : {}),
      get: (sql, ...args) => this.get(sql, ...args),
      all: (sql, ...args) => this.all(sql, ...args),
      run: (sql, ...args) => this.run(sql, ...args),
      requireSession: (sessionId) => this.requireSession(sessionId),
      replayRequest: (method, requestId, fingerprint) => this.replayRequest(method, requestId, fingerprint),
      rememberRequest: (method, requestId, fingerprint, result) =>
        this.rememberRequest(method, requestId, fingerprint, result),
      loadHead: (recordId) => this.staging?.shadow.get(recordId) ?? this.get(HEAD_BY_ID, recordId),
      writeCommit: (input) => this.writeCommit(input),
      assertReceipt: (sessionId, receipt, fingerprint) => this.assertReceipt(sessionId, receipt, fingerprint),
      noteWrite: () => {
        this.pendingWrite = true
        this.notedAux = true
      },
      attestedCommitId: this.staging?.commitId ?? null,
      openQueryMeter: (grantId, capacity) => this.openQueryMeter(grantId, capacity),
      queryMeter: (grantId) => this.queryMeter(grantId),
      lookupQueryTicket: (grantId, requestId) => this.lookupQueryTicket(grantId, requestId),
      rememberQueryTicket: (grantId, requestId, ticket) =>
        this.rememberQueryTicket(grantId, requestId, ticket),
    }
  }

  private openQueryMeter(grantId: string, capacity: number): void {
    if (this.queryMeters.has(grantId)) return
    this.queryMeters.set(grantId, { capacity, observed: 0, tickets: new Map() })
  }

  private queryMeter(grantId: string): { capacity: number; observed: number } | undefined {
    const meter = this.queryMeters.get(grantId)
    return meter ? { capacity: meter.capacity, observed: meter.observed } : undefined
  }

  private lookupQueryTicket(grantId: string, requestId: string): QueryTicket | undefined {
    return this.queryMeters.get(grantId)?.tickets.get(requestId)
  }

  private rememberQueryTicket(grantId: string, requestId: string, ticket: QueryTicket): void {
    const meter = this.queryMeters.get(grantId)
    if (!meter) integrity('query meter is not available for this grant')
    if (meter.observed >= meter.capacity) refuse('conflict', 'quota', 'query grant is exhausted')
    meter.observed += 1
    meter.tickets.set(requestId, ticket)
  }

  private verifyOutboxDelivery(sessionId: string): void {
    this.verifyOutboxHeads(sessionId)
    this.verifyOutboxRows(sessionId)
  }

  private outboxPhysicalSession(recordId: string, lastCommitId: string): string {
    const created = this.recordVersion(recordId, 1)
    const sessions = this.all<{ session_key: string; commit_id: string }>(
      `SELECT session_key,json_extract(data,'$.commitId') AS commit_id FROM events
       WHERE type=? AND json_extract(data,'$.commitId') IN (?,?)`,
      STATE_COMMIT_EVENT,
      lastCommitId,
      created.commit_id,
    )
    const current = sessions.filter((row) => row.commit_id === lastCommitId)
    const original = sessions.filter((row) => row.commit_id === created.commit_id)
    if (
      current.length !== 1 ||
      original.length !== 1 ||
      !current[0] ||
      !original[0] ||
      current[0].session_key !== original[0].session_key
    )
      integrity('outbox source has no unique physical creation session')
    const manifests = this.all<{ previous_revision: number | null; next_json: string | null }>(
      'SELECT previous_revision,next_json FROM runtime_mutation_manifests WHERE commit_id=? AND record_id=?',
      created.commit_id,
      recordId,
    )
    const manifest = manifests[0]
    const sides = this.all<{ entry_json: string }>(
      `SELECT entry_json FROM runtime_side_entries WHERE commit_id=? AND kind='outbox-created' AND identity=?`,
      created.commit_id,
      recordId.slice('outbox:'.length),
    )
    const side = sides[0]
      ? this.parseJson<CommitSideEntry>(sides[0].entry_json, 'outbox creation side invalid')
      : undefined
    const next = manifest?.next_json
      ? this.parseJson<MutationNext>(manifest.next_json, 'outbox creation manifest invalid')
      : undefined
    if (
      manifests.length !== 1 ||
      manifest?.previous_revision !== null ||
      next?.recordRevision !== 1 ||
      sides.length !== 1 ||
      side?.kind !== 'outbox-created' ||
      side.eventId !== recordId.slice('outbox:'.length) ||
      side.commitId !== created.commit_id
    )
      integrity('outbox physical session has no immutable creation source')
    return original[0].session_key
  }

  private verifyOutboxHeads(sessionId: string): void {
    let after = 'outbox:'
    let inclusive = true
    for (;;) {
      const records = this.all<{ record_id: string; value_json: string; last_commit_id: string }>(
        `SELECT h.record_id, b.value_json,h.last_commit_id
           FROM runtime_record_heads h
           JOIN runtime_version_bodies b
             ON b.record_id = h.record_id AND b.record_revision = h.record_revision
          WHERE h.record_id ${inclusive ? '>=' : '>'} ? AND h.record_id < 'outbox;'
          ORDER BY h.record_id
          LIMIT ?`,
        after,
        PROOF_PAGE,
      )
      if (records.length === 0) return
      const eventIds: string[] = []
      const bodies = new Map<string, unknown>()
      for (const record of records) {
        const value = this.parseJson<{ sessionId?: unknown }>(
          record.value_json,
          'record body cannot be decoded',
        )
        if (this.outboxPhysicalSession(record.record_id, record.last_commit_id) !== sessionId) continue
        eventIds.push(record.record_id.slice('outbox:'.length))
        bodies.set(record.record_id.slice('outbox:'.length), value)
      }
      const deliveries = this.outboxDeliveries(eventIds)
      for (const eventId of eventIds) {
        const row = deliveries.get(eventId)
        if (!row) integrity('outbox delivery row is missing')
        if (row.session_id !== sessionId) integrity('outbox delivery physical session differs')
        const body = bodies.get(eventId)
        if (!body) integrity('outbox delivery names an unknown event')
        assertStoredOutbox(body, row)
      }
      const last = records[records.length - 1]
      if (!last || records.length < PROOF_PAGE) return
      after = last.record_id
      inclusive = false
    }
  }

  private verifyOutboxRows(sessionId: string): void {
    let after = ''
    for (;;) {
      const rows = this.all<OutboxDeliveryRow>(
        `SELECT ${OUTBOX_OPEN_COLUMNS}
           FROM runtime_outbox_delivery
          WHERE session_id = ? AND event_id > ?
          ORDER BY event_id
          LIMIT ?`,
        sessionId,
        after,
        PROOF_PAGE,
      )
      if (rows.length === 0) return
      const heads = this.outboxHeads(rows.map((row) => `outbox:${row.event_id}`))
      for (const row of rows) {
        const head = heads.get(`outbox:${row.event_id}`)
        if (!head) integrity('outbox delivery names an unknown event')
        const value = this.parseJson<unknown>(head.value_json, 'record body cannot be decoded')
        if (this.outboxPhysicalSession(`outbox:${row.event_id}`, head.last_commit_id) !== sessionId)
          integrity('outbox delivery names an unknown event')
        assertStoredOutbox(value, row)
      }
      const last = rows[rows.length - 1]
      if (!last || rows.length < PROOF_PAGE) return
      after = last.event_id
    }
  }

  private outboxDeliveries(eventIds: readonly string[]): Map<string, OutboxDeliveryRow> {
    if (eventIds.length === 0) return new Map()
    const rows = this.all<OutboxDeliveryRow>(
      `SELECT ${OUTBOX_OPEN_COLUMNS}
         FROM runtime_outbox_delivery
        WHERE event_id IN (SELECT value FROM json_each(?))`,
      JSON.stringify(eventIds),
    )
    return new Map(rows.map((row) => [row.event_id, row]))
  }

  private outboxHeads(
    recordIds: readonly string[],
  ): Map<string, { value_json: string; last_commit_id: string }> {
    if (recordIds.length === 0) return new Map()
    const rows = this.all<{ record_id: string; value_json: string; last_commit_id: string }>(
      `SELECT h.record_id, b.value_json,h.last_commit_id
         FROM runtime_record_heads h
         JOIN runtime_version_bodies b
           ON b.record_id = h.record_id AND b.record_revision = h.record_revision
        WHERE h.record_id IN (SELECT value FROM json_each(?))`,
      JSON.stringify(recordIds),
    )
    return new Map(
      rows.map((row) => [row.record_id, { value_json: row.value_json, last_commit_id: row.last_commit_id }]),
    )
  }

  private writeCommit(input: WriteCommitInput): { receipt: StateCommitReceipt; verified: VerifiedSession } {
    if (this.staging) return this.stageCommit(input)
    return this.timedCommit(() => this.commitStaged(input))
  }

  private timedCommit<T>(body: () => T): T {
    const profiled = profiling
    if (profiled) enterPhase('writeCommit')
    try {
      return body()
    } finally {
      if (profiled) leavePhase()
    }
  }

  private beginStaging(commitId: string): void {
    if (this.staging) integrity('a control batch is already open')
    this.staging = {
      commitId,
      changes: new Map(),
      shadow: new Map(),
      sides: [],
      sideKeys: new Set(),
      memberFingerprints: [],
      receipts: [],
      pending: [],
      actionIds: [],
      actionKeys: new Set(),
      eventActionIds: new Set(),
      sessionId: '',
      verified: null,
      at: '',
      writerEpoch: 0,
      runId: '',
      runRevision: 0,
    }
  }

  private clearStaging(): void {
    this.staging = null
  }

  private stageCommit(input: WriteCommitInput): { receipt: StateCommitReceipt; verified: VerifiedSession } {
    const staging = this.staging
    if (!staging) integrity('a control batch is not open')
    if (!staging.verified) {
      staging.verified = input.verified
      staging.sessionId = input.sessionId
    }
    staging.at = input.at
    staging.writerEpoch = input.writerEpoch
    staging.runId = input.runId
    staging.runRevision = input.runRevision
    staging.memberFingerprints.push(input.fingerprint)
    if (input.actionId) staging.eventActionIds.add(input.actionId)
    for (const item of input.actionIds) {
      if (staging.actionKeys.has(item.actionId)) continue
      staging.actionKeys.add(item.actionId)
      staging.actionIds.push(item)
    }
    for (const record of input.creates) this.stageRecord(record, null, true)
    for (const update of input.updates) this.stageRecord(update.record, update.previousRevision, false)
    for (const side of input.sides) {
      const rewritten = { ...side, commitId: staging.commitId }
      const identity = `${rewritten.kind}\0${sideEntryIdentity(rewritten)}`
      if (staging.sideKeys.has(identity)) integrity('duplicate side entry in one commit')
      staging.sideKeys.add(identity)
      staging.sides.push(rewritten)
    }
    const receipt: StateCommitReceipt = {
      commitId: staging.commitId,
      transactionFingerprint: input.fingerprint,
      sessionId: input.sessionId,
      firstSeq: 0,
      lastSeq: 0,
      headDigest: '',
      runRevision: input.runRevision,
      actionIds: input.actionIds,
    }
    staging.receipts.push(receipt)
    return { receipt, verified: input.verified }
  }

  private stageRecord(record: StoredRecord, previousRevision: number | null, created: boolean): void {
    const staging = this.staging
    if (!staging) integrity('a control batch is not open')
    const existing = staging.changes.get(record.recordId)
    if (created && existing) integrity('record was created twice in one commit')
    const collapsedRevision = existing
      ? existing.created
        ? 1
        : (existing.previousRevision ?? 0) + 1
      : record.recordRevision
    const final = { ...record, recordRevision: collapsedRevision }
    const encoded = this.encodeFreshRecord(record)
    if (existing) {
      existing.final = final
      existing.encoded = encoded
    } else {
      staging.changes.set(record.recordId, {
        previousRevision: created ? null : previousRevision,
        created,
        final,
        encoded,
      })
    }
    staging.shadow.set(record.recordId, {
      record_id: record.recordId,
      schema_json: encoded.schemaJson,
      min_reader: record.minReader,
      record_revision: record.recordRevision,
      last_commit_id: staging.commitId,
      owner_json: encoded.ownerJson,
      value_json: encoded.valueJson,
      body_digest: encoded.digest,
    })
  }

  private flushStaging(): { receipt: StateCommitReceipt; verified: VerifiedSession } | undefined {
    const staging = this.staging
    if (!staging || staging.memberFingerprints.length === 0 || !staging.verified) return undefined
    const members = staging.memberFingerprints
    const fingerprint = members.length === 1 ? (members[0] ?? '') : digestOf(members)
    const actionId = staging.eventActionIds.size === 1 ? ([...staging.eventActionIds][0] ?? null) : null
    const creates: StoredRecord[] = []
    const updates: { record: StoredRecord; previousRevision: number }[] = []
    const prepared = new Map<string, EncodedStoredRecord>()
    for (const change of staging.changes.values()) {
      prepared.set(change.final.recordId, change.encoded)
      if (change.created || change.previousRevision === null) creates.push(change.final)
      else updates.push({ record: change.final, previousRevision: change.previousRevision })
    }
    const input: WriteCommitInput = {
      sessionId: staging.sessionId,
      verified: staging.verified,
      commitId: staging.commitId,
      at: staging.at,
      fingerprint,
      runId: staging.runId,
      actionId,
      writerEpoch: staging.writerEpoch,
      runRevision: staging.runRevision,
      actionIds: staging.actionIds,
      creates,
      updates,
      sides: staging.sides,
    }
    const written = this.timedCommit(() => {
      if (members.length > 1) {
        this.run(
          'INSERT INTO runtime_commit_fingerprints (commit_id, fingerprints_json) VALUES (?, ?)',
          staging.commitId,
          canonicalJson(members),
        )
      }
      return this.commitStaged(input, prepared)
    })
    for (const receipt of staging.receipts) {
      receipt.commitId = written.receipt.commitId
      receipt.transactionFingerprint = written.receipt.transactionFingerprint
      receipt.sessionId = written.receipt.sessionId
      receipt.firstSeq = written.receipt.firstSeq
      receipt.lastSeq = written.receipt.lastSeq
      receipt.headDigest = written.receipt.headDigest
      receipt.runRevision = written.receipt.runRevision
      receipt.actionIds = written.receipt.actionIds
    }
    for (const pending of staging.pending) {
      this.insertRequest(pending.method, pending.requestId, pending.fingerprint, pending.result)
    }
    return written
  }

  private commitStaged(
    input: WriteCommitInput,
    prepared?: ReadonlyMap<string, EncodedStoredRecord>,
  ): { receipt: StateCommitReceipt; verified: VerifiedSession } {
    this.pendingWrite = true
    this.wroteCommit = true
    const creates = input.creates.map((record) => {
      const encoded = prepared?.get(record.recordId) ?? this.encodeFreshRecord(record)
      return { record, encoded, manifest: createManifest(input.commitId, record, null, encoded.digest) }
    })
    const updates = input.updates.map((update) => {
      const encoded = prepared?.get(update.record.recordId) ?? this.encodeFreshRecord(update.record)
      return {
        record: update.record,
        previousRevision: update.previousRevision,
        encoded,
        manifest: createManifest(input.commitId, update.record, update.previousRevision, encoded.digest),
      }
    })
    const manifests = [...creates.map((item) => item.manifest), ...updates.map((item) => item.manifest)]
    const data: RuntimeCommitData = {
      commitId: input.commitId,
      transactionFingerprint: input.fingerprint,
      runId: input.runId,
      actionId: input.actionId,
      authorityEpoch: this.authority.authorityEpoch,
      writerEpoch: input.writerEpoch,
      previousCommitId: input.verified.latestCommitId,
      mutationsDigest: mutationDigest(manifests),
      mutationCount: manifests.length,
      sideListsDigest: sideListsDigest(input.sides),
      counts: sideCounts(input.sides),
    }
    const commit = this.event(
      this.reserveCommitEventId(input.commitId),
      input.at,
      STATE_COMMIT_EVENT,
      data,
      input.verified.chain,
    )
    const protectedCommit = protectEvent(input.sessionId, commit, input.verified.chain)
    this.appendEvent(input.sessionId, commit, protectedCommit.integrity)
    try {
      this.draft = { manifests: [], sides: [], versions: [] }
      for (const item of creates)
        this.insertRecord(item.record, input.commitId, input.at, item.encoded, item.manifest)
      for (const item of updates) {
        this.updateRecord(
          item.record,
          item.previousRevision,
          input.commitId,
          input.at,
          item.encoded,
          item.manifest,
        )
      }
      for (const side of input.sides) this.insertSide(side)
      this.writeProof(input.commitId, commit.seq)
    } finally {
      this.draft = null
    }
    this.run(
      'UPDATE runtime_session_meta SET latest_commit_id = ? WHERE session_id = ?',
      input.commitId,
      input.sessionId,
    )
    const receipt: StateCommitReceipt = {
      commitId: input.commitId,
      transactionFingerprint: input.fingerprint,
      sessionId: input.sessionId,
      firstSeq: commit.seq,
      lastSeq: commit.seq,
      headDigest: protectedCommit.integrity.digest,
      runRevision: input.runRevision,
      actionIds: input.actionIds,
    }
    return {
      receipt,
      verified: this.sealVerified({
        lastSeq: commit.seq,
        formatSeq: input.verified.formatSeq,
        headDigest: protectedCommit.integrity.digest,
        latestCommitId: input.commitId,
        workspaceId: input.verified.workspaceId,
        formatVersion: input.verified.formatVersion,
        minReader: input.verified.minReader,
        parent: input.verified.parent,
        chain: protectedCommit.state,
      }),
    }
  }

  private updateRecord(
    record: StoredRecord,
    previousRevision: number,
    commitId: string,
    at: string,
    encoded: EncodedStoredRecord,
    manifest: CommitMutationManifest,
  ): void {
    const updated = this.run(
      `UPDATE runtime_record_heads
       SET schema_json = ?, record_revision = ?, last_commit_id = ?, updated_at = ?,
           owner_json = ?, body_digest = ?, min_reader = ?
       WHERE record_id = ? AND record_revision = ?`,
      encoded.schemaJson,
      record.recordRevision,
      commitId,
      at,
      encoded.ownerJson,
      encoded.digest,
      record.minReader,
      record.recordId,
      previousRevision,
    )
    if (Number(updated.changes) !== 1) integrity('record head update missed its row')
    this.insertBody(record.recordId, record.recordRevision, encoded.valueJson)
    this.noteDraft(record, encoded, manifest)
  }

  private insertBody(recordId: string, recordRevision: number, valueJson: string): void {
    this.run(
      `INSERT INTO runtime_version_bodies (record_id, record_revision, value_json) VALUES (?, ?, ?)`,
      recordId,
      recordRevision,
      valueJson,
    )
  }

  private noteDraft(
    record: StoredRecord,
    encoded: EncodedStoredRecord,
    manifest: CommitMutationManifest,
  ): void {
    const draft = this.draft
    if (!draft) integrity('proof pack is not open')
    draft.manifests.push({
      recordId: manifest.recordId,
      previousRevision: manifest.previousRevision,
      nextJson: this.mutationNextJson(manifest, encoded.schemaJson),
    })
    draft.versions.push({
      recordId: record.recordId,
      recordRevision: record.recordRevision,
      schemaJson: encoded.schemaJson,
      digest: encoded.digest,
      ownerJson: encoded.ownerJson,
      hasBody: true,
    })
  }

  private writeProof(commitId: string, ledgerSeq: number): void {
    const draft = this.draft
    if (!draft) integrity('proof pack is not open')
    const manifests = [...draft.manifests].sort((left, right) => compareUtf8(left.recordId, right.recordId))
    const versions = [...draft.versions].sort((left, right) => {
      const compared = compareUtf8(left.recordId, right.recordId)
      return compared === 0 ? left.recordRevision - right.recordRevision : compared
    })
    const sides = [...draft.sides].sort((left, right) => {
      const compared = compareUtf8(left.kind, right.kind)
      return compared === 0 ? compareUtf8(left.identity, right.identity) : compared
    })
    this.run(
      `INSERT INTO runtime_commit_proofs (
         commit_id, ledger_seq, manifests_json, sides_json, versions_json
       ) VALUES (?, ?, ?, ?, ?)`,
      commitId,
      ledgerSeq,
      canonicalJson(manifests),
      canonicalJson(sides),
      canonicalJson(versions),
    )
  }

  private mutationNextJson(manifest: CommitMutationManifest, schemaJson: string): string | null {
    if (manifest.next === null) return null
    return storedMutationNextJson(manifest.next.recordRevision, manifest.next.digest, schemaJson)
  }

  private insertSide(entry: CommitSideEntry): void {
    const draft = this.draft
    if (!draft) integrity('proof pack is not open')
    draft.sides.push({
      kind: entry.kind,
      identity: sideEntryIdentity(entry),
      entryJson: canonicalJson(entry),
    })
  }

  private expandCommitProofs(commits: readonly ParsedCommit[]): {
    manifests: CommitMutationManifest[]
    sides: CommitSideEntry[]
    versions: VersionRow[]
  } {
    const idsJson = JSON.stringify(commits.map((commit) => commit.data.commitId))
    const expected = new Map(commits.map((commit) => [commit.data.commitId, commit.seq]))
    const rows = this.all<ProofRow>(PROOFS_BY_COMMIT, idsJson)
    if (rows.length !== commits.length) integrity('state commit has no proof pack')
    const manifestRows: ManifestRow[] = []
    const sideRows: SideRow[] = []
    const headers: Array<Omit<VersionRow, 'value_json'> & { hasBody: boolean }> = []
    for (const row of rows) {
      if (row.ledger_seq !== expected.get(row.commit_id))
        integrity('proof pack sequence does not match the state commit')
      for (const item of this.proofArray(row.manifests_json)) {
        if (
          !isPlainRecord(item) ||
          typeof item.recordId !== 'string' ||
          (item.previousRevision !== null && typeof item.previousRevision !== 'number') ||
          (item.nextJson !== null && typeof item.nextJson !== 'string')
        )
          integrity('proof pack cannot be decoded')
        manifestRows.push({
          commit_id: row.commit_id,
          record_id: item.recordId,
          previous_revision: item.previousRevision as number | null,
          next_json: item.nextJson as string | null,
        })
      }
      for (const item of this.proofArray(row.sides_json)) {
        if (!isPlainRecord(item) || typeof item.entryJson !== 'string')
          integrity('proof pack cannot be decoded')
        sideRows.push({ commit_id: row.commit_id, entry_json: item.entryJson })
      }
      for (const item of this.proofArray(row.versions_json)) {
        if (
          !isPlainRecord(item) ||
          typeof item.recordId !== 'string' ||
          typeof item.recordRevision !== 'number' ||
          typeof item.schemaJson !== 'string' ||
          typeof item.digest !== 'string' ||
          typeof item.ownerJson !== 'string'
        )
          integrity('proof pack cannot be decoded')
        headers.push({
          record_id: item.recordId,
          record_revision: item.recordRevision,
          schema_json: item.schemaJson,
          commit_id: row.commit_id,
          digest: item.digest,
          owner_json: item.ownerJson,
          hasBody: item.hasBody !== false,
        })
      }
    }
    const bodies = this.bodyMap(headers.map((header) => header.record_id))
    const versions = headers.map((header) => {
      const value = bodies.get(`${header.record_id}\0${header.record_revision}`)
      if (header.hasBody && value === undefined) integrity('record version has no body')
      return { ...header, value_json: value ?? '' }
    })
    return {
      manifests: manifestRows.map((row) => this.decodeManifest(row)),
      sides: sideRows.map((row) => {
        const entry = this.parseJson<unknown>(row.entry_json, 'commit side entry cannot be decoded')
        if (!isSideEntry(entry) || entry.commitId !== row.commit_id)
          integrity('commit side entry does not match its row')
        return entry
      }),
      versions,
    }
  }

  private versionRowsForRecord(recordId: string): VersionRow[] {
    const proofs = this.all<ProofRow>(
      `SELECT commit_id, ledger_seq, manifests_json, sides_json, versions_json FROM runtime_commit_proofs`,
    )
    const headers: Array<Omit<VersionRow, 'value_json'>> = []
    for (const row of proofs) {
      for (const item of this.proofArray(row.versions_json)) {
        if (!isPlainRecord(item) || item.recordId !== recordId || typeof item.recordRevision !== 'number')
          continue
        if (
          typeof item.schemaJson !== 'string' ||
          typeof item.digest !== 'string' ||
          typeof item.ownerJson !== 'string'
        )
          integrity('proof pack cannot be decoded')
        headers.push({
          record_id: recordId,
          record_revision: item.recordRevision,
          schema_json: item.schemaJson,
          commit_id: row.commit_id,
          digest: item.digest,
          owner_json: item.ownerJson,
        })
      }
    }
    headers.sort((left, right) => left.record_revision - right.record_revision)
    const bodies = this.bodyMap([recordId])
    return headers.map((header) => {
      const value = bodies.get(`${header.record_id}\0${header.record_revision}`)
      if (value === undefined) integrity('record version has no body')
      return { ...header, value_json: value }
    })
  }

  private proofById(commitId: string): ProofRow | undefined {
    return this.get<ProofRow>(
      `SELECT commit_id, ledger_seq, manifests_json, sides_json, versions_json
         FROM runtime_commit_proofs WHERE commit_id = ?`,
      commitId,
    )
  }

  private proofArray(text: string): unknown[] {
    const parsed = this.parseJson<unknown>(text, 'proof pack cannot be decoded')
    if (!Array.isArray(parsed)) integrity('proof pack cannot be decoded')
    return parsed
  }

  private bodyMap(recordIds: readonly string[]): Map<string, string> {
    const map = new Map<string, string>()
    if (recordIds.length === 0) return map
    const rows = this.all<{ record_id: string; record_revision: number; value_json: string }>(
      `SELECT record_id, record_revision, value_json FROM runtime_version_bodies
        WHERE record_id IN (SELECT value FROM json_each(?))`,
      JSON.stringify([...new Set(recordIds)]),
    )
    for (const row of rows) map.set(`${row.record_id}\0${row.record_revision}`, row.value_json)
    return map
  }

  private assertReferencedBodies(): void {
    // One pass over proof packs and one pass over bodies. A correlated json_each
    // re-parsed every pack for every body.
    const covered = new Set<string>()
    let afterCommit = ''
    for (;;) {
      const proofs = this.all<{ commit_id: string; versions_json: string }>(
        `SELECT commit_id, versions_json FROM runtime_commit_proofs
          WHERE commit_id > ? ORDER BY commit_id LIMIT ?`,
        afterCommit,
        PROOF_PAGE,
      )
      if (proofs.length === 0) break
      for (const proof of proofs) {
        for (const item of this.proofArray(proof.versions_json)) {
          if (
            !isPlainRecord(item) ||
            typeof item.recordId !== 'string' ||
            typeof item.recordRevision !== 'number'
          )
            continue
          covered.add(`${item.recordId}\0${item.recordRevision}`)
        }
      }
      const last = proofs[proofs.length - 1]
      if (!last || proofs.length < PROOF_PAGE) break
      afterCommit = last.commit_id
    }
    let afterId = ''
    let afterRevision = -1
    for (;;) {
      const bodies = this.all<{ record_id: string; record_revision: number }>(
        `SELECT record_id, record_revision FROM runtime_version_bodies
          WHERE (record_id, record_revision) > (?, ?)
          ORDER BY record_id, record_revision
          LIMIT ?`,
        afterId,
        afterRevision,
        PROOF_PAGE,
      )
      if (bodies.length === 0) return
      for (const body of bodies) {
        if (!covered.has(`${body.record_id}\0${body.record_revision}`))
          integrity('record version body has no header')
      }
      const last = bodies[bodies.length - 1]
      if (!last || bodies.length < PROOF_PAGE) return
      afterId = last.record_id
      afterRevision = last.record_revision
    }
  }

  private assertReceipt(sessionId: string, receipt: StateCommitReceipt, fingerprint: string): void {
    if (receipt.sessionId !== sessionId || receipt.firstSeq !== receipt.lastSeq)
      integrity('stored commit receipt does not match the attested commit')
    const row = this.get<EventRow>(
      `SELECT session_key, seq, ts, id, type, lane, v, actor, origin, trust, data,
              integrity_mode, integrity_prev, integrity_digest
       FROM events WHERE session_key = ? AND seq = ?`,
      sessionId,
      receipt.lastSeq,
    )
    if (!row) integrity('stored commit receipt does not match the attested commit')
    const proof = this.validatedProof(this.decodeEvent(row), false)
    if (
      proof.kind !== 'commit' ||
      proof.data.commitId !== receipt.commitId ||
      proof.data.transactionFingerprint !== receipt.transactionFingerprint ||
      proof.digest !== receipt.headDigest
    )
      integrity('stored commit receipt does not match the attested commit')
    if (proof.data.transactionFingerprint !== fingerprint) {
      const members = this.get<{ fingerprints_json: string }>(
        'SELECT fingerprints_json FROM runtime_commit_fingerprints WHERE commit_id = ?',
        receipt.commitId,
      )
      const parsed = members
        ? this.parseJson<unknown>(members.fingerprints_json, 'stored commit members cannot be decoded')
        : undefined
      if (
        !Array.isArray(parsed) ||
        !parsed.every((item) => typeof item === 'string') ||
        digestOf(parsed) !== proof.data.transactionFingerprint ||
        !parsed.includes(fingerprint)
      )
        integrity('stored commit receipt does not match the attested commit')
    }
    const packed = this.proofById(receipt.commitId)
    if (!packed || packed.ledger_seq !== receipt.lastSeq)
      integrity('stored commit receipt does not match the attested commit')
    if (proof.data.runId) {
      const recordId = runRecordId(proof.data.runId)
      const header = this.proofArray(packed.versions_json).find(
        (item) => isPlainRecord(item) && item.recordId === recordId,
      )
      if (isPlainRecord(header) && typeof header.recordRevision === 'number') {
        const version = this.get<{ value_json: string }>(
          `SELECT value_json FROM runtime_version_bodies WHERE record_id = ? AND record_revision = ?`,
          recordId,
          header.recordRevision,
        )
        if (version) {
          const value = this.parseJson<RunRecordValue>(version.value_json, 'record body cannot be decoded')
          if (value.revision !== receipt.runRevision)
            integrity('stored commit receipt does not match the attested commit')
        }
      }
    }
    const sides = this.proofArray(packed.sides_json).flatMap((item) => {
      if (!isPlainRecord(item) || item.kind !== 'action-created' || typeof item.entryJson !== 'string')
        return []
      return [item.entryJson]
    })
    for (const entryJson of sides) {
      const entry = this.parseJson<CommitSideEntry>(entryJson, 'commit side entry cannot be decoded')
      if (
        entry.kind !== 'action-created' ||
        !receipt.actionIds.some((item) => item.actionId === entry.actionId)
      )
        integrity('stored commit receipt does not match the attested commit')
    }
  }
}

export function openRuntimeStateDatabase(options: RuntimeStateDatabaseOptions): RuntimeStateDatabase {
  return new RuntimeStateDatabase(options)
}
