import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { defaultIds, type Event, LedgerIntegrityFailure, verifyIntegrityRows } from '@agnes/core'
import type {
  AdmissionProbe,
  RunAdmission,
  StateAuthorityRef,
  StateCommitReceipt,
  StateLeaseRequest,
  StateLeaseResult,
  StateOpenRequest,
  StateOpenResult,
  WriterClaim,
} from '@agnes/extension-api/runtime'
import { validateEvent } from '@agnes/protocol'
import { DDL } from '../../adapters/ddl.js'
import { syncCheckpointsToMedium } from '../../adapters/sqlite-durability.js'
import {
  bodyDigest,
  type ChainRow,
  type CommitMutationManifest,
  type CommitSideEntry,
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
  sessionIdentityRecordId,
  sideCounts,
  sideListsDigest,
  taintRecordId,
} from './records.js'

const SNAPSHOT_TTL_MS = 60_000

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
]

export type StateFailure = {
  code: 'invalid_input' | 'conflict' | 'incompatible' | 'internal'
  detailCode: string
  message: string
}

export class StateRefusal extends Error {
  readonly failure: StateFailure
  constructor(failure: StateFailure) {
    super(failure.message)
    this.name = 'StateRefusal'
    this.failure = failure
  }
}

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

type ParsedCommit = { seq: number; data: RuntimeCommitData; digest: string }

type ValidatedProof =
  | { kind: 'format'; event: LedgerEvent; data: FormatEventData; digest: string }
  | { kind: 'commit'; event: LedgerEvent; data: RuntimeCommitData; digest: string }

function refuse(code: StateFailure['code'], detailCode: string, message: string): never {
  throw new StateRefusal({ code, detailCode, message })
}

function integrity(message: string): never {
  refuse('incompatible', 'integrity', message)
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

  open(request: StateOpenRequest): StateOpenResult {
    return this.tx(() => {
      const verified = this.requireSession(request.sessionId)
      if (request.mode !== 'write') {
        // A read open takes no writer authority, so a repeated request id is a new snapshot.
        return this.openResult(request, verified, null)
      }
      const fingerprint = digestOf(request)
      const replayed = this.replayRequest<StateOpenResult>('open', request.requestId, fingerprint)
      if (replayed) return replayed
      const claim = this.takeLease(request.sessionId, request.writerId, request.ttlMs)
      const result = this.openResult(request, verified, claim)
      this.rememberRequest('open', request.requestId, fingerprint, result)
      return result
    })
  }

  lease(request: StateLeaseRequest): StateLeaseResult {
    return this.tx(() => {
      if (request.expectedWriterEpoch === null)
        refuse('invalid_input', 'writer_epoch', 'lease operation needs an expected writer epoch')
      const verified = this.requireSession(request.sessionId)
      if (request.expectedLastSeq !== verified.lastSeq)
        refuse('conflict', 'seq_mismatch', 'expected sequence does not match the verified head')
      const fingerprint = digestOf(request)
      const replayed = this.replayRequest<StateLeaseResult>('lease', request.requestId, fingerprint)
      if (replayed) return replayed
      const current = this.loadLease(request.sessionId)
      const now = this.now()
      const result = this.applyLease(request, current, now)
      this.rememberRequest('lease', request.requestId, fingerprint, result)
      return result
    })
  }

  createRun(input: CreateRunInput): AdmissionProbe {
    return this.tx(() => {
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
        this.requireSession(input.admission.sessionId)
        const probe = this.parseJson<AdmissionProbe>(
          stored.probe_json,
          'stored admission probe cannot be decoded',
        )
        if (probe.state !== 'created' || probe.commit.transactionFingerprint !== digestOf(input.admission))
          integrity('admission replay does not match the attested commit')
        return probe
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
        ? this.requireSession(input.admission.sessionId)
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
      return probe
    })
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

  private requireSession(sessionId: string): VerifiedSession {
    if (!this.sessionMeta(sessionId)) refuse('invalid_input', 'session_absent', 'session does not exist')
    const verified = this.verifyAll().get(sessionId)
    if (!verified) integrity('session failed verification')
    return verified
  }

  private verifyEmptyOrOthers(sessionId: string): VerifiedSession | undefined {
    if (this.databaseIsEmpty()) return undefined
    const verified = this.verifyAll()
    if (verified.has(sessionId)) integrity('session identity is missing from the catalogue')
    return undefined
  }

  private databaseIsEmpty(): boolean {
    for (const table of [
      'runtime_session_meta',
      'events',
      'runtime_records',
      'runtime_record_versions',
      'runtime_mutation_manifests',
      'runtime_side_entries',
    ]) {
      const count = this.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
      if (count.n !== 0) return false
    }
    return true
  }

  private verifyAll(): Map<string, VerifiedSession> {
    const metas = this.all<MetaRow>('SELECT * FROM runtime_session_meta')
    const keys = new Set(metas.map((meta) => meta.session_id))
    for (const row of this.all<{ session_key: string }>('SELECT DISTINCT session_key FROM events')) {
      if (!keys.has(row.session_key)) integrity('ledger events have no session identity')
    }
    const attested = new Map<string, ParsedCommit>()
    const verified = new Map<string, VerifiedSession>()
    for (const meta of metas) {
      const session = this.verifySession(meta, attested)
      verified.set(meta.session_id, session)
    }
    this.verifyProofs(attested, verified)
    this.verifyAdmissions(attested, verified)
    return verified
  }

  private verifySession(meta: MetaRow, attested: Map<string, ParsedCommit>): VerifiedSession {
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
      meta.session_id,
    )
    if (!product || product.format_version !== FORMAT_VERSION) integrity('session format row is missing')
    const rows = this.all<EventRow>(
      `SELECT session_key, seq, ts, id, type, lane, v, actor, origin, trust, data,
              integrity_mode, integrity_prev, integrity_digest
       FROM events WHERE session_key = ? ORDER BY seq`,
      meta.session_id,
    ).map((row) => this.decodeEvent(row))
    if (rows.length === 0) integrity('session has no ledger events')
    let chain: IntegrityState
    try {
      chain = verifyIntegrityRows(
        rows.map((row) => ({
          sessionKey: meta.session_id,
          event: row.event as Event,
          integrity: row.integrity,
        })),
      )
    } catch (error) {
      integrity(
        error instanceof LedgerIntegrityFailure || error instanceof Error
          ? error.message
          : 'ledger integrity verification failed',
      )
    }
    const proofs = rows.map((row) => this.validatedProof(row))
    const first = proofs[0]
    if (first?.kind !== 'format') integrity('session format declaration is missing')
    const format = first.data
    if (!Number.isSafeInteger(format.minReader) || format.minReader !== MIN_READER)
      integrity('session format reader requirement is not readable')
    if (format.legacyThroughSeq !== 0 || format.sourceHeadDigest !== null || format.previousFormat !== 1)
      integrity('session format declaration does not match the ledger anchor')
    const commits: ParsedCommit[] = []
    for (const row of proofs.slice(1)) {
      if (row.kind !== 'commit') integrity('unexpected ledger event')
      if (row.data.authorityEpoch !== this.authority.authorityEpoch)
        integrity('state commit authority does not match this store')
      commits.push({ seq: row.event.seq, data: row.data, digest: row.digest })
    }
    if (commits.length === 0) integrity('session has no state commit attestation')
    let previous: string | null = null
    for (const commit of commits) {
      if (commit.data.previousCommitId !== previous) integrity('state commit predecessor does not match')
      if (attested.has(commit.data.commitId)) integrity('duplicate state commit')
      attested.set(commit.data.commitId, commit)
      previous = commit.data.commitId
    }
    const latest = commits[commits.length - 1]
    if (!latest || meta.latest_commit_id !== latest.data.commitId)
      integrity('session head commit does not match')
    if (chain.headDigest === null) integrity('session head digest is missing')
    return {
      lastSeq: chain.lastSeq,
      formatSeq: first.event.seq,
      headDigest: chain.headDigest,
      latestCommitId: latest.data.commitId,
      workspaceId: meta.workspace_id,
      formatVersion: meta.format_version,
      minReader: format.minReader,
      parent: this.parseJson(meta.parent_json, 'session parent cannot be decoded'),
      chain,
    }
  }

  private validatedProof(row: ChainRow): ValidatedProof {
    if (!row.integrity) integrity('runtime ledger row is missing integrity')
    const checked = validateEvent(row.event)
    if (!checked.ok) integrity('stored ledger event is not a registered proof')
    if (checked.value.type === FORMAT_EVENT)
      return {
        kind: 'format',
        event: row.event,
        data: checked.value.data as FormatEventData,
        digest: row.integrity.digest,
      }
    if (checked.value.type === STATE_COMMIT_EVENT)
      return {
        kind: 'commit',
        event: row.event,
        data: checked.value.data as RuntimeCommitData,
        digest: row.integrity.digest,
      }
    integrity('unexpected ledger event')
  }

  private verifyProofs(attested: Map<string, ParsedCommit>, sessions: Map<string, VerifiedSession>): void {
    const manifests = this.all<ManifestRow>(
      'SELECT commit_id, record_id, previous_revision, next_json FROM runtime_mutation_manifests',
    ).map((row) => this.decodeManifest(row))
    const sides = this.all<SideRow>('SELECT commit_id, entry_json FROM runtime_side_entries').map((row) => {
      const entry = this.parseJson<unknown>(row.entry_json, 'commit side entry cannot be decoded')
      if (!isSideEntry(entry) || entry.commitId !== row.commit_id)
        integrity('commit side entry does not match its row')
      return entry
    })
    const versions = this.all<VersionRow>(
      `SELECT record_id, record_revision, schema_json, commit_id, digest, owner_json, value_json
       FROM runtime_record_versions`,
    )
    const heads = this.all<HeadRow>(
      `SELECT record_id, schema_json, min_reader, record_revision, last_commit_id, owner_json, value_json, body_digest
       FROM runtime_records`,
    )
    for (const manifest of manifests)
      if (!attested.has(manifest.commitId)) integrity('orphan mutation manifest')
    for (const side of sides) if (!attested.has(side.commitId)) integrity('orphan commit side entry')
    for (const version of versions) if (!attested.has(version.commit_id)) integrity('orphan record version')
    const byCommit = new Map<string, CommitMutationManifest[]>()
    for (const manifest of manifests) {
      const list = byCommit.get(manifest.commitId) ?? []
      list.push(manifest)
      byCommit.set(manifest.commitId, list)
    }
    const sidesByCommit = new Map<string, CommitSideEntry[]>()
    for (const side of sides) {
      const list = sidesByCommit.get(side.commitId) ?? []
      list.push(side)
      sidesByCommit.set(side.commitId, list)
    }
    for (const [commitId, commit] of attested) {
      const commitManifests = byCommit.get(commitId) ?? []
      const commitSides = sidesByCommit.get(commitId) ?? []
      if (commit.data.mutationCount !== commitManifests.length)
        integrity('mutation count does not match manifests')
      if (commit.data.mutationsDigest !== mutationDigest(commitManifests))
        integrity('mutation digest does not match manifests')
      if (commit.data.sideListsDigest !== sideListsDigest(commitSides))
        integrity('side list digest does not match entries')
      if (!sameJson(commit.data.counts, sideCounts(commitSides)))
        integrity('side counts do not match entries')
      for (const manifest of commitManifests) this.verifyManifestVersion(manifest, versions)
    }
    this.verifyVersionCorrespondence(manifests, versions)
    this.verifyContinuity(manifests, attested)
    this.verifyHeads(heads, this.latestLiveVersions(manifests, versions, attested), sessions)
  }

  private verifyManifestVersion(manifest: CommitMutationManifest, versions: readonly VersionRow[]): void {
    if (manifest.next === null) {
      if (manifest.previousRevision === null) integrity('delete manifest has no previous revision')
      return
    }
    const version = versions.find(
      (row) =>
        row.record_id === manifest.recordId &&
        row.record_revision === manifest.next?.recordRevision &&
        row.commit_id === manifest.commitId,
    )
    if (!version) integrity('mutation manifest has no version header')
    const schema = this.parseJson<unknown>(version.schema_json, 'record schema cannot be decoded')
    const owner = this.parseJson<RecordOwner>(version.owner_json, 'record owner cannot be decoded')
    const value = this.parseJson<unknown>(version.value_json, 'record body cannot be decoded')
    const known = knownSchema(manifest.next.schema.typeId)
    if (!known || !sameJson(known, manifest.next.schema) || !sameJson(schema, manifest.next.schema))
      integrity('record schema digest does not match the codec')
    if (version.commit_id !== manifest.commitId || version.digest !== manifest.next.digest)
      integrity('version header does not match the mutation manifest')
    if (bodyDigest(owner, value) !== version.digest) integrity('record body digest does not match')
  }

  private verifyContinuity(
    manifests: readonly CommitMutationManifest[],
    attested: Map<string, ParsedCommit>,
  ): void {
    const ordered = [...manifests].sort((left, right) => {
      const leftSeq = attested.get(left.commitId)?.seq ?? 0
      const rightSeq = attested.get(right.commitId)?.seq ?? 0
      return leftSeq - rightSeq || left.recordId.localeCompare(right.recordId)
    })
    const seen = new Map<string, number | null>()
    for (const manifest of ordered) {
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
  }

  private verifyVersionCorrespondence(
    manifests: readonly CommitMutationManifest[],
    versions: readonly VersionRow[],
  ): void {
    const claimed = new Set<string>()
    for (const manifest of manifests) {
      if (manifest.next === null) continue
      const key = this.versionKey(manifest.recordId, manifest.next.recordRevision, manifest.commitId)
      if (claimed.has(key)) integrity('record version is claimed by more than one manifest')
      claimed.add(key)
    }
    for (const version of versions) {
      const key = this.versionKey(version.record_id, version.record_revision, version.commit_id)
      if (!claimed.has(key)) integrity('record version has no mutation manifest')
    }
  }

  private versionKey(recordId: string, revision: number, commitId: string): string {
    return digestOf({ recordId, revision, commitId })
  }

  private latestLiveVersions(
    manifests: readonly CommitMutationManifest[],
    versions: readonly VersionRow[],
    attested: Map<string, ParsedCommit>,
  ): Map<string, VersionRow> {
    const ordered = [...manifests].sort((left, right) => {
      const leftSeq = attested.get(left.commitId)?.seq ?? 0
      const rightSeq = attested.get(right.commitId)?.seq ?? 0
      return leftSeq - rightSeq || left.recordId.localeCompare(right.recordId)
    })
    const latestManifest = new Map<string, CommitMutationManifest>()
    for (const manifest of ordered) latestManifest.set(manifest.recordId, manifest)
    const live = new Map<string, VersionRow>()
    for (const [recordId, manifest] of latestManifest) {
      if (manifest.next === null) continue
      const version = versions.find(
        (row) =>
          row.record_id === recordId &&
          row.record_revision === manifest.next?.recordRevision &&
          row.commit_id === manifest.commitId,
      )
      if (!version) integrity('latest record version is missing')
      live.set(recordId, version)
    }
    return live
  }

  private verifyHeads(
    heads: readonly HeadRow[],
    latest: ReadonlyMap<string, VersionRow>,
    sessions: Map<string, VerifiedSession>,
  ): void {
    const seen = new Set<string>()
    for (const head of heads) {
      if (seen.has(head.record_id)) integrity('duplicate record head')
      seen.add(head.record_id)
      const version = latest.get(head.record_id)
      if (!version) integrity('record head has no version')
      this.verifyHeadMatches(head, version)
    }
    for (const recordId of latest.keys()) {
      if (!seen.has(recordId)) integrity('latest record version has no head')
    }
    for (const [sessionId, session] of sessions) {
      const head = heads.find((row) => row.record_id === sessionIdentityRecordId(sessionId))
      if (!head) integrity('session identity record is missing')
      const value = this.parseJson<SessionIdentityValue>(
        head.value_json,
        'session identity cannot be decoded',
      )
      if (
        value.sessionId !== sessionId ||
        value.workspaceId !== session.workspaceId ||
        value.formatVersion !== session.formatVersion ||
        value.minReader !== session.minReader ||
        value.runtimeSchemaMajor !== RUNTIME_SCHEMA_MAJOR ||
        !sameJson(value.parent, session.parent) ||
        value.minReader !== head.min_reader
      )
        integrity('session identity does not match the session catalogue')
    }
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

  private verifyAdmissions(
    attested: Map<string, ParsedCommit>,
    sessions: Map<string, VerifiedSession>,
  ): void {
    const versions = this.all<VersionRow>(
      `SELECT record_id, record_revision, schema_json, commit_id, digest, owner_json, value_json
       FROM runtime_record_versions`,
    )
    for (const row of this.all<AdmissionRow>(
      'SELECT ticket_id, fingerprint, run_id, probe_json FROM runtime_admissions',
    )) {
      const rebuilt = this.rebuildProbe(row, attested, versions, sessions)
      const stored = this.parseJson<unknown>(row.probe_json, 'stored admission probe cannot be decoded')
      if (!sameJson(stored, rebuilt)) integrity('admission replay does not match the attested run')
    }
  }

  private rebuildProbe(
    row: AdmissionRow,
    attested: Map<string, ParsedCommit>,
    versions: readonly VersionRow[],
    sessions: Map<string, VerifiedSession>,
  ): AdmissionProbe {
    const found: { commit: ParsedCommit; value: RunRecordValue }[] = []
    for (const version of versions) {
      if (version.record_id !== runRecordId(row.run_id)) continue
      const commit = attested.get(version.commit_id)
      if (!commit || commit.data.runId !== row.run_id) continue
      const value = this.parseJson<RunRecordValue>(version.value_json, 'record body cannot be decoded')
      if (value.runId !== row.run_id || value.admissionTicketId !== row.ticket_id) continue
      if (!Number.isSafeInteger(value.revision)) integrity('attested run revision is not readable')
      found.push({ commit, value })
    }
    if (found.length !== 1) integrity('admission does not match one attested run')
    const match = found[0]
    if (!match) integrity('admission does not match one attested run')
    const session = sessions.get(match.value.sessionId)
    if (!session) integrity('admission session failed verification')
    const receipt: StateCommitReceipt = {
      commitId: match.commit.data.commitId,
      transactionFingerprint: match.commit.data.transactionFingerprint,
      sessionId: match.value.sessionId,
      firstSeq: match.commit.data.previousCommitId === null ? session.formatSeq : match.commit.seq,
      lastSeq: match.commit.seq,
      headDigest: match.commit.digest,
      runRevision: match.value.revision,
      actionIds: [],
    }
    return { state: 'created', runId: row.run_id, commit: receipt }
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
    this.run(
      'INSERT INTO runtime_request_results (method, request_id, fingerprint, result_json) VALUES (?, ?, ?, ?)',
      method,
      requestId,
      fingerprint,
      JSON.stringify(result),
    )
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
    this.run(
      `INSERT INTO runtime_records (
         record_id, schema_json, min_reader, record_revision, last_commit_id, created_at, updated_at,
         owner_json, value_json, body_digest
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.recordId,
      JSON.stringify(record.schema),
      record.minReader,
      record.recordRevision,
      commitId,
      at,
      at,
      JSON.stringify(record.owner),
      JSON.stringify(record.value),
      digest,
    )
    this.run(
      `INSERT INTO runtime_record_versions (
         record_id, record_revision, schema_json, commit_id, digest, owner_json, value_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      record.recordId,
      record.recordRevision,
      JSON.stringify(record.schema),
      commitId,
      digest,
      JSON.stringify(record.owner),
      JSON.stringify(record.value),
    )
    this.run(
      `INSERT INTO runtime_mutation_manifests (commit_id, record_id, previous_revision, next_json)
       VALUES (?, ?, ?, ?)`,
      manifest.commitId,
      manifest.recordId,
      manifest.previousRevision,
      JSON.stringify(manifest.next),
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

  private tx<T>(body: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = body()
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
}

export function openRuntimeStateDatabase(options: RuntimeStateDatabaseOptions): RuntimeStateDatabase {
  return new RuntimeStateDatabase(options)
}
