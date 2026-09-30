import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { defaultIds, type Event, LedgerIntegrityFailure, verifyIntegrityRows } from '@agnes/core'
import type {
  AdmissionProbe,
  AdmitInvocationResult,
  AdvanceRunRequest,
  CloseInvocationRequest,
  CloseInvocationResult,
  CommitControlRequest,
  DispatchAdmissionProbe,
  DispatchAdmissionRequest,
  DispatchAdmissionResult,
  InvocationAdmission,
  RunAdmission,
  StateAuthorityRef,
  StateCommitReceipt,
  StateLeaseRequest,
  StateLeaseResult,
  StateOpenRequest,
  StateOpenResult,
  WriterClaim,
} from '@agnes/extension-api/runtime'
import {
  EventEnvelope,
  RuntimeCommitData as RuntimeCommitSchema,
  RuntimeFormatData,
} from '@agnes/protocol/gen/session-v1'
import { TypeCompiler } from '@sinclair/typebox/compiler'
import { DDL } from '../../adapters/ddl.js'
import { syncCheckpointsToMedium } from '../../adapters/sqlite-durability.js'
import { canonicalJson } from './canonical-json.js'
import {
  admitInvocationTx,
  advanceRunTx,
  type ControlPorts,
  type ControlScan,
  closeInvocationTx,
  commitControlTx,
  createControlScan,
  dispatchAdmissionTx,
  finishControlScan,
  noteControlSide,
  noteControlVersion,
  probeDispatchTx,
  type WriteCommitInput,
} from './control.js'
import {
  bodyDigest,
  type ChainRow,
  type CommitMutationManifest,
  type CommitSideEntry,
  canonicalStoredBodyDigest,
  createManifest,
  digestOf,
  emptyIntegrity,
  FORMAT_EVENT,
  FORMAT_VERSION,
  type FormatEventData,
  type IntegrityState,
  isSideEntry,
  knownSchema,
  type LedgerEvent,
  MIN_READER,
  type MutationNext,
  matchesKnownSchema,
  matchesKnownSchemaText,
  mutationDigest,
  protectEvent,
  type RecordOwner,
  RUN_RECORD_SCHEMA,
  RUN_TAINT_SCHEMA,
  RUNTIME_ACTOR,
  RUNTIME_SCHEMA_MAJOR,
  type RunRecordValue,
  type RuntimeCommitData,
  runRecordId,
  SESSION_IDENTITY_SCHEMA,
  type SessionIdentityValue,
  STATE_COMMIT_EVENT,
  type StoredRecord,
  sameJson,
  sameSideCounts,
  sessionIdentityRecordId,
  sideCounts,
  sideEntryIdentity,
  sideListsDigest,
  taintRecordId,
} from './records.js'
import { integrity, refuse, StateRefusal } from './refusal.js'

const SNAPSHOT_TTL_MS = 60_000
const PROOF_PAGE = 500
const proofChecks = {
  envelope: TypeCompiler.Compile(EventEnvelope),
  commit: TypeCompiler.Compile(RuntimeCommitSchema),
  format: TypeCompiler.Compile(RuntimeFormatData),
}
const VERSIONS_BY_COMMIT = `SELECT record_id, record_revision, schema_json, commit_id, digest, owner_json, value_json
  FROM runtime_record_versions WHERE commit_id IN (SELECT value FROM json_each(?))`
const MANIFESTS_BY_COMMIT = `SELECT commit_id, record_id, previous_revision, next_json
  FROM runtime_mutation_manifests WHERE commit_id IN (SELECT value FROM json_each(?))`
const SIDES_BY_COMMIT = `SELECT commit_id, entry_json
  FROM runtime_side_entries WHERE commit_id IN (SELECT value FROM json_each(?))`
const HEADS_BY_COMMIT = `SELECT h.record_id, h.min_reader, h.record_revision, h.last_commit_id, h.body_digest,
       (v.record_id IS NOT NULL) AS has_version,
       (v.record_id IS NOT NULL
         AND h.schema_json = v.schema_json
         AND h.owner_json = v.owner_json
         AND h.value_json = v.value_json
         AND h.body_digest = v.digest) AS same_text,
       CASE WHEN h.record_id = ? THEN h.value_json END AS identity_json
  FROM runtime_records h
  LEFT JOIN runtime_record_versions v
    ON v.record_id = h.record_id
   AND v.commit_id = h.last_commit_id
   AND v.record_revision = h.record_revision
 WHERE h.last_commit_id IN (SELECT value FROM json_each(?))`
const HEAD_BY_ID = `SELECT record_id, schema_json, min_reader, record_revision, last_commit_id, owner_json, value_json, body_digest
  FROM runtime_records WHERE record_id = ?`

const RUNTIME_DDL = [
  `CREATE TABLE IF NOT EXISTS runtime_records (
     record_id TEXT PRIMARY KEY,
     schema_json TEXT NOT NULL,
     min_reader INTEGER NOT NULL,
     record_revision INTEGER NOT NULL,
     last_commit_id TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     owner_json TEXT NOT NULL,
     value_json TEXT NOT NULL,
     body_digest TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS runtime_records_commit ON runtime_records (last_commit_id)`,
  `CREATE TABLE IF NOT EXISTS runtime_record_versions (
     record_id TEXT NOT NULL,
     record_revision INTEGER NOT NULL,
     schema_json TEXT NOT NULL,
     commit_id TEXT NOT NULL,
     digest TEXT NOT NULL,
     owner_json TEXT NOT NULL,
     value_json TEXT NOT NULL,
     PRIMARY KEY (record_id, record_revision))`,
  `CREATE INDEX IF NOT EXISTS runtime_record_versions_commit ON runtime_record_versions (commit_id)`,
  `CREATE TABLE IF NOT EXISTS runtime_mutation_manifests (
     commit_id TEXT NOT NULL,
     record_id TEXT NOT NULL,
     previous_revision INTEGER,
     next_json TEXT,
     PRIMARY KEY (commit_id, record_id))`,
  `CREATE INDEX IF NOT EXISTS runtime_mutation_manifests_commit ON runtime_mutation_manifests (commit_id)`,
  `CREATE TABLE IF NOT EXISTS runtime_side_entries (
     commit_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     identity TEXT NOT NULL,
     entry_json TEXT NOT NULL,
     PRIMARY KEY (commit_id, kind, identity))`,
  `CREATE INDEX IF NOT EXISTS runtime_side_entries_commit ON runtime_side_entries (commit_id)`,
  `CREATE TABLE IF NOT EXISTS runtime_admissions (
     ticket_id TEXT PRIMARY KEY,
     fingerprint TEXT NOT NULL,
     run_id TEXT NOT NULL,
     probe_json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS runtime_request_results (
     method TEXT NOT NULL,
     request_id TEXT NOT NULL,
     fingerprint TEXT NOT NULL,
     result_json TEXT NOT NULL,
     PRIMARY KEY (method, request_id))`,
  `CREATE TABLE IF NOT EXISTS runtime_leases (
     scope_id TEXT PRIMARY KEY,
     writer_id TEXT,
     writer_epoch INTEGER,
     lease_until INTEGER,
     authority_epoch INTEGER NOT NULL,
     last_writer_epoch INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS runtime_session_meta (
     session_id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     format_version INTEGER NOT NULL,
     min_reader INTEGER NOT NULL,
     authority_json TEXT NOT NULL,
     parent_json TEXT NOT NULL,
     latest_commit_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS runtime_dispatch_domains (
     session_id TEXT PRIMARY KEY,
     domain_json TEXT NOT NULL)`,
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

type ParsedCommit = { seq: number; data: RuntimeCommitData; digest: string }

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

export type RuntimeStateDatabaseOptions = {
  file: string
  authority: StateAuthorityRef
  now?: () => number
  beforeCommit?: () => void
}

export class RuntimeStateDatabase {
  private readonly db: DatabaseSync
  private readonly statements = new Map<string, StatementSync>()
  private readonly authority: StateAuthorityRef
  private readonly now: () => number
  private readonly beforeCommit: (() => void) | undefined
  private readonly ids: ReturnType<typeof defaultIds>
  private readonly verifiedHeads = new Map<string, VerifiedSession>()
  private closed = false

  constructor(options: RuntimeStateDatabaseOptions) {
    this.authority = options.authority
    this.now = options.now ?? (() => Date.now())
    this.beforeCommit = options.beforeCommit
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
    const opened = await this.tx(async () => {
      const meta = this.sessionMeta(request.sessionId)
      if (!meta) refuse('invalid_input', 'session_absent', 'session does not exist')
      // Opening verifies the whole session again, so a cached head cannot hide earlier tampering.
      const verified = await this.verifySessionFully(meta)
      if (request.mode !== 'write') {
        // A read open takes no writer authority, so a repeated request id is a new snapshot.
        return { verified, result: this.openResult(request, verified, null) }
      }
      const fingerprint = digestOf(request)
      const replayed = this.replayRequest<StateOpenResult>('open', request.requestId, fingerprint)
      if (replayed) {
        this.assertOpenReplay(replayed, verified, request.sessionId)
        return { verified, result: replayed }
      }
      const claim = this.takeLease(request.sessionId, request.writerId, request.ttlMs)
      const result = this.openResult(request, verified, claim)
      this.rememberRequest('open', request.requestId, fingerprint, result)
      return { verified, result }
    })
    this.verifiedHeads.set(request.sessionId, opened.verified)
    return opened.result
  }

  async lease(request: StateLeaseRequest): Promise<StateLeaseResult> {
    return this.tx(async () => {
      if (request.expectedWriterEpoch === null)
        refuse('invalid_input', 'writer_epoch', 'lease operation needs an expected writer epoch')
      const verified = await this.requireSession(request.sessionId)
      const fingerprint = digestOf(request)
      const replayed = this.replayRequest<StateLeaseResult>('lease', request.requestId, fingerprint)
      if (replayed) {
        this.assertLeaseReplay(replayed, request.sessionId)
        return replayed
      }
      if (request.expectedLastSeq !== verified.lastSeq)
        refuse('conflict', 'seq_mismatch', 'expected sequence does not match the verified head')
      const current = this.loadLease(request.sessionId)
      const now = this.now()
      const result = this.applyLease(request, current, now)
      this.rememberRequest('lease', request.requestId, fingerprint, result)
      return result
    })
  }

  async createRun(input: CreateRunInput): Promise<AdmissionProbe> {
    const committed = await this.tx(async (): Promise<CommittedRun> => {
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
        return { probe }
      }
      if (
        this.get(
          'SELECT record_id FROM runtime_records WHERE record_id = ?',
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
      const manifests = records.map((record) => createManifest(commitId, record))
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
      this.appendEvent(input.admission.sessionId, commit, protectedCommit.integrity)
      if (firstSeq === 0) firstSeq = commit.seq
      for (const record of records) this.insertRecord(record, commitId, at)
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
             session_id, workspace_id, format_version, min_reader, authority_json, parent_json, latest_commit_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
      // Remember the new head only after commit, so a rolled-back write cannot advance the cache.
      return {
        probe,
        head: {
          sessionId: input.admission.sessionId,
          verified: {
            lastSeq: commit.seq,
            formatSeq: verified?.formatSeq ?? firstSeq,
            headDigest: protectedCommit.integrity.digest,
            latestCommitId: commitId,
            workspaceId: input.admission.workspaceId,
            formatVersion: FORMAT_VERSION,
            minReader: MIN_READER,
            parent: verified?.parent ?? null,
            chain: protectedCommit.state,
          },
        },
      }
    })
    if (committed.head) this.verifiedHeads.set(committed.head.sessionId, committed.head.verified)
    return committed.probe
  }

  async admitInvocation(request: InvocationAdmission): Promise<AdmitInvocationResult> {
    return this.finishControl(await this.tx(() => admitInvocationTx(this.controlPorts(), request)))
  }

  async closeInvocation(request: CloseInvocationRequest): Promise<CloseInvocationResult> {
    return this.finishControl(await this.tx(() => closeInvocationTx(this.controlPorts(), request)))
  }

  async advanceRun(request: AdvanceRunRequest): Promise<StateCommitReceipt> {
    return this.finishControl(await this.tx(() => advanceRunTx(this.controlPorts(), request)))
  }

  async dispatchAdmission(request: DispatchAdmissionRequest): Promise<DispatchAdmissionResult> {
    return this.finishControl(await this.tx(() => dispatchAdmissionTx(this.controlPorts(), request)))
  }

  probeDispatchAdmission(admissionId: string): DispatchAdmissionProbe {
    return probeDispatchTx(this.controlPorts(), admissionId)
  }

  async commitControl(request: CommitControlRequest): Promise<StateCommitReceipt> {
    return this.finishControl(await this.tx(() => commitControlTx(this.controlPorts(), request)))
  }

  private finishControl<T>(committed: { result: T; sessionId: string; verified?: VerifiedSession }): T {
    if (committed.verified) this.verifiedHeads.set(committed.sessionId, committed.verified)
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
    return [identity, run, taint]
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

  private async requireSession(sessionId: string): Promise<VerifiedSession> {
    const meta = this.sessionMeta(sessionId)
    if (!meta) refuse('invalid_input', 'session_absent', 'session does not exist')
    const cached = this.verifiedHeads.get(sessionId)
    if (cached && this.headMatches(sessionId, cached)) return cached
    const verified = await this.verifySessionFully(meta)
    this.verifiedHeads.set(sessionId, verified)
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
    const sessionId = meta.session_id
    const authority = this.parseJson<StateAuthorityRef>(
      meta.authority_json,
      'session authority cannot be decoded',
    )
    if (!sameJson(authority, this.authority))
      refuse('conflict', 'authority', 'session authority does not match this store')
    if (
      meta.format_version !== FORMAT_VERSION ||
      !Number.isSafeInteger(meta.min_reader) ||
      meta.min_reader !== MIN_READER
    )
      integrity('session format is not readable')
    const product = this.get<{ format_version: number }>(
      'SELECT format_version FROM sessions WHERE session_key = ?',
      sessionId,
    )
    if (!product || product.format_version !== FORMAT_VERSION) integrity('session format row is missing')

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
          if (!Number.isSafeInteger(format.minReader) || format.minReader !== MIN_READER)
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
        const commit = { seq: proof.event.seq, data: proof.data, digest: proof.digest }
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
    finishControlScan(control, {
      sessionId,
      requests: () =>
        this.all<{ request_id: string; fingerprint: string; result_json: string }>(
          `SELECT request_id, fingerprint, result_json
           FROM runtime_request_results WHERE method = 'dispatchAdmission'`,
        ),
      domainJson: () =>
        this.get<{ domain_json: string }>(
          'SELECT domain_json FROM runtime_dispatch_domains WHERE session_id = ?',
          sessionId,
        )?.domain_json,
    })
    await this.verifySessionAdmissions(sessionId, runs, formatSeq)
    return {
      lastSeq: chain.lastSeq,
      formatSeq,
      headDigest: chain.headDigest,
      latestCommitId,
      workspaceId: meta.workspace_id,
      formatVersion: meta.format_version,
      minReader: MIN_READER,
      parent: heads.parent,
      chain,
    }
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
    const manifests = this.all<ManifestRow>(MANIFESTS_BY_COMMIT, idsJson).map((row) =>
      this.decodeManifest(row),
    )
    const sides = this.all<SideRow>(SIDES_BY_COMMIT, idsJson).map((row) => {
      const entry = this.parseJson<unknown>(row.entry_json, 'commit side entry cannot be decoded')
      if (!isSideEntry(entry) || entry.commitId !== row.commit_id)
        integrity('commit side entry does not match its row')
      return entry
    })
    const versions = this.all<VersionRow>(VERSIONS_BY_COMMIT, idsJson)
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
        noteControlVersion(control, version)
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
      return value
    }
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
    for (const head of this.all<HeadSummary>(HEADS_BY_COMMIT, identityId, idsJson))
      this.verifyHeadSummary(head, versionsByKey, live, scan, identityId)
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
    } else if (!Number.isSafeInteger(head.min_reader) || head.min_reader !== MIN_READER)
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
    const versions = this.all<VersionRow>(
      `SELECT record_id, record_revision, schema_json, commit_id, digest, owner_json, value_json
       FROM runtime_record_versions WHERE record_id = ? ORDER BY record_revision`,
      runRecordId(row.run_id),
    )
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
        { seq: proof.event.seq, data: proof.data, digest: proof.digest },
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

  private assertOpenReplay(result: StateOpenResult, verified: VerifiedSession, sessionId: string): void {
    const snapshot = result.snapshot
    if (
      !snapshot ||
      snapshot.sessionId !== sessionId ||
      result.formatVersion !== verified.formatVersion ||
      result.minReader !== verified.minReader ||
      !sameJson(result.parent, verified.parent)
    )
      integrity('stored open result does not match the verified session')
    if (!Number.isSafeInteger(snapshot.throughSeq) || snapshot.throughSeq > verified.lastSeq)
      integrity('stored open result is ahead of the verified head')
    if (snapshot.throughSeq === verified.lastSeq && snapshot.headDigest !== verified.headDigest)
      integrity('stored open result does not match the verified head')
    if (!result.claim) integrity('stored write-open result has no writer claim')
    this.assertClaim(result.claim, this.loadLease(sessionId), sessionId)
  }

  private assertLeaseReplay(result: StateLeaseResult, sessionId: string): void {
    const lease = this.loadLease(sessionId)
    if (!Number.isSafeInteger(result.lastWriterEpoch) || result.lastWriterEpoch > lease.last_writer_epoch)
      integrity('stored writer epoch does not match the lease')
    if (result.claim) this.assertClaim(result.claim, lease, sessionId)
  }

  private assertClaim(claim: WriterClaim, lease: LeaseRow, sessionId: string): void {
    if (claim.scopeId !== sessionId) integrity('stored writer claim does not match the lease')
    if (
      !Number.isSafeInteger(claim.writerEpoch) ||
      claim.writerEpoch < 1 ||
      claim.writerEpoch > lease.last_writer_epoch
    )
      integrity('stored writer epoch does not match the lease')
    if (lease.writer_epoch !== claim.writerEpoch) return
    if (lease.writer_id !== claim.writerId || lease.authority_epoch !== claim.authorityEpoch)
      integrity('stored writer claim does not match the lease')
    if (lease.lease_until === null || new Date(lease.lease_until).toISOString() !== claim.leaseUntil)
      integrity('stored writer claim does not match the lease')
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
    this.run(
      'INSERT INTO runtime_request_results (method, request_id, fingerprint, result_json) VALUES (?, ?, ?, ?)',
      method,
      requestId,
      fingerprint,
      JSON.stringify(result),
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
    if (!Number.isSafeInteger(head.min_reader) || head.min_reader !== MIN_READER)
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
    const known = schema.typeId === undefined ? undefined : knownSchema(schema.typeId)
    if (!known || !sameJson(known, schema)) integrity('record schema does not match the codec')
    return schema
  }

  private decodeEvent(row: EventRow): ChainRow {
    let actor: LedgerEvent['actor']
    let data: unknown
    try {
      actor = JSON.parse(row.actor) as LedgerEvent['actor']
      data = JSON.parse(row.data) as unknown
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

  private takeLease(sessionId: string, writerId: string, ttlMs: number): WriterClaim {
    const current = this.loadLease(sessionId)
    if (this.leaseIsLive(current, this.now())) refuse('conflict', 'writer_lease', 'writer lease is held')
    return this.saveClaim(
      sessionId,
      writerId,
      current.last_writer_epoch + 1,
      this.now() + ttlMs,
      current.last_writer_epoch + 1,
    )
  }

  private grantLease(request: StateLeaseRequest, current: LeaseRow, now: number): StateLeaseResult {
    if (this.leaseIsLive(current, now) || request.expectedWriterEpoch !== current.last_writer_epoch)
      refuse('conflict', 'writer_lease', 'writer lease is held')
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
    return (
      this.get<LeaseRow>(
        `SELECT writer_id, writer_epoch, lease_until, authority_epoch, last_writer_epoch
         FROM runtime_leases WHERE scope_id = ?`,
        sessionId,
      ) ?? {
        writer_id: null,
        writer_epoch: null,
        lease_until: null,
        authority_epoch: this.authority.authorityEpoch,
        last_writer_epoch: 0,
      }
    )
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

  private insertRecord(record: StoredRecord, commitId: string, at: string): void {
    const digest = bodyDigest(record.owner, record.value)
    const manifest = createManifest(commitId, record)
    const schemaJson = canonicalJson(record.schema)
    const ownerJson = canonicalJson(record.owner)
    const valueJson = canonicalJson(record.value)
    this.run(
      `INSERT INTO runtime_records (
         record_id, schema_json, min_reader, record_revision, last_commit_id, created_at, updated_at,
         owner_json, value_json, body_digest
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.recordId,
      schemaJson,
      record.minReader,
      record.recordRevision,
      commitId,
      at,
      at,
      ownerJson,
      valueJson,
      digest,
    )
    this.run(
      `INSERT INTO runtime_record_versions (
         record_id, record_revision, schema_json, commit_id, digest, owner_json, value_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      record.recordId,
      record.recordRevision,
      schemaJson,
      commitId,
      digest,
      ownerJson,
      valueJson,
    )
    this.run(
      `INSERT INTO runtime_mutation_manifests (commit_id, record_id, previous_revision, next_json)
       VALUES (?, ?, ?, ?)`,
      manifest.commitId,
      manifest.recordId,
      manifest.previousRevision,
      manifest.next === null ? null : canonicalJson(manifest.next),
    )
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
      JSON.stringify(event.actor),
      event.origin,
      event.trust,
      JSON.stringify(event.data),
      integrityMetadata.mode,
      integrityMetadata.previousDigest,
      integrityMetadata.digest,
    )
  }

  private sessionMeta(sessionId: string): MetaRow | undefined {
    return this.get<MetaRow>('SELECT * FROM runtime_session_meta WHERE session_id = ?', sessionId)
  }

  private async tx<T>(body: () => T | Promise<T>): Promise<T> {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = await body()
      this.beforeCommit?.()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Report the original failure. A failed rollback has nothing further to commit.
      }
      throw error
    }
  }

  private parseJson<T>(text: string, message: string): T {
    try {
      return JSON.parse(text) as T
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
    return this.statement(sql).get(...args) as T | undefined
  }

  private one<T>(sql: string, ...args: SQLInputValue[]): T {
    const row = this.get<T>(sql, ...args)
    if (row === undefined) integrity('required database row is missing')
    return row
  }

  private all<T>(sql: string, ...args: SQLInputValue[]): T[] {
    return this.statement(sql).all(...args) as T[]
  }

  private run(sql: string, ...args: SQLInputValue[]): void {
    this.statement(sql).run(...args)
  }

  private controlPorts(): ControlPorts {
    return {
      now: () => this.now(),
      authority: this.authority,
      ulid: () => this.ids.ulid(),
      get: (sql, ...args) => this.get(sql, ...args),
      all: (sql, ...args) => this.all(sql, ...args),
      run: (sql, ...args) => this.run(sql, ...args),
      requireSession: (sessionId) => this.requireSession(sessionId),
      replayRequest: (method, requestId, fingerprint) => this.replayRequest(method, requestId, fingerprint),
      rememberRequest: (method, requestId, fingerprint, result) =>
        this.rememberRequest(method, requestId, fingerprint, result),
      loadHead: (recordId) => this.get(HEAD_BY_ID, recordId),
      writeCommit: (input) => this.writeCommit(input),
      assertReceipt: (sessionId, receipt, fingerprint) => this.assertReceipt(sessionId, receipt, fingerprint),
    }
  }

  private writeCommit(input: WriteCommitInput): { receipt: StateCommitReceipt; verified: VerifiedSession } {
    const manifests = [
      ...input.creates.map((record) => createManifest(input.commitId, record)),
      ...input.updates.map((update) =>
        createManifest(input.commitId, update.record, update.previousRevision),
      ),
    ]
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
    const commit = this.event(this.ids.ulid(), input.at, STATE_COMMIT_EVENT, data, input.verified.chain)
    const protectedCommit = protectEvent(input.sessionId, commit, input.verified.chain)
    this.appendEvent(input.sessionId, commit, protectedCommit.integrity)
    for (const record of input.creates) this.insertRecord(record, input.commitId, input.at)
    for (const update of input.updates)
      this.updateRecord(update.record, update.previousRevision, input.commitId, input.at)
    for (const side of input.sides) this.insertSide(side)
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
      verified: {
        lastSeq: commit.seq,
        formatSeq: input.verified.formatSeq,
        headDigest: protectedCommit.integrity.digest,
        latestCommitId: input.commitId,
        workspaceId: input.verified.workspaceId,
        formatVersion: input.verified.formatVersion,
        minReader: input.verified.minReader,
        parent: input.verified.parent,
        chain: protectedCommit.state,
      },
    }
  }

  private updateRecord(record: StoredRecord, previousRevision: number, commitId: string, at: string): void {
    const digest = bodyDigest(record.owner, record.value)
    const manifest = createManifest(commitId, record, previousRevision)
    const schemaJson = canonicalJson(record.schema)
    const ownerJson = canonicalJson(record.owner)
    const valueJson = canonicalJson(record.value)
    const updated = this.statement(
      `UPDATE runtime_records
       SET schema_json = ?, record_revision = ?, last_commit_id = ?, updated_at = ?,
           owner_json = ?, value_json = ?, body_digest = ?
       WHERE record_id = ? AND record_revision = ?`,
    ).run(
      schemaJson,
      record.recordRevision,
      commitId,
      at,
      ownerJson,
      valueJson,
      digest,
      record.recordId,
      previousRevision,
    )
    if (Number(updated.changes) !== 1) integrity('record head update missed its row')
    this.run(
      `INSERT INTO runtime_record_versions (
         record_id, record_revision, schema_json, commit_id, digest, owner_json, value_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      record.recordId,
      record.recordRevision,
      schemaJson,
      commitId,
      digest,
      ownerJson,
      valueJson,
    )
    this.run(
      `INSERT INTO runtime_mutation_manifests (commit_id, record_id, previous_revision, next_json)
       VALUES (?, ?, ?, ?)`,
      manifest.commitId,
      manifest.recordId,
      manifest.previousRevision,
      manifest.next === null ? null : canonicalJson(manifest.next),
    )
  }

  private insertSide(entry: CommitSideEntry): void {
    this.run(
      `INSERT INTO runtime_side_entries (commit_id, kind, identity, entry_json) VALUES (?, ?, ?, ?)`,
      entry.commitId,
      entry.kind,
      sideEntryIdentity(entry),
      canonicalJson(entry),
    )
  }

  private assertReceipt(sessionId: string, receipt: StateCommitReceipt, fingerprint: string): void {
    if (receipt.transactionFingerprint !== fingerprint)
      integrity('stored commit receipt does not match the request')
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
      proof.data.transactionFingerprint !== fingerprint ||
      proof.digest !== receipt.headDigest
    )
      integrity('stored commit receipt does not match the attested commit')
    if (proof.data.runId) {
      const version = this.get<{ value_json: string }>(
        `SELECT value_json FROM runtime_record_versions WHERE commit_id = ? AND record_id = ?`,
        receipt.commitId,
        runRecordId(proof.data.runId),
      )
      if (version) {
        const value = this.parseJson<RunRecordValue>(version.value_json, 'record body cannot be decoded')
        if (value.revision !== receipt.runRevision)
          integrity('stored commit receipt does not match the attested commit')
      }
    }
    const sides = this.all<{ entry_json: string }>(
      `SELECT entry_json FROM runtime_side_entries WHERE commit_id = ? AND kind = 'action-created'`,
      receipt.commitId,
    )
    for (const side of sides) {
      const entry = this.parseJson<CommitSideEntry>(side.entry_json, 'commit side entry cannot be decoded')
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
