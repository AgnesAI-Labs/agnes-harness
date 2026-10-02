import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { defaultIds, openTracked } from '../../../../packages/core/src/index.ts'
import type {
  AdvanceRunRequest,
  CallContext,
  ClaimOutboxRequest,
  CloseInvocationRequest,
  CommitControlRequest,
  CommitGuard,
  DispatchAdmissionRequest,
  InvocationAdmission,
  Outcome,
  PreparedAction,
  ProbeActionResultRequest,
  QueryAdmission,
  Receipt,
  ReceiptIntakeRequest,
  RetentionRef,
  RunAdmission,
  StateAuthorityRef,
  UsageFact,
} from '../../../../packages/extension-api/src/runtime/index.ts'
import { createSqliteStorage } from '../../../../packages/host/src/adapters/storage-sqlite.ts'
import { resolvePin } from '../../../../packages/host/src/runtime/blob/retention.ts'
import { type BlobStore, openBlobStore } from '../../../../packages/host/src/runtime/blob/uploads.ts'
import { type BlobService, createBlobService } from '../../../../packages/host/src/runtime/providers/blob.ts'
import {
  createRuntimeStateStore,
  type RuntimeStateStore,
  UNIMPLEMENTED_STATE_METHODS,
} from '../../../../packages/host/src/runtime/providers/state.ts'
import { canonicalJson } from '../../../../packages/host/src/runtime/state/canonical-json.ts'
import {
  bodyDigest,
  type CommitMutationManifest,
  type CommitSideEntry,
  digestOf as canonicalDigest,
  emptyIntegrity,
  type LedgerEvent,
  mutationDigest,
  protectEvent,
  type RecordOwner,
  sideEntryIdentity,
  sideListsDigest,
} from '../../../../packages/host/src/runtime/state/records.ts'
import { jcs } from '../../../../packages/protocol/src/jcs.ts'
import { validateRuntime } from '../../../../packages/protocol/src/runtime/public.ts'

const authority: StateAuthorityRef = { authorityId: 'authority-1', tenantId: 'tenant-1', authorityEpoch: 1 }
const scope = { installationId: 'install-1', kind: 'installation' as const }
const admittedAt = '2026-04-01T00:00:00.000Z'

function digestOf(value: unknown): string {
  return createHash('sha256').update(jcs(value)).digest('hex')
}

function inline(value: unknown) {
  const canonical = jcs(value)
  const schemaDocument = { $id: 'agh.test/json@1', type: 'object' }
  return {
    kind: 'inline' as const,
    schema: { typeId: 'agh.test/json@1', revision: 1, digest: digestOf(schemaDocument) },
    value,
    digest: digestOf(value),
    bytes: Buffer.byteLength(canonical),
  }
}

function context(signal: AbortSignal = new AbortController().signal): CallContext {
  return {
    principalRef: 'principal-1',
    scope,
    bindingId: 'binding-1',
    invocationId: 'invocation-1',
    deadline: '2026-05-01T00:00:00.000Z',
    traceRef: 'trace-1',
    authorizationRef: 'auth-1',
    signal,
  }
}

function admission(overrides: Partial<RunAdmission> & { text?: string } = {}): RunAdmission {
  const text = overrides.text ?? 'hello'
  const ticketId = overrides.ticketId ?? 'ticket-1'
  const { text: _text, ...rest } = overrides
  return {
    ticketId,
    fingerprint: digestOf({ ticketId, text }),
    releaseSetId: 'release-1',
    bindingId: 'binding-1',
    packagePinReceipt: inline({ pin: 'package' }),
    runId: 'run-1',
    sessionId: 'session-1',
    lane: 'main',
    workspaceId: 'workspace-1',
    input: inline({ text }),
    admittedAt,
    deadline: '2026-05-01T00:00:00.000Z',
    conversation: null,
    ...rest,
  }
}

const files: string[] = []

function file(): string {
  const directory = mkdtempSync(join(tmpdir(), 'agnes-state-'))
  files.push(directory)
  return join(directory, 'state.sqlite')
}

type CommitNotice = { method: string; requestId: string; wrote: boolean }

// This acceptance fixture owns observations but never performs billing settlement.
// SQL membership proves exactly which measured fact is known to be still unsettled.
// It is a restricted test producer, not an installed production billing owner.
const usageSource = new DatabaseSync(':memory:')
usageSource.exec(
  'CREATE TABLE observed_usage (fact_json TEXT, receipt_json TEXT, evidence_json TEXT, settlement_ref TEXT, PRIMARY KEY(fact_json,receipt_json,evidence_json))',
)
afterAll(() => usageSource.close())
const retentionSources: BlobStore[] = []
const blobServices: BlobService[] = []
function verifyFixtureUsage(fact: UsageFact, receipt: Receipt, evidence: readonly unknown[]) {
  const row = usageSource
    .prepare(
      'SELECT settlement_ref FROM observed_usage WHERE fact_json=? AND receipt_json=? AND evidence_json=?',
    )
    .get(jcs(fact), jcs(receipt), jcs(evidence)) as { settlement_ref: string | null } | undefined
  return row ? { settlementRef: row.settlement_ref } : undefined
}
function verifyFixturePin(ref: RetentionRef): boolean {
  if (ref.kind !== 'blob' || ref.version !== '1') return false
  for (const source of retentionSources) {
    if (source.authorityId !== ref.authorityId) continue
    const row = source.db.prepare('SELECT blob FROM roots WHERE pin_id=?').get(ref.pinId) as
      | { blob: string }
      | undefined
    if (!row?.blob) continue
    const parsed = validateRuntime('BlobRef', JSON.parse(row.blob))
    if (!parsed.ok || parsed.value.blobId !== ref.resourceId || parsed.value.digest !== ref.digest)
      return false
    try {
      resolvePin(source, parsed.value)
      return true
    } catch {
      return false
    }
  }
  return false
}

function openStore(
  path: string,
  now = () => Date.parse(admittedAt),
  beforeCommit?: () => void,
  onCommit?: (commit: CommitNotice) => void,
): RuntimeStateStore {
  return createRuntimeStateStore({
    file: path,
    authority,
    now,
    verifyUsageSettlement: verifyFixtureUsage,
    verifyRetentionPin: verifyFixturePin,
    ...(beforeCommit ? { beforeCommit } : {}),
    ...(onCommit ? { onCommit } : {}),
  })
}

function query<T>(path: string, sql: string): T[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db.prepare(sql).all() as T[]
  } finally {
    db.close()
  }
}

function count(path: string, table: string): number {
  const row = query<{ n: number }>(path, `SELECT COUNT(*) AS n FROM ${table}`)[0]
  return row?.n ?? 0
}

function mutate(path: string, change: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path)
  try {
    change(db)
  } finally {
    db.close()
  }
}

function patchResult(
  db: DatabaseSync,
  method: string,
  requestId: string,
  change: (result: {
    claim: { writerId: string }
    snapshot: { throughSeq: number; headDigest: string; authority: { tenantId: string } }
  }) => void,
): void {
  const row = db
    .prepare('SELECT result_json FROM runtime_state_control_requests WHERE method = ? AND request_id = ?')
    .get(method, requestId) as { result_json: string }
  const result = JSON.parse(row.result_json) as {
    claim: { writerId: string }
    snapshot: { throughSeq: number; headDigest: string; authority: { tenantId: string } }
  }
  change(result)
  db.prepare(
    'UPDATE runtime_state_control_requests SET result_json = ? WHERE method = ? AND request_id = ?',
  ).run(JSON.stringify(result), method, requestId)
}

const writeOpen = (requestId: string, writerId = 'writer-a', ttlMs = 1_000) => ({
  requestId,
  authority,
  sessionId: 'session-1' as const,
  mode: 'write' as const,
  writerId,
  ttlMs,
})

const readOpen = (requestId: string) => ({
  requestId,
  authority,
  sessionId: 'session-1' as const,
  mode: 'read' as const,
  writerId: null,
  ttlMs: null,
})

function leaseRequest(
  path: string,
  requestId: string,
  operation: 'acquire' | 'renew' | 'release' | 'reclaim',
  writerId: string,
  expectedWriterEpoch: number,
  ttlMs = 1_000,
) {
  return {
    requestId,
    authority,
    sessionId: 'session-1',
    writerId,
    operation,
    expectedWriterEpoch,
    expectedLastSeq:
      query<{ seq: number }>(path, "SELECT MAX(seq) AS seq FROM events WHERE session_key = 'session-1'")[0]
        ?.seq ?? 0,
    ttlMs,
  }
}

async function refuseDamaged(path: string, requestId: string, detailCode = 'integrity'): Promise<void> {
  const reopened = openStore(path)
  const opened = await reopened.open(writeOpen(requestId), context())
  reopened.close()
  expect(opened.ok).toBe(false)
  if (opened.ok) expect(opened.value.snapshot).toBeUndefined()
  if (!opened.ok) expect(opened.error).toMatchObject({ code: 'incompatible', detailCode })
  expect(
    query<{ writer_id: string | null }>(
      path,
      'SELECT writer_id FROM runtime_leases WHERE writer_id IS NOT NULL',
    ),
  ).toEqual([])
}

afterEach(() => {
  usageSource.exec('DELETE FROM observed_usage')
  for (const service of blobServices.splice(0)) service.close()
  for (const source of retentionSources.splice(0)) source.db.close()
  for (const directory of files.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('runtime state records, proof rows, and ledger events', () => {
  it('does not create a session when open fails', async () => {
    const path = file()
    const store = openStore(path)
    const opened = await store.open(
      { requestId: 'open-1', authority, sessionId: 'missing', mode: 'read', writerId: null, ttlMs: null },
      context(),
    )
    store.close()
    expect(opened.ok).toBe(false)
    if (!opened.ok)
      expect(opened.error).toMatchObject({ code: 'invalid_input', detailCode: 'session_absent' })
    expect(count(path, 'sessions')).toBe(0)
    expect(count(path, 'events')).toBe(0)
    expect(count(path, 'runtime_session_meta')).toBe(0)
  })

  it('writes the format event, state-commit event, and proof rows in one database transaction', async () => {
    const path = file()
    const commits: CommitNotice[] = []
    const store = openStore(
      path,
      () => Date.parse(admittedAt),
      undefined,
      (notice) => commits.push(notice),
    )
    const created = await store.createRun(admission(), context())
    const durability = store.durability()
    expect(existsSync(`${path}-wal`)).toBe(true)
    store.close()
    expect(created.ok).toBe(true)
    if (!created.ok || created.value.state !== 'created') throw new Error('run was not created')
    expect(created.value.commit.firstSeq).toBe(1)
    expect(created.value.commit.lastSeq).toBe(2)
    expect(created.value.commit.runRevision).toBe(0)
    expect(created.value.commit.actionIds).toEqual([])
    expect(durability).toMatchObject({ journalMode: 'wal', synchronous: 1 })
    if (process.platform === 'darwin') expect(durability.checkpointFullfsync).toBe(1)
    expect(query(path, 'SELECT type FROM events ORDER BY seq')).toEqual([
      { type: 'runtime/format' },
      { type: 'runtime/state-commit' },
    ])
    const attested = query<{ data: string }>(
      path,
      "SELECT data FROM events WHERE type = 'runtime/state-commit'",
    )
    const data = JSON.parse(attested[0]?.data ?? '{}') as { commitId: string; mutationCount: number }
    expect(data.commitId).toBe(created.value.commit.commitId)
    expect(commits).toEqual([{ method: 'createRun', requestId: 'ticket-1', wrote: true }])
    expect(
      query(
        path,
        "SELECT (SELECT COUNT(*) FROM events WHERE type='runtime/state-commit') + (SELECT COUNT(*) FROM runtime_aux_commits) AS n",
      ),
    ).toEqual([{ n: 1 }])
    expect(data.mutationCount).toBe(4)
    expect(count(path, 'runtime_mutation_manifests')).toBe(4)
    expect(count(path, 'runtime_side_entries')).toBe(0)
    expect(count(path, 'runtime_record_versions')).toBe(4)
    expect(query(path, 'SELECT record_id FROM runtime_record_versions ORDER BY record_id')).toEqual([
      { record_id: 'run:run-1' },
      { record_id: 'session-identity:session-1' },
      { record_id: 'state-lease:session-1' },
      { record_id: 'taint:run-1' },
    ])
    expect(query(path, 'SELECT writer_id, writer_epoch, last_writer_epoch FROM runtime_leases')).toEqual([
      { writer_id: null, writer_epoch: null, last_writer_epoch: 0 },
    ])
    expect(query(path, 'SELECT DISTINCT commit_id FROM runtime_record_versions')).toEqual([
      { commit_id: created.value.commit.commitId },
    ])
  })

  it('rolls back proof rows and ledger events together when the commit is rejected', async () => {
    const path = file()
    const store = openStore(
      path,
      () => Date.parse(admittedAt),
      () => {
        throw new Error('stop before commit')
      },
    )
    const created = await store.createRun(admission(), context())
    store.close()
    expect(created.ok).toBe(false)
    if (!created.ok) expect(created.error).toMatchObject({ code: 'internal', detailCode: 'fault' })
    expect(count(path, 'events')).toBe(0)
    expect(count(path, 'runtime_mutation_manifests')).toBe(0)
    expect(count(path, 'runtime_records')).toBe(0)
    expect(count(path, 'runtime_session_meta')).toBe(0)
  })

  it('returns the original run when the same ticket and fingerprint are repeated', async () => {
    const path = file()
    const store = openStore(path)
    const request = admission()
    const first = await store.createRun(request, context())
    const second = await store.createRun(request, context())
    store.close()
    expect(first).toEqual(second)
    expect(count(path, 'events')).toBe(2)
  })

  it('rejects a different fingerprint and a different run for an existing ticket or run', async () => {
    const path = file()
    const store = openStore(path)
    const request = admission()
    expect((await store.createRun(request, context())).ok).toBe(true)
    const otherFingerprint = await store.createRun(
      { ...request, fingerprint: digestOf({ other: true }) },
      context(),
    )
    const otherTicket = await store.createRun(
      admission({ ticketId: 'ticket-2', fingerprint: digestOf({ ticketId: 'ticket-2', text: 'hello' }) }),
      context(),
    )
    const otherWorkspace = await store.createRun(
      admission({ ticketId: 'ticket-3', runId: 'run-2', workspaceId: 'workspace-2' }),
      context(),
    )
    store.close()
    expect(otherFingerprint.ok).toBe(false)
    if (!otherFingerprint.ok) expect(otherFingerprint.error.detailCode).toBe('idempotency_conflict')
    expect(otherTicket.ok).toBe(false)
    if (!otherTicket.ok) expect(otherTicket.error.detailCode).toBe('run_exists')
    expect(otherWorkspace.ok).toBe(false)
    if (!otherWorkspace.ok) expect(otherWorkspace.error.detailCode).toBe('session_workspace')
    expect(count(path, 'events')).toBe(2)
  })

  it('adds another run to the same session without rewriting the format declaration', async () => {
    const path = file()
    const store = openStore(path)
    expect((await store.createRun(admission(), context())).ok).toBe(true)
    const second = await store.createRun(admission({ ticketId: 'ticket-2', runId: 'run-2' }), context())
    store.close()
    expect(second.ok).toBe(true)
    if (!second.ok || second.value.state !== 'created') throw new Error('second run was not created')
    expect(second.value.commit.firstSeq).toBe(3)
    expect(second.value.commit.lastSeq).toBe(3)
    expect(query(path, "SELECT COUNT(*) AS n FROM events WHERE type = 'runtime/format'")).toEqual([{ n: 1 }])
    expect(query(path, "SELECT COUNT(*) AS n FROM events WHERE type = 'runtime/state-commit'")).toEqual([
      { n: 2 },
    ])
  })

  it('acquires, renews, releases, and reclaims a writer lease without granting one to a reader', async () => {
    const path = file()
    let now = Date.parse(admittedAt)
    const store = openStore(path, () => now)
    expect((await store.createRun(admission(), context())).ok).toBe(true)
    const read = await store.open(
      {
        requestId: 'open-read',
        authority,
        sessionId: 'session-1',
        mode: 'read',
        writerId: null,
        ttlMs: null,
      },
      context(),
    )
    const write = await store.open(
      {
        requestId: 'open-write',
        authority,
        sessionId: 'session-1',
        mode: 'write',
        writerId: 'writer-a',
        ttlMs: 1_000,
      },
      context(),
    )
    const readWhileHeld = await store.open(
      {
        requestId: 'open-held',
        authority,
        sessionId: 'session-1',
        mode: 'read',
        writerId: null,
        ttlMs: null,
      },
      context(),
    )
    const contested = await store.open(
      {
        requestId: 'open-again',
        authority,
        sessionId: 'session-1',
        mode: 'write',
        writerId: 'writer-a',
        ttlMs: 1_000,
      },
      context(),
    )
    const renewed = await store.lease(
      {
        requestId: 'lease-renew',
        authority,
        sessionId: 'session-1',
        writerId: 'writer-a',
        operation: 'renew',
        expectedWriterEpoch: 1,
        expectedLastSeq: 3,
        ttlMs: 5_000,
      },
      context(),
    )
    const released = await store.lease(
      {
        requestId: 'lease-release',
        authority,
        sessionId: 'session-1',
        writerId: 'writer-a',
        operation: 'release',
        expectedWriterEpoch: 1,
        expectedLastSeq: 4,
        ttlMs: 1_000,
      },
      context(),
    )
    const reclaimed = await store.lease(
      {
        requestId: 'lease-reclaim',
        authority,
        sessionId: 'session-1',
        writerId: 'writer-b',
        operation: 'reclaim',
        expectedWriterEpoch: 1,
        expectedLastSeq: 5,
        ttlMs: 1_000,
      },
      context(),
    )
    now += 1_001
    const stale = await store.lease(
      {
        requestId: 'lease-stale',
        authority,
        sessionId: 'session-1',
        writerId: 'writer-a',
        operation: 'renew',
        expectedWriterEpoch: 1,
        expectedLastSeq: 6,
        ttlMs: 1_000,
      },
      context(),
    )
    const taken = await store.lease(
      {
        requestId: 'lease-take',
        authority,
        sessionId: 'session-1',
        writerId: 'writer-a',
        operation: 'acquire',
        expectedWriterEpoch: 2,
        expectedLastSeq: 6,
        ttlMs: 1_000,
      },
      context(),
    )
    store.close()
    expect(read.ok).toBe(true)
    if (read.ok) {
      expect(read.value.claim).toBeNull()
      expect(read.value.formatVersion).toBe(2)
      expect(read.value.snapshot.throughSeq).toBe(2)
      expect(read.value.snapshot.headDigest).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(write.ok).toBe(true)
    if (write.ok)
      expect(write.value.claim).toMatchObject({ writerId: 'writer-a', writerEpoch: 1, scopeId: 'session-1' })
    expect(readWhileHeld.ok).toBe(true)
    if (readWhileHeld.ok) expect(readWhileHeld.value.claim).toBeNull()
    expect(contested.ok).toBe(false)
    if (!contested.ok) expect(contested.error.detailCode).toBe('writer_lease')
    expect(renewed.ok).toBe(true)
    if (renewed.ok) expect(renewed.value.claim?.writerEpoch).toBe(1)
    expect(released.ok).toBe(true)
    if (released.ok) expect(released.value).toEqual({ claim: null, lastWriterEpoch: 1 })
    expect(reclaimed.ok).toBe(true)
    if (reclaimed.ok) expect(reclaimed.value.claim).toMatchObject({ writerId: 'writer-b', writerEpoch: 2 })
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.error.detailCode).toBe('writer_lease')
    expect(taken.ok).toBe(true)
    if (taken.ok) expect(taken.value.claim?.writerEpoch).toBe(3)
  })

  it.each([
    [
      'deleted manifest',
      (db: DatabaseSync) =>
        db.prepare("DELETE FROM runtime_mutation_manifests WHERE record_id LIKE 'run:%'").run(),
    ],
    [
      'extra side entry',
      (db: DatabaseSync) => {
        const commit = db.prepare("SELECT data FROM events WHERE type = 'runtime/state-commit'").get() as {
          data: string
        }
        const commitId = (JSON.parse(commit.data) as { commitId: string }).commitId
        db.prepare(
          'INSERT INTO runtime_side_entries (commit_id, kind, identity, entry_json) VALUES (?, ?, ?, ?)',
        ).run(
          commitId,
          'action-created',
          '["action-created","action-1"]',
          JSON.stringify({ commitId, kind: 'action-created', actionId: 'action-1' }),
        )
      },
    ],
    [
      'changed attestation digest',
      (db: DatabaseSync) => {
        const row = db
          .prepare("SELECT integrity_digest FROM events WHERE type = 'runtime/state-commit'")
          .get() as {
          integrity_digest: string
        }
        const digest = row.integrity_digest
        const flipped = `${digest.startsWith('0') ? '1' : '0'}${digest.slice(1)}`
        db.prepare("UPDATE events SET integrity_digest = ? WHERE type = 'runtime/state-commit'").run(flipped)
      },
    ],
    [
      'changed attestation count',
      (db: DatabaseSync) => {
        const row = db.prepare("SELECT data FROM events WHERE type = 'runtime/state-commit'").get() as {
          data: string
        }
        const data = JSON.parse(row.data) as { mutationCount: number }
        data.mutationCount = 0
        db.prepare("UPDATE events SET data = ? WHERE type = 'runtime/state-commit'").run(JSON.stringify(data))
      },
    ],
    [
      'changed version digest',
      (db: DatabaseSync) => {
        const row = db
          .prepare("SELECT digest FROM runtime_record_versions WHERE record_id LIKE 'run:%'")
          .get() as {
          digest: string
        }
        db.prepare("UPDATE runtime_record_versions SET digest = ? WHERE record_id LIKE 'run:%'").run(
          `${row.digest.startsWith('0') ? '1' : '0'}${row.digest.slice(1)}`,
        )
      },
    ],
    [
      'deleted record body',
      (db: DatabaseSync) =>
        db.prepare("UPDATE runtime_record_versions SET value_json = '{}' WHERE record_id LIKE 'run:%'").run(),
    ],
    [
      'deleted state commit',
      (db: DatabaseSync) => db.prepare("DELETE FROM events WHERE type = 'runtime/state-commit'").run(),
    ],
  ])('open fails closed when a proof row is %s', async (_name, change) => {
    const path = file()
    const store = openStore(path)
    expect((await store.createRun(admission(), context())).ok).toBe(true)
    store.close()
    mutate(path, change)
    const reopened = openStore(path)
    const opened = await reopened.open(
      {
        requestId: 'open-damaged',
        authority,
        sessionId: 'session-1',
        mode: 'write',
        writerId: 'writer-a',
        ttlMs: 1_000,
      },
      context(),
    )
    reopened.close()
    expect(opened.ok).toBe(false)
    if (!opened.ok) expect(opened.error).toMatchObject({ code: 'incompatible', detailCode: 'integrity' })
    expect(
      query<{ writer_id: string | null }>(
        path,
        'SELECT writer_id FROM runtime_leases WHERE writer_id IS NOT NULL',
      ),
    ).toEqual([])
  })

  it('replays the written ledger through the session reader', async () => {
    const path = file()
    const store = openStore(path)
    const created = await store.createRun(admission(), context())
    store.close()
    expect(created.ok).toBe(true)
    const storage = createSqliteStorage({
      file: path,
      clock: () => Date.parse(admittedAt),
      tablesDir: join(dirname(path), 'tables'),
    })
    const opened = await openTracked({
      storage,
      key: 'session-1',
      writerRunId: 'session-reader',
      ttlMs: 1_000,
      ids: defaultIds(() => Date.parse(admittedAt)),
      clock: () => Date.parse(admittedAt),
      timers: { setTimeout: () => 0, clearTimeout: () => undefined },
    })
    const events = await opened.log.scan({ fromSeq: 1, toSeq: opened.log.lastSeq, limit: 10 })
    expect(opened.log.lastSeq).toBe(2)
    expect(opened.tracker.state.lastSeq).toBe(2)
    expect(events.map((event) => event.type)).toEqual(['runtime/format', 'runtime/state-commit'])
    await opened.log.close()
    await storage.close()
  })

  it('rejects a record version and head that no mutation manifest covers', async () => {
    const path = file()
    const store = openStore(path)
    expect((await store.createRun(admission(), context())).ok).toBe(true)
    store.close()
    mutate(path, (db) => {
      db.prepare(
        `INSERT INTO runtime_record_versions
         SELECT 'rogue-record', record_revision, schema_json, commit_id, digest, owner_json, value_json
         FROM runtime_record_versions WHERE record_id = 'run:run-1'`,
      ).run()
      db.prepare(
        `INSERT INTO runtime_records
         SELECT 'rogue-record', schema_json, min_reader, record_revision, last_commit_id,
                created_at, updated_at, owner_json, value_json, body_digest
         FROM runtime_records WHERE record_id = 'run:run-1'`,
      ).run()
    })
    await refuseDamaged(path, 'open-rogue-record')
  })

  it('rejects a record head that has no version', async () => {
    const path = file()
    const store = openStore(path)
    expect((await store.createRun(admission(), context())).ok).toBe(true)
    store.close()
    mutate(path, (db) => {
      db.prepare(
        `INSERT INTO runtime_records
         SELECT 'rogue-head', schema_json, min_reader, record_revision, last_commit_id,
                created_at, updated_at, owner_json, value_json, body_digest
         FROM runtime_records WHERE record_id = 'run:run-1'`,
      ).run()
    })
    await refuseDamaged(path, 'open-head-without-version')
  })

  it('rejects a latest record version whose head was removed', async () => {
    const path = file()
    const store = openStore(path)
    expect((await store.createRun(admission(), context())).ok).toBe(true)
    store.close()
    mutate(path, (db) => {
      db.prepare("DELETE FROM runtime_records WHERE record_id = 'run:run-1'").run()
    })
    await refuseDamaged(path, 'open-missing-head')
  })

  it('rejects a record head whose reader requirement was raised', async () => {
    const path = file()
    const store = openStore(path)
    expect((await store.createRun(admission(), context())).ok).toBe(true)
    store.close()
    mutate(path, (db) => {
      db.prepare("UPDATE runtime_records SET min_reader = 999 WHERE record_id = 'run:run-1'").run()
    })
    await refuseDamaged(path, 'open-reader', 'unknown_reader')
  })

  it('accepts an equivalent spelling of a stored record body', async () => {
    const path = file()
    const store = openStore(path)
    expect((await store.createRun(admission(), context())).ok).toBe(true)
    store.close()
    mutate(path, (db) => {
      const row = db
        .prepare("SELECT value_json FROM runtime_record_versions WHERE record_id = 'run:run-1'")
        .get() as {
        value_json: string
      }
      const value = JSON.parse(row.value_json) as Record<string, unknown>
      const reordered: Record<string, unknown> = {}
      for (const key of Object.keys(value).reverse()) reordered[key] = value[key]
      const text = JSON.stringify(reordered)
      db.prepare("UPDATE runtime_record_versions SET value_json = ? WHERE record_id = 'run:run-1'").run(text)
      db.prepare("UPDATE runtime_records SET value_json = ? WHERE record_id = 'run:run-1'").run(text)
    })
    const reopened = openStore(path)
    const opened = await reopened.open(readOpen('open-reordered-body'), context())
    reopened.close()
    expect(opened.ok).toBe(true)
  })

  it('rejects a record head whose schema no longer matches the attested version', async () => {
    const path = file()
    const store = openStore(path)
    expect((await store.createRun(admission(), context())).ok).toBe(true)
    store.close()
    mutate(path, (db) => {
      db.prepare("UPDATE runtime_records SET schema_json = ? WHERE record_id = 'run:run-1'").run(
        JSON.stringify({ typeId: 'unknown@1', revision: 1, digest: 'bad' }),
      )
    })
    await refuseDamaged(path, 'open-schema')
  })

  it('rejects a replay index whose stored result no longer matches the attested run', async () => {
    const path = file()
    const store = openStore(path)
    const request = admission()
    expect((await store.createRun(request, context())).ok).toBe(true)
    store.close()
    mutate(path, (db) => {
      db.prepare('UPDATE runtime_admissions SET probe_json = ?').run(
        JSON.stringify({ state: 'created', runId: 'rogue-run', commit: {} }),
      )
    })
    await refuseDamaged(path, 'open-probe')
    const retry = openStore(path)
    const replayed = await retry.createRun(request, context())
    retry.close()
    expect(replayed.ok).toBe(false)
    if (replayed.ok) expect(replayed.value).toBeUndefined()
    if (!replayed.ok) expect(replayed.error).toMatchObject({ code: 'incompatible', detailCode: 'integrity' })
    expect(count(path, 'events')).toBe(2)
    expect(
      query<{ record_id: string }>(
        path,
        "SELECT record_id FROM runtime_records WHERE record_id LIKE 'run:%'",
      ),
    ).toEqual([{ record_id: 'run:run-1' }])
    expect(
      query<{ writer_id: string | null }>(
        path,
        'SELECT writer_id FROM runtime_leases WHERE writer_id IS NOT NULL',
      ),
    ).toEqual([])
  })

  it('returns the original write-open result for the same request', async () => {
    const path = file()
    const store = openStore(path)
    expect((await store.createRun(admission(), context())).ok).toBe(true)
    const request = writeOpen('open-write')
    const first = await store.open(request, context())
    const afterFirst = count(path, 'events')
    expect(afterFirst).toBe(3)
    const second = await store.open(request, context())
    expect(count(path, 'events')).toBe(afterFirst)
    const changed = await store.open(writeOpen('open-write', 'writer-b'), context())
    store.close()
    expect(first.ok).toBe(true)
    expect(second).toEqual(first)
    expect(changed.ok).toBe(false)
    expect(count(path, 'events')).toBe(afterFirst)
    if (!changed.ok) expect(changed.error.detailCode).toBe('idempotency_conflict')
    expect(
      query(path, "SELECT COUNT(*) AS n FROM runtime_state_control_requests WHERE method='open'"),
    ).toEqual([{ n: 1 }])
    expect(query<{ n: number }>(path, 'SELECT COUNT(*) AS n FROM runtime_leases')).toEqual([{ n: 1 }])
  })

  it('returns the original lease for the same acquire request', async () => {
    const path = file()
    const store = openStore(path)
    expect((await store.createRun(admission(), context())).ok).toBe(true)
    const request = leaseRequest(path, 'lease-acquire', 'acquire', 'writer-a', 0)
    const first = await store.lease(request, context())
    const second = await store.lease(request, context())
    const changed = await store.lease(
      leaseRequest(path, 'lease-acquire', 'acquire', 'writer-b', 0),
      context(),
    )
    store.close()
    expect(first.ok).toBe(true)
    expect(second).toEqual(first)
    expect(changed.ok).toBe(false)
    if (!changed.ok) expect(changed.error.detailCode).toBe('idempotency_conflict')
    expect(query<{ writer_epoch: number }>(path, 'SELECT writer_epoch FROM runtime_leases')).toEqual([
      { writer_epoch: 1 },
    ])
  })

  it('returns the original lease deadline when the same renew request is repeated', async () => {
    const path = file()
    let now = Date.parse(admittedAt)
    const store = openStore(path, () => now)
    expect((await store.createRun(admission(), context())).ok).toBe(true)
    expect(
      (await store.lease(leaseRequest(path, 'lease-acquire', 'acquire', 'writer-a', 0), context())).ok,
    ).toBe(true)
    const request = leaseRequest(path, 'lease-renew', 'renew', 'writer-a', 1, 5_000)
    const first = await store.lease(request, context())
    now += 1
    const second = await store.lease(request, context())
    const changed = await store.lease(
      leaseRequest(path, 'lease-renew', 'renew', 'writer-a', 1, 9_000),
      context(),
    )
    store.close()
    expect(first.ok).toBe(true)
    if (first.ok) expect(first.value.claim?.leaseUntil).toBe('2026-04-01T00:00:05.000Z')
    expect(second).toEqual(first)
    expect(changed.ok).toBe(false)
    if (!changed.ok) expect(changed.error.detailCode).toBe('idempotency_conflict')
  })

  it('verifies one session when a sibling session ledger is damaged', async () => {
    const path = file()
    const store = openStore(path)
    expect((await store.createRun(admission(), context())).ok).toBe(true)
    expect(
      (
        await store.createRun(
          admission({ sessionId: 'session-2', runId: 'run-2', ticketId: 'ticket-2', text: 'other' }),
          context(),
        )
      ).ok,
    ).toBe(true)
    store.close()
    mutate(path, (db) => {
      const row = db
        .prepare(
          "SELECT integrity_digest FROM events WHERE session_key = 'session-2' AND type = 'runtime/state-commit'",
        )
        .get() as { integrity_digest: string }
      const flipped = `${row.integrity_digest.startsWith('0') ? '1' : '0'}${row.integrity_digest.slice(1)}`
      db.prepare(
        "UPDATE events SET integrity_digest = ? WHERE session_key = 'session-2' AND type = 'runtime/state-commit'",
      ).run(flipped)
    })
    const reopened = openStore(path)
    const continued = await reopened.createRun(
      admission({ ticketId: 'ticket-3', runId: 'run-3', text: 'more' }),
      context(),
    )
    const damaged = await reopened.open(
      {
        requestId: 'open-sibling',
        authority,
        sessionId: 'session-2',
        mode: 'write',
        writerId: 'writer-b',
        ttlMs: 1_000,
      },
      context(),
    )
    reopened.close()
    expect(continued.ok).toBe(true)
    if (continued.ok) {
      expect(continued.value.state).toBe('created')
      if (continued.value.state === 'created') expect(continued.value.commit.lastSeq).toBe(3)
    }
    expect(damaged.ok).toBe(false)
    if (!damaged.ok) expect(damaged.error).toMatchObject({ code: 'incompatible', detailCode: 'integrity' })
    expect(
      query<{ writer_id: string | null }>(
        path,
        "SELECT writer_id FROM runtime_leases WHERE scope_id = 'session-2' AND writer_id IS NOT NULL",
      ),
    ).toEqual([])
  })

  it('continues after another connection appends a valid commit', async () => {
    const path = file()
    const local = openStore(path)
    expect((await local.createRun(admission(), context())).ok).toBe(true)
    const remote = openStore(path)
    const appended = await remote.createRun(
      admission({ ticketId: 'ticket-2', runId: 'run-2', text: 'remote' }),
      context(),
    )
    remote.close()
    const continued = await local.createRun(
      admission({ ticketId: 'ticket-3', runId: 'run-3', text: 'local' }),
      context(),
    )
    local.close()
    expect(appended.ok).toBe(true)
    expect(continued.ok).toBe(true)
    if (continued.ok && continued.value.state === 'created') {
      expect(continued.value.commit.firstSeq).toBe(4)
      expect(continued.value.commit.lastSeq).toBe(4)
    }
    expect(
      query<{ n: number }>(path, "SELECT COUNT(*) AS n FROM events WHERE type = 'runtime/state-commit'"),
    ).toEqual([{ n: 3 }])
  })

  it.each([
    [
      'sequence',
      (db: DatabaseSync) => {
        db.prepare('UPDATE events SET seq = 99 WHERE session_key = ? AND seq = 2').run('session-1')
      },
    ],
    [
      'digest',
      (db: DatabaseSync) => {
        const row = db
          .prepare('SELECT integrity_digest FROM events WHERE session_key = ? AND seq = 2')
          .get('session-1') as {
          integrity_digest: string
        }
        const flipped = `${row.integrity_digest.startsWith('0') ? '1' : '0'}${row.integrity_digest.slice(1)}`
        db.prepare('UPDATE events SET integrity_digest = ? WHERE session_key = ? AND seq = 2').run(
          flipped,
          'session-1',
        )
      },
    ],
    [
      'latest commit',
      (db: DatabaseSync) => {
        db.prepare(
          "UPDATE runtime_session_meta SET latest_commit_id = 'missing-commit' WHERE session_id = ?",
        ).run('session-1')
      },
    ],
  ])('refuses the next write when the verified %s changes', async (_name, change) => {
    const path = file()
    const store = openStore(path)
    expect((await store.createRun(admission(), context())).ok).toBe(true)
    mutate(path, change)
    const opened = await store.open(writeOpen('open-tail'), context())
    const created = await store.createRun(
      admission({ ticketId: 'ticket-2', runId: 'run-2', text: 'after' }),
      context(),
    )
    store.close()
    expect(opened.ok).toBe(false)
    if (!opened.ok) expect(opened.error).toMatchObject({ code: 'incompatible', detailCode: 'integrity' })
    expect(created.ok).toBe(false)
    if (!created.ok) expect(created.error).toMatchObject({ code: 'incompatible', detailCode: 'integrity' })
    expect(
      query<{ writer_id: string | null }>(
        path,
        'SELECT writer_id FROM runtime_leases WHERE writer_id IS NOT NULL',
      ),
    ).toEqual([])
    expect(count(path, 'events')).toBe(2)
  })

  it('does not advance past a rolled-back write', async () => {
    const path = file()
    let fail = false
    const store = openStore(
      path,
      () => Date.parse(admittedAt),
      () => {
        if (fail) throw new Error('stop before commit')
      },
    )
    expect((await store.createRun(admission(), context())).ok).toBe(true)
    fail = true
    const rolled = await store.createRun(
      admission({ ticketId: 'ticket-2', runId: 'run-2', text: 'rollback' }),
      context(),
    )
    fail = false
    const next = await store.createRun(
      admission({ ticketId: 'ticket-3', runId: 'run-3', text: 'after' }),
      context(),
    )
    store.close()
    expect(rolled.ok).toBe(false)
    if (!rolled.ok) expect(rolled.error).toMatchObject({ code: 'internal', detailCode: 'fault' })
    expect(next.ok).toBe(true)
    if (next.ok && next.value.state === 'created') {
      expect(next.value.commit.firstSeq).toBe(3)
      expect(next.value.commit.lastSeq).toBe(3)
    }
    expect(
      query<{ n: number }>(path, "SELECT COUNT(*) AS n FROM events WHERE type = 'runtime/state-commit'"),
    ).toEqual([{ n: 2 }])
  })

  it('refuses the next write and open for an uncovered record head', async () => {
    const path = file()
    const store = openStore(path)
    expect((await store.createRun(admission(), context())).ok).toBe(true)
    mutate(path, (db) => {
      db.prepare(
        `INSERT INTO runtime_record_versions
         SELECT 'rogue-record', record_revision, schema_json, commit_id, digest, owner_json, value_json
         FROM runtime_record_versions WHERE record_id = 'run:run-1'`,
      ).run()
      db.prepare(
        `INSERT INTO runtime_records
         SELECT 'rogue-record', schema_json, min_reader, record_revision, last_commit_id,
                created_at, updated_at, owner_json, value_json, body_digest
         FROM runtime_records WHERE record_id = 'run:run-1'`,
      ).run()
    })
    const continued = await store.createRun(
      admission({ ticketId: 'ticket-2', runId: 'run-2', text: 'next' }),
      context(),
    )
    const opened = await store.open(writeOpen('open-rogue-live'), context())
    store.close()
    expect(continued.ok).toBe(false)
    if (!continued.ok)
      expect(continued.error).toMatchObject({ code: 'incompatible', detailCode: 'integrity' })
    expect(opened.ok).toBe(false)
    if (!opened.ok) expect(opened.error).toMatchObject({ code: 'incompatible', detailCode: 'integrity' })
    expect(
      query<{ writer_id: string | null }>(
        path,
        'SELECT writer_id FROM runtime_leases WHERE writer_id IS NOT NULL',
      ),
    ).toEqual([])
  })

  it('refuses the next write and open for an unsupported record reader', async () => {
    const path = file()
    const store = openStore(path)
    expect((await store.createRun(admission(), context())).ok).toBe(true)
    mutate(path, (db) => {
      db.prepare("UPDATE runtime_records SET min_reader = 999 WHERE record_id = 'run:run-1'").run()
    })
    const continued = await store.createRun(
      admission({ ticketId: 'ticket-2', runId: 'run-2', text: 'next' }),
      context(),
    )
    const opened = await store.open(writeOpen('open-reader-live'), context())
    store.close()
    expect(continued.ok).toBe(false)
    if (!continued.ok)
      expect(continued.error).toMatchObject({ code: 'incompatible', detailCode: 'unknown_reader' })
    expect(opened.ok).toBe(false)
    if (!opened.ok) expect(opened.error).toMatchObject({ code: 'incompatible', detailCode: 'unknown_reader' })
    expect(
      query<{ writer_id: string | null }>(
        path,
        'SELECT writer_id FROM runtime_leases WHERE writer_id IS NOT NULL',
      ),
    ).toEqual([])
  })

  it.each([
    [
      'run id',
      (probe: { runId: string; commit: { lastSeq: number } }) => {
        probe.runId = 'rogue-run'
      },
    ],
    [
      'commit sequence',
      (probe: { runId: string; commit: { lastSeq: number } }) => {
        probe.commit.lastSeq = 99
      },
    ],
  ])('rejects a reopened admission whose %s no longer matches the attested run', async (_name, change) => {
    const path = file()
    const store = openStore(path)
    const request = admission()
    expect((await store.createRun(request, context())).ok).toBe(true)
    store.close()
    mutate(path, (db) => {
      const row = db.prepare('SELECT probe_json FROM runtime_admissions').get() as { probe_json: string }
      const probe = JSON.parse(row.probe_json) as { runId: string; commit: { lastSeq: number } }
      change(probe)
      db.prepare('UPDATE runtime_admissions SET probe_json = ?').run(JSON.stringify(probe))
    })
    const reopened = openStore(path)
    const replayed = await reopened.createRun(request, context())
    reopened.close()
    expect(replayed.ok).toBe(false)
    if (!replayed.ok) expect(replayed.error).toMatchObject({ code: 'incompatible', detailCode: 'integrity' })
    expect(count(path, 'events')).toBe(2)
    expect(
      query<{ writer_id: string | null }>(
        path,
        'SELECT writer_id FROM runtime_leases WHERE writer_id IS NOT NULL',
      ),
    ).toEqual([])
  })

  it('rejects a repeated admission when its stored run id changes', async () => {
    const path = file()
    const store = openStore(path)
    const request = admission()
    expect((await store.createRun(request, context())).ok).toBe(true)
    mutate(path, (db) => {
      const row = db.prepare('SELECT probe_json FROM runtime_admissions').get() as { probe_json: string }
      const probe = JSON.parse(row.probe_json) as { runId: string }
      probe.runId = 'rogue-run'
      db.prepare('UPDATE runtime_admissions SET probe_json = ?').run(JSON.stringify(probe))
    })
    const replayed = await store.createRun(request, context())
    store.close()
    expect(replayed.ok).toBe(false)
    if (!replayed.ok) expect(replayed.error).toMatchObject({ code: 'incompatible', detailCode: 'integrity' })
    expect(count(path, 'events')).toBe(2)
  })

  it('rejects a replayed write-open whose stored writer epoch was changed', async () => {
    const path = file()
    const store = openStore(path)
    expect((await store.createRun(admission(), context())).ok).toBe(true)
    const request = writeOpen('open-write')
    const first = await store.open(request, context())
    mutate(path, (db) => {
      const row = db
        .prepare(
          "SELECT result_json FROM runtime_state_control_requests WHERE method = 'open' AND request_id = 'open-write'",
        )
        .get() as { result_json: string }
      const result = JSON.parse(row.result_json) as { claim: { writerEpoch: number } }
      result.claim.writerEpoch = 42
      db.prepare(
        "UPDATE runtime_state_control_requests SET result_json = ? WHERE method = 'open' AND request_id = 'open-write'",
      ).run(JSON.stringify(result))
    })
    const replayed = await store.open(request, context())
    store.close()
    expect(first.ok).toBe(true)
    if (first.ok) expect(first.value.claim?.writerEpoch).toBe(1)
    expect(replayed.ok).toBe(false)
    if (!replayed.ok) expect(replayed.error).toMatchObject({ code: 'incompatible', detailCode: 'integrity' })
    expect(query<{ writer_epoch: number }>(path, 'SELECT writer_epoch FROM runtime_leases')).toEqual([
      { writer_epoch: 1 },
    ])
  })

  it('replays an acquire after the ledger advances', async () => {
    const path = file()
    const store = openStore(path)
    expect((await store.createRun(admission(), context())).ok).toBe(true)
    const request = leaseRequest(path, 'lease-acquire', 'acquire', 'writer-a', 0)
    const first = await store.lease(request, context())
    expect(
      (await store.createRun(admission({ ticketId: 'ticket-2', runId: 'run-2', text: 'next' }), context()))
        .ok,
    ).toBe(true)
    const replayed = await store.lease(request, context())
    store.close()
    expect(first.ok).toBe(true)
    expect(replayed).toEqual(first)
    expect(query<{ writer_epoch: number }>(path, 'SELECT writer_epoch FROM runtime_leases')).toEqual([
      { writer_epoch: 1 },
    ])
  })

  it('replays a renew after the ledger advances', async () => {
    const path = file()
    const store = openStore(path)
    expect((await store.createRun(admission(), context())).ok).toBe(true)
    expect(
      (await store.lease(leaseRequest(path, 'lease-acquire', 'acquire', 'writer-a', 0), context())).ok,
    ).toBe(true)
    const request = leaseRequest(path, 'lease-renew', 'renew', 'writer-a', 1, 5_000)
    const first = await store.lease(request, context())
    expect(
      (await store.createRun(admission({ ticketId: 'ticket-2', runId: 'run-2', text: 'next' }), context()))
        .ok,
    ).toBe(true)
    const replayed = await store.lease(request, context())
    store.close()
    expect(first.ok).toBe(true)
    expect(replayed).toEqual(first)
    expect(
      query<{ writer_epoch: number; writer_id: string }>(
        path,
        'SELECT writer_epoch, writer_id FROM runtime_leases',
      ),
    ).toEqual([{ writer_epoch: 1, writer_id: 'writer-a' }])
  })

  it('rejects a replayed write-open whose stored writer id was changed', async () => {
    const path = file()
    const store = openStore(path)
    expect((await store.createRun(admission(), context())).ok).toBe(true)
    const request = writeOpen('open-write')
    const first = await store.open(request, context())
    mutate(path, (db) => {
      patchResult(db, 'open', 'open-write', (result) => {
        result.claim.writerId = 'rogue-writer'
      })
    })
    const replayed = await store.open(request, context())
    store.close()
    expect(first.ok).toBe(true)
    expect(replayed.ok).toBe(false)
    if (!replayed.ok) expect(replayed.error).toMatchObject({ code: 'incompatible', detailCode: 'integrity' })
    expect(
      query<{ writer_id: string; writer_epoch: number }>(
        path,
        'SELECT writer_id, writer_epoch FROM runtime_leases',
      ),
    ).toEqual([{ writer_id: 'writer-a', writer_epoch: 1 }])
  })

  it('rejects a replayed lease whose stored writer id was changed', async () => {
    const path = file()
    const store = openStore(path)
    expect((await store.createRun(admission(), context())).ok).toBe(true)
    const request = leaseRequest(path, 'lease-acquire', 'acquire', 'writer-a', 0)
    const first = await store.lease(request, context())
    mutate(path, (db) => {
      patchResult(db, 'lease', 'lease-acquire', (result) => {
        result.claim.writerId = 'rogue-writer'
      })
    })
    const replayed = await store.lease(request, context())
    store.close()
    expect(first.ok).toBe(true)
    expect(replayed.ok).toBe(false)
    if (!replayed.ok) expect(replayed.error).toMatchObject({ code: 'incompatible', detailCode: 'integrity' })
    expect(
      query<{ writer_id: string; writer_epoch: number }>(
        path,
        'SELECT writer_id, writer_epoch FROM runtime_leases',
      ),
    ).toEqual([{ writer_id: 'writer-a', writer_epoch: 1 }])
  })

  it('rejects an old writer receipt after the lease is taken over', async () => {
    const path = file()
    const store = openStore(path)
    expect((await store.createRun(admission(), context())).ok).toBe(true)
    const request = writeOpen('open-write')
    expect((await store.open(request, context())).ok).toBe(true)
    expect(
      (await store.lease(leaseRequest(path, 'lease-release', 'release', 'writer-a', 1), context())).ok,
    ).toBe(true)
    expect(
      (await store.lease(leaseRequest(path, 'lease-reclaim', 'reclaim', 'writer-b', 1), context())).ok,
    ).toBe(true)
    store.close()
    mutate(path, (db) => {
      patchResult(db, 'open', 'open-write', (result) => {
        result.claim.writerId = 'rogue-writer'
      })
    })
    const reopened = openStore(path)
    const replayed = await reopened.open(request, context())
    reopened.close()
    expect(replayed.ok).toBe(false)
    if (!replayed.ok) expect(replayed.error).toMatchObject({ code: 'incompatible', detailCode: 'integrity' })
    expect(
      query<{ writer_id: string; writer_epoch: number }>(
        path,
        'SELECT writer_id, writer_epoch FROM runtime_leases',
      ),
    ).toEqual([{ writer_id: 'writer-b', writer_epoch: 2 }])
  })

  it('replays an untampered historical open without replacing the current writer', async () => {
    const path = file()
    const store = openStore(path)
    expect((await store.createRun(admission(), context())).ok).toBe(true)
    const request = writeOpen('open-write')
    const first = await store.open(request, context())
    expect(
      (await store.lease(leaseRequest(path, 'lease-release', 'release', 'writer-a', 1), context())).ok,
    ).toBe(true)
    expect(
      (await store.lease(leaseRequest(path, 'lease-reclaim', 'reclaim', 'writer-b', 1), context())).ok,
    ).toBe(true)
    const replayed = await store.open(request, context())
    store.close()
    expect(first.ok).toBe(true)
    expect(replayed).toEqual(first)
    if (replayed.ok) expect(replayed.value.claim?.writerEpoch).toBe(1)
    expect(
      query<{ writer_id: string; writer_epoch: number }>(
        path,
        'SELECT writer_id, writer_epoch FROM runtime_leases',
      ),
    ).toEqual([{ writer_id: 'writer-b', writer_epoch: 2 }])
  })

  it('rejects a replayed open whose prefix digest was forged', async () => {
    const path = file()
    const store = openStore(path)
    expect((await store.createRun(admission(), context())).ok).toBe(true)
    const request = writeOpen('open-write')
    const first = await store.open(request, context())
    store.close()
    mutate(path, (db) => {
      patchResult(db, 'open', 'open-write', (result) => {
        result.snapshot.throughSeq = 1
        result.snapshot.headDigest = 'f'.repeat(64)
      })
    })
    const reopened = openStore(path)
    const replayed = await reopened.open(request, context())
    reopened.close()
    expect(first.ok).toBe(true)
    if (first.ok) expect(first.value.snapshot.throughSeq).toBe(3)
    expect(replayed.ok).toBe(false)
    if (!replayed.ok) expect(replayed.error).toMatchObject({ code: 'incompatible', detailCode: 'integrity' })
    expect(
      query<{ writer_id: string; writer_epoch: number }>(
        path,
        'SELECT writer_id, writer_epoch FROM runtime_leases',
      ),
    ).toEqual([{ writer_id: 'writer-a', writer_epoch: 1 }])
  })

  it('rejects a replayed open whose snapshot tenant was forged', async () => {
    const path = file()
    const store = openStore(path)
    expect((await store.createRun(admission(), context())).ok).toBe(true)
    const request = writeOpen('open-write')
    expect((await store.open(request, context())).ok).toBe(true)
    store.close()
    mutate(path, (db) => {
      patchResult(db, 'open', 'open-write', (result) => {
        result.snapshot.authority.tenantId = 'rogue-tenant'
      })
    })
    const reopened = openStore(path)
    const replayed = await reopened.open(request, context())
    reopened.close()
    expect(replayed.ok).toBe(false)
    if (!replayed.ok) expect(replayed.error).toMatchObject({ code: 'incompatible', detailCode: 'integrity' })
    if (!replayed.ok)
      expect(replayed.error.message).toBe('control result index does not match its immutable proof')
    expect(
      query<{ writer_id: string; writer_epoch: number }>(
        path,
        'SELECT writer_id, writer_epoch FROM runtime_leases',
      ),
    ).toEqual([{ writer_id: 'writer-a', writer_epoch: 1 }])
  })

  it('rejects a stored open result that no longer matches its schema', async () => {
    const path = file()
    const store = openStore(path)
    expect((await store.createRun(admission(), context())).ok).toBe(true)
    const request = writeOpen('open-write')
    expect((await store.open(request, context())).ok).toBe(true)
    mutate(path, (db) => {
      db.prepare(
        "UPDATE runtime_state_control_requests SET result_json = ? WHERE method = 'open' AND request_id = 'open-write'",
      ).run('{}')
    })
    const replayed = await store.open(request, context())
    store.close()
    expect(replayed.ok).toBe(false)
    if (!replayed.ok) expect(replayed.error).toMatchObject({ code: 'incompatible', detailCode: 'integrity' })
    expect(query<{ writer_epoch: number }>(path, 'SELECT writer_epoch FROM runtime_leases')).toEqual([
      { writer_epoch: 1 },
    ])
  })

  it('replays an expired historical open without renewing its writer lease', async () => {
    const path = file()
    let now = Date.parse(admittedAt)
    const store = openStore(path, () => now)
    expect((await store.createRun(admission(), context())).ok).toBe(true)
    const request = writeOpen('open-write')
    const first = await store.open(request, context())
    now += 1_001
    const replayed = await store.open(request, context())
    store.close()
    expect(first.ok).toBe(true)
    expect(replayed).toEqual(first)
    if (replayed.ok) {
      if (!replayed.value.claim) throw new Error('original writer claim is absent')
      expect(Date.parse(replayed.value.claim.leaseUntil)).toBeLessThan(now)
    }
    expect(
      query<{ writer_id: string; writer_epoch: number }>(
        path,
        'SELECT writer_id, writer_epoch FROM runtime_leases',
      ),
    ).toEqual([{ writer_id: 'writer-a', writer_epoch: 1 }])
  })

  it('queues two independent createRun calls on one connection', async () => {
    const path = file()
    const store = openStore(path)
    const [first, second] = await Promise.all([
      store.createRun(admission({ ticketId: 'ticket-a', runId: 'run-a', text: 'a' }), context()),
      store.createRun(
        admission({ ticketId: 'ticket-b', runId: 'run-b', text: 'b', sessionId: 'session-2' }),
        context(),
      ),
    ])
    store.close()
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (first.ok && first.value.state === 'created') expect(first.value.runId).toBe('run-a')
    if (second.ok && second.value.state === 'created') expect(second.value.runId).toBe('run-b')
    expect(count(path, 'sessions')).toBe(2)
    expect(count(path, 'events')).toBe(4)
  })

  it('does not let a queued failure poison the next transaction', async () => {
    const path = file()
    let trip = true
    const store = openStore(
      path,
      () => Date.parse(admittedAt),
      () => {
        if (!trip) return
        trip = false
        throw new Error('injected storage fault')
      },
    )
    const [failed, created] = await Promise.all([
      store.createRun(admission({ ticketId: 'ticket-a', runId: 'run-a', text: 'a' }), context()),
      store.createRun(
        admission({ ticketId: 'ticket-b', runId: 'run-b', text: 'b', sessionId: 'session-2' }),
        context(),
      ),
    ])
    const opened = await store.open(
      {
        requestId: 'open-session-2',
        authority,
        sessionId: 'session-2',
        mode: 'read',
        writerId: null,
        ttlMs: null,
      },
      context(),
    )
    store.close()
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.error).toMatchObject({ code: 'internal', detailCode: 'fault' })
    expect(created.ok).toBe(true)
    expect(opened.ok).toBe(true)
    expect(
      query<{ session_key: string }>(path, 'SELECT session_key FROM sessions ORDER BY session_key'),
    ).toEqual([{ session_key: 'session-2' }])
  })

  it('does not let a queued refusal poison the next transaction', async () => {
    const path = file()
    const store = openStore(path)
    const [missing, created] = await Promise.all([
      store.open(writeOpen('open-missing'), context()),
      store.createRun(admission(), context()),
    ])
    store.close()
    expect(missing.ok).toBe(false)
    if (!missing.ok)
      expect(missing.error).toMatchObject({ code: 'invalid_input', detailCode: 'session_absent' })
    expect(created.ok).toBe(true)
    expect(count(path, 'sessions')).toBe(1)
    expect(count(path, 'events')).toBe(2)
  })

  it('does not deduplicate a read open, which takes no writer lease', async () => {
    const path = file()
    const store = openStore(path)
    expect((await store.createRun(admission(), context())).ok).toBe(true)
    const request = readOpen('open-read')
    const first = await store.open(request, context())
    const second = await store.open(request, context())
    store.close()
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (first.ok && second.ok) {
      expect(first.value.claim).toBeNull()
      expect(second.value.claim).toBeNull()
      expect(second.value.snapshot.snapshotId).not.toBe(first.value.snapshot.snapshotId)
    }
    expect(
      query<{ writer_id: string | null }>(
        path,
        'SELECT writer_id FROM runtime_leases WHERE writer_id IS NOT NULL',
      ),
    ).toEqual([])
  })

  it('refuses every state method that is not implemented yet', async () => {
    const path = file()
    const store = openStore(path)
    const controller = new AbortController()
    controller.abort()
    const cancelled = await store.open(
      {
        requestId: 'open-cancelled',
        authority,
        sessionId: 'missing',
        mode: 'read',
        writerId: null,
        ttlMs: null,
      },
      context(controller.signal),
    )
    expect(cancelled.ok).toBe(false)
    if (!cancelled.ok) expect(cancelled.error.code).toBe('cancelled')
    for (const method of UNIMPLEMENTED_STATE_METHODS) {
      const result =
        method === 'cancelAdmission'
          ? await store.cancelAdmission('ticket-unused', 'a'.repeat(64), context())
          : await (store[method] as (request: never, callContext: CallContext) => Promise<Outcome<unknown>>)(
              {} as never,
              context(),
            )
      expect(result.ok, method).toBe(false)
      if (!result.ok) {
        expect(result.error.code, method).toBe('internal')
        expect(result.error.detailCode, method).toBe('not implemented')
        expect(result.error.message, method).toBe(`${method} is not implemented`)
        expect(result.error.retryAdvice).toEqual({ kind: 'never' })
      }
    }
    store.close()
  })
})

const toolBinding = {
  bindingId: 'binding-1',
  contract: 'agh.test/tool',
  logicalName: 'tool',
  providerId: 'provider-1',
}
const runBinding = {
  bindingId: 'binding-1',
  contract: 'agh.runtime/run-admission',
  logicalName: 'run',
  providerId: 'runtime-state',
}
const future = '2026-05-01T00:00:00.000Z'
const past = '2026-03-01T00:00:00.000Z'

function stableId(prefix: string, material: string): string {
  return `${prefix}-${createHash('sha256').update(material).digest('hex').slice(0, 40)}`
}

function unwrap<T>(result: Outcome<T>, label: string): T {
  if (!result.ok)
    throw new Error(`${label}: ${result.error.code}/${result.error.detailCode} ${result.error.message}`)
  return result.value
}

function expectSchema<K extends Parameters<typeof validateRuntime>[0]>(kind: K, value: unknown): void {
  const result = validateRuntime(kind, value)
  if (!result.ok) throw new Error(`${kind}: ${JSON.stringify(result.errors)}`)
}

function storedOutbox(path: string): Record<string, unknown> {
  const rows = query<{ value_json: string }>(
    path,
    "SELECT value_json FROM runtime_records WHERE record_id LIKE 'outbox:%' ORDER BY record_id",
  )
  if (!rows[0]) throw new Error('missing outbox record')
  return JSON.parse(rows[0].value_json) as Record<string, unknown>
}

function publicOutbox(value: Record<string, unknown>): Record<string, unknown> {
  const { sessionId: _sessionId, sourceReceiptId: _sourceReceiptId, ...record } = value
  return record
}

function recordValue<T>(path: string, recordId: string): T {
  const rows = query<{ value_json: string }>(
    path,
    `SELECT value_json FROM runtime_records WHERE record_id = '${recordId}'`,
  )
  if (!rows[0]) throw new Error(`missing record ${recordId}`)
  return JSON.parse(rows[0].value_json) as T
}

function actionState(path: string, key: string): string {
  return recordValue<{ state: string }>(path, `action:${stableId('act', `run-1\0${key}`)}`).state
}

function quotaFingerprints(path: string): string[] {
  return query<{ value_json: string }>(
    path,
    "SELECT value_json FROM runtime_records WHERE record_id LIKE 'quota:%' ORDER BY record_id",
  ).map((row) => (JSON.parse(row.value_json) as { requestFingerprint: string }).requestFingerprint)
}

function continuation(step = 1) {
  return {
    namespace: 'agh.test/loop',
    codecVersion: '1',
    data: inline({ step }),
    provenance: { sourceRefs: [] as string[], producer: toolBinding, trustLabels: [] as string[] },
    createdAt: admittedAt,
    references: [],
  }
}

function preparedAction(key: string): PreparedAction {
  const input = inline({ text: key })
  const body = {
    key,
    target: toolBinding,
    method: 'run',
    input,
    dependencies: [],
    retry: { mode: 'never' as const, maxAttempts: 0, backoffMs: [] as number[] },
    obligation: 'mandatory' as const,
    deadline: future,
    resultSchema: input.schema,
    references: [],
  }
  return { ...body, intentFingerprint: canonicalDigest(body) }
}

function commitGuard(
  invocationId: string,
  expectedRunRevision: number,
  readGuards: CommitGuard['readGuards'] = [],
): CommitGuard {
  return {
    authority,
    sessionId: 'session-1',
    runId: 'run-1',
    writerId: 'writer-a',
    writerEpoch: 1,
    expectedRunRevision,
    bindingId: 'binding-1',
    invocationId,
    readGuards,
    queryUsage: null,
  }
}

function atomicDomain(domainId = 'domain-1') {
  return {
    domainId,
    revision: 1,
    stateAuthority: authority,
    budgetAuthority: authority,
    stateBinding: runBinding,
    budgetBinding: runBinding,
  }
}

function advanceBody(
  commitId: string,
  invocationId: string,
  revision: number,
  actions: PreparedAction[],
): AdvanceRunRequest {
  return {
    commitId,
    guard: commitGuard(invocationId, revision),
    transition: {
      expectedRevision: revision,
      continuation: continuation(revision + 1),
      consumeSignals: [],
      actions,
      next: { kind: 'continue' },
    },
  }
}

function dispatchBody(
  action: PreparedAction,
  invocationId: string,
  runRevision: number,
  admissionId: string,
  quota: { name: 'parallel-action' | 'live-agent'; amount: number }[] = [],
  deadline = future,
): DispatchAdmissionRequest {
  const actionId = stableId('act', `run-1\0${action.key}`)
  return {
    admissionId,
    commitId: `commit-${admissionId}`,
    guard: commitGuard(invocationId, runRevision),
    atomicDomain: atomicDomain(),
    actionId,
    expectedActionRevision: 1,
    decisionRef: inline({ allow: admissionId }),
    attemptId: `attempt-${admissionId}`,
    requestIdentity: {
      system: 'tool',
      aghRequestId: `agh-${admissionId}`,
      idempotencyKey: null,
      requestDigest: canonicalDigest(action.input),
    },
    budget: { reservation: null, quota },
    deadline,
  }
}

async function mixedControl(path: string, action: PreparedAction, overlap: boolean) {
  const store = openStore(path)
  unwrap(await store.createRun(admission(), context()), 'createRun')
  unwrap(await store.open(writeOpen('open-write'), context()), 'open')
  await preparedInvocation(store, 'invocation-1', 0)
  const second = admission({ ticketId: 'ticket-2', runId: 'run-2', text: 'next' })
  const advance = advanceBody('advance-1', 'invocation-1', 0, [action])
  const batch = [dispatchBody(action, 'invocation-1', 1, 'admission-1')]
  const [createOutcome, advanceOutcome, dispatchOutcome] = overlap
    ? await Promise.all([
        store.createRun(second, context()),
        store.advanceRun(advance, context()),
        store.commitDispatchBatch('commit-batch-1', batch, context()),
      ])
    : [
        await store.createRun(second, context()),
        await store.advanceRun(advance, context()),
        await store.commitDispatchBatch('commit-batch-1', batch, context()),
      ]
  store.close()
  if (!createOutcome.ok || createOutcome.value.state !== 'created')
    throw new Error('createRun did not admit the second run')
  if (!advanceOutcome.ok)
    throw new Error(`${advanceOutcome.error.detailCode}: ${advanceOutcome.error.message}`)
  if (!dispatchOutcome.ok)
    throw new Error(`${dispatchOutcome.error.detailCode}: ${dispatchOutcome.error.message}`)
  const decision = dispatchOutcome.value[0]
  if (decision?.state !== 'admitted') throw new Error('dispatch was not admitted')
  return {
    runId: createOutcome.value.runId,
    runRevision: advanceOutcome.value.runRevision,
    actionIds: advanceOutcome.value.actionIds,
    dispatch: {
      state: decision.state,
      authorizationId: decision.authorizationId,
      attemptId: decision.attemptId,
      commitId: decision.commitId,
    },
    events: count(path, 'events'),
  }
}

async function leasedRun(path = file()): Promise<{ path: string; store: RuntimeStateStore }> {
  const store = openStore(path)
  unwrap(await store.createRun(admission(), context()), 'createRun')
  unwrap(await store.open(writeOpen('open-write'), context()), 'open')
  return { path, store }
}

async function preparedInvocation(
  store: RuntimeStateStore,
  invocationId: string,
  baseRevision: number,
  queryAllowance = 0,
  readGuards: CommitGuard['readGuards'] = [],
) {
  const request: InvocationAdmission = {
    requestId: `admit-${invocationId}`,
    runId: 'run-1',
    targetActionId: null,
    baseRevision,
    bindingId: 'binding-1',
    writerEpoch: 1,
    invocationId,
    deadline: future,
    queryAllowance,
  }
  const admitted = unwrap(await store.admitInvocation(request, context()), 'admitInvocation')
  const closeRequest: CloseInvocationRequest = {
    requestId: `close-${invocationId}`,
    invocationId,
    state: 'prepared',
    readGuards,
    domainReads: [],
    unresolvedInflightIds: [],
    observedQueryCount: 0,
  }
  const closed = unwrap(await store.closeInvocation(closeRequest, context()), 'closeInvocation')
  return { admitted, closed }
}

type EventWire = {
  seq: number
  ts: string
  id: string
  type: string
  lane: Uint8Array | string
  v: number
  actor: string
  origin: string
  trust: string
  data: string
}

function rehashSession(path: string): void {
  const db = new DatabaseSync(path)
  try {
    const rows = db
      .prepare(
        `SELECT seq, ts, id, type, lane, v, actor, origin, trust, data
         FROM events WHERE session_key = ? ORDER BY seq`,
      )
      .all('session-1') as EventWire[]
    let state = emptyIntegrity()
    const update = db.prepare(
      `UPDATE events SET integrity_mode = ?, integrity_prev = ?, integrity_digest = ?
       WHERE session_key = ? AND seq = ?`,
    )
    for (const row of rows) {
      const event: LedgerEvent = {
        seq: row.seq,
        ts: row.ts,
        id: row.id,
        type: row.type,
        lane: Buffer.from(row.lane).toString('utf8'),
        v: row.v,
        actor: JSON.parse(row.actor) as LedgerEvent['actor'],
        origin: row.origin,
        trust: row.trust,
        data: JSON.parse(row.data) as unknown,
      }
      const protectedEvent = protectEvent('session-1', event, state)
      state = protectedEvent.state
      update.run(
        protectedEvent.integrity.mode,
        protectedEvent.integrity.previousDigest,
        protectedEvent.integrity.digest,
        'session-1',
        row.seq,
      )
    }
  } finally {
    db.close()
  }
}

function commitEvent(path: string, commitId: string): { seq: number; data: Record<string, unknown> } {
  const rows = query<{ seq: number; data: string }>(
    path,
    `SELECT seq, data FROM events WHERE session_key = 'session-1' AND json_extract(data, '$.commitId') = '${commitId}'`,
  )
  const row = rows[0]
  if (!row) throw new Error(`missing commit ${commitId}`)
  return { seq: row.seq, data: JSON.parse(row.data) as Record<string, unknown> }
}

function saveCommitEvent(path: string, seq: number, data: unknown): void {
  mutate(path, (db) => {
    db.prepare('UPDATE events SET data = ? WHERE session_key = ? AND seq = ?').run(
      JSON.stringify(data),
      'session-1',
      seq,
    )
  })
}

describe('runtime state advance, dispatch, and invocation', () => {
  it('matches a serial create, advance, and batched dispatch when those calls overlap', async () => {
    const action = preparedAction('step-1')
    const serial = await mixedControl(file(), action, false)
    const overlapped = await mixedControl(file(), action, true)
    expect(overlapped).toEqual(serial)
  })

  it('continues a run, admits an action, and marks the attempt running', async () => {
    const { path, store } = await leasedRun()
    expect(count(path, 'runtime_records')).toBe(5)
    const prepared = await preparedInvocation(store, 'invocation-1', 0, 1_000)
    expect(prepared.admitted).toMatchObject({
      prepareId: stableId('prep', 'run-1\0invocation-1'),
      invocationId: 'invocation-1',
      queryGrantId: stableId('qg', 'invocation-1'),
      grantedQueries: 128,
      remainingQueries: 65_536 - 128,
    })
    expect(prepared.closed).toEqual({ invocationId: 'invocation-1', state: 'prepared' })
    expect(count(path, 'runtime_records')).toBe(9)
    const action = preparedAction('step-1')
    const actionId = stableId('act', 'run-1\0step-1')
    const advanced = unwrap(
      await store.advanceRun(advanceBody('advance-1', 'invocation-1', 0, [action]), context()),
      'advanceRun',
    )
    expect(advanced.runRevision).toBe(1)
    expect(advanced.actionIds).toEqual([{ key: 'step-1', actionId }])
    expect(advanced.firstSeq).toBe(advanced.lastSeq)
    const createdAction = recordValue<{
      state: string
      resultHookPlan: null
      taintSnapshot: { recordRevision: number; sourceSeq: number; clearedThroughSeq: number }
      createdByCommitId: string
      intentFingerprint: string
    }>(path, `action:${actionId}`)
    expect(createdAction).toMatchObject({
      state: 'prepared',
      resultHookPlan: null,
      taintSnapshot: { recordRevision: 1, sourceSeq: 0, clearedThroughSeq: 0 },
      createdByCommitId: advanced.commitId,
      intentFingerprint: action.intentFingerprint,
    })
    expect(query<{ kind: string }>(path, 'SELECT kind FROM runtime_side_entries')).toEqual([
      { kind: 'action-created' },
    ])
    const run = recordValue<{ revision: number; state: string; writerEpoch: number }>(path, 'run:run-1')
    expect(run).toMatchObject({ revision: 1, state: 'admitted', writerEpoch: 1 })
    const invocation = recordValue<{ state: string }>(path, 'invocation:invocation-1')
    expect(invocation.state).toBe('committed')
    const admissionId = 'admission-1'
    const request = dispatchBody(action, 'invocation-1', 1, admissionId)
    const admitted = unwrap(await store.dispatchAdmission(request, context()), 'dispatchAdmission')
    const authorizationId = stableId('az', admissionId)
    expect(admitted).toEqual({
      state: 'admitted',
      commitId: request.commitId,
      authorizationId,
      attemptId: request.attemptId,
      budgetReservationRefs: [],
      quotaReservationRefs: [],
    })
    const attempt = recordValue<{
      kind: string
      number: number
      state: string
      authorizationRef: string
      requestIdentity: { requestDigest: string }
    }>(path, `attempt:${request.attemptId}`)
    expect(attempt).toMatchObject({
      kind: 'leaf',
      number: 1,
      state: 'dispatching',
      authorizationRef: authorizationId,
    })
    expect(attempt.requestIdentity.requestDigest).toBe(canonicalDigest(action.input))
    const stored = query<{ fingerprint: string; result_json: string }>(
      path,
      "SELECT fingerprint, result_json FROM runtime_request_results WHERE method = 'dispatchAdmission'",
    )
    const payload = JSON.parse(stored[0]?.result_json ?? '{}') as {
      request: { decisionRef: unknown }
      decisionRef: unknown
      result: unknown
    }
    expect(stored[0]?.fingerprint).toBe(canonicalDigest(request))
    expect(payload.decisionRef).toEqual(request.decisionRef)
    expect(payload.request.decisionRef).toEqual(request.decisionRef)
    expect(payload.result).toEqual(admitted)
    const running = unwrap(
      await store.commitControl(
        {
          commitId: 'mark-1',
          guard: commitGuard('invocation-1', 1),
          command: {
            kind: 'mark_running',
            attemptId: request.attemptId,
            expectedAttemptRevision: 1,
            externalRequests: [{ system: 'ext', requestId: 'ext-1', requestDigest: 'e'.repeat(64) }],
          },
        },
        context(),
      ),
      'mark_running',
    )
    expect(running.runRevision).toBe(1)
    expect(
      recordValue<{ state: string; startedAt: string }>(path, `attempt:${request.attemptId}`),
    ).toMatchObject({
      state: 'running',
      startedAt: admittedAt,
    })
    const appended = unwrap(
      await store.commitControl(
        {
          commitId: 'mark-2',
          guard: commitGuard('invocation-1', 1),
          command: {
            kind: 'mark_running',
            attemptId: request.attemptId,
            expectedAttemptRevision: 2,
            externalRequests: [{ system: 'ext', requestId: 'ext-1', requestDigest: 'e'.repeat(64) }],
          },
        },
        context(),
      ),
      'mark_running append',
    )
    expect(appended.runRevision).toBe(1)
    const listed = recordValue<{ externalRequests: { requestId: string }[]; startedAt: string }>(
      path,
      `attempt:${request.attemptId}`,
    )
    expect(listed.externalRequests).toEqual([
      { system: 'ext', requestId: 'ext-1', requestDigest: 'e'.repeat(64) },
    ])
    expect(listed.startedAt).toBe(admittedAt)
    store.close()
    const reopened = openStore(path)
    const opened = unwrap(await reopened.open(readOpen('open-read-again'), context()), 'reopen')
    reopened.close()
    expect(opened.claim).toBeNull()
    expect(opened.snapshot.throughSeq).toBe(appended.lastSeq)
  })

  it('replays the same commit and keeps the original decision when the lease has expired', async () => {
    const path = file()
    const clock = { ms: Date.parse(admittedAt) }
    const store = openStore(path, () => clock.ms)
    unwrap(await store.createRun(admission(), context()), 'createRun')
    unwrap(await store.open(writeOpen('open-write'), context()), 'open')
    await preparedInvocation(store, 'invocation-1', 0)
    const action = preparedAction('step-1')
    const request = advanceBody('advance-1', 'invocation-1', 0, [action])
    const first = unwrap(await store.advanceRun(request, context()), 'advanceRun')
    const eventsBefore = count(path, 'events')
    clock.ms += 5_000
    const replayed = unwrap(await store.advanceRun(request, context()), 'advance replay')
    expect(replayed).toEqual(first)
    expect(count(path, 'events')).toBe(eventsBefore)
    const other = await store.advanceRun(advanceBody('advance-2', 'invocation-1', 1, []), context())
    expect(other.ok).toBe(false)
    if (!other.ok) expect(other.error).toMatchObject({ code: 'conflict', detailCode: 'writer_lease' })
    store.close()
  })

  it('reuses an action with the same intent and conflicts when the intent differs', async () => {
    const { path, store } = await leasedRun()
    await preparedInvocation(store, 'invocation-1', 0)
    const action = preparedAction('step-1')
    unwrap(
      await store.advanceRun(advanceBody('advance-1', 'invocation-1', 0, [action]), context()),
      'advance',
    )
    await preparedInvocation(store, 'invocation-2', 1)
    const reused = unwrap(
      await store.advanceRun(advanceBody('advance-2', 'invocation-2', 1, [action]), context()),
      'reuse',
    )
    expect(reused.actionIds).toEqual([{ key: 'step-1', actionId: stableId('act', 'run-1\0step-1') }])
    expect(
      query<{ n: number }>(
        path,
        "SELECT COUNT(*) AS n FROM runtime_side_entries WHERE kind = 'action-created'",
      ),
    ).toEqual([{ n: 1 }])
    const { intentFingerprint: _previous, ...body } = preparedAction('step-1')
    body.method = 'other'
    const changed = { ...body, intentFingerprint: canonicalDigest(body) }
    await preparedInvocation(store, 'invocation-3', 2)
    const before = count(path, 'events')
    const conflict = await store.advanceRun(advanceBody('advance-3', 'invocation-3', 2, [changed]), context())
    expect(conflict.ok).toBe(false)
    if (!conflict.ok)
      expect(conflict.error).toMatchObject({ code: 'conflict', detailCode: 'intent_fingerprint' })
    expect(count(path, 'events')).toBe(before)
    store.close()
  })

  it('returns the original dispatch and conflicts when the same admission id changes', async () => {
    const { path, store } = await leasedRun()
    await preparedInvocation(store, 'invocation-1', 0)
    const action = preparedAction('step-1')
    unwrap(
      await store.advanceRun(advanceBody('advance-1', 'invocation-1', 0, [action]), context()),
      'advance',
    )
    const absent = unwrap(await store.probeDispatchAdmission('admission-1', context()), 'probe absent')
    expect(absent).toEqual({ state: 'absent' })
    const request = dispatchBody(action, 'invocation-1', 1, 'admission-1')
    const first = unwrap(await store.dispatchAdmission(request, context()), 'dispatch')
    const again = unwrap(await store.dispatchAdmission(request, context()), 'dispatch replay')
    expect(again).toEqual(first)
    expect(count(path, 'runtime_records')).toBeGreaterThan(0)
    const attempts = query<{ n: number }>(
      path,
      `SELECT COUNT(*) AS n FROM runtime_records WHERE record_id LIKE 'attempt:%'`,
    )
    expect(attempts).toEqual([{ n: 1 }])
    const changed = { ...request, deadline: '2026-06-01T00:00:00.000Z' }
    const before = count(path, 'events')
    const conflict = await store.dispatchAdmission(changed, context())
    expect(conflict.ok).toBe(false)
    if (!conflict.ok)
      expect(conflict.error).toMatchObject({ code: 'conflict', detailCode: 'idempotency_conflict' })
    expect(count(path, 'events')).toBe(before)
    const decided = unwrap(await store.probeDispatchAdmission('admission-1', context()), 'probe decided')
    expect(decided).toMatchObject({
      state: 'decided',
      admissionId: 'admission-1',
      requestFingerprint: canonicalDigest(request),
      result: first,
    })
    expect(query<{ writer_epoch: number }>(path, 'SELECT writer_epoch FROM runtime_leases')).toEqual([
      { writer_epoch: 1 },
    ])
    store.close()
  })

  it('refuses unsupported transitions, budget modes, hooks, and control commands without writing', async () => {
    const { path, store } = await leasedRun()
    await preparedInvocation(store, 'invocation-1', 0)
    const action = preparedAction('step-1')
    const before = count(path, 'events')
    const signal = await store.advanceRun(
      {
        ...advanceBody('advance-signal', 'invocation-1', 0, [action]),
        transition: {
          ...advanceBody('advance-signal', 'invocation-1', 0, [action]).transition,
          consumeSignals: ['signal-1'],
        },
      },
      context(),
    )
    const conversation = await store.advanceRun(
      {
        ...advanceBody('advance-talk', 'invocation-1', 0, []),
        transition: {
          ...advanceBody('advance-talk', 'invocation-1', 0, []).transition,
          conversation: [
            {
              key: 'message-1',
              kind: 'assistant-message',
              content: inline({ text: 'hi' }),
              sourceResultId: null,
            },
          ],
        },
      },
      context(),
    )
    const failed = await store.advanceRun(
      {
        ...advanceBody('advance-fail', 'invocation-1', 0, []),
        transition: {
          ...advanceBody('advance-fail', 'invocation-1', 0, []).transition,
          next: {
            kind: 'fail',
            error: {
              code: 'internal',
              detailCode: 'stop',
              message: 'stop',
              retryAdvice: { kind: 'never' },
              diagnosticId: 'diag-1',
            },
          },
        },
      },
      context(),
    )
    const flushed = await store.advanceRun(
      {
        commitId: 'advance-flush',
        guard: {
          ...commitGuard('invocation-1', 0),
          queryUsage: {
            grantId: 'grant-1',
            invocationId: 'invocation-1',
            writerEpoch: 1,
            cumulativeCount: 1,
          },
        },
        transition: advanceBody('advance-flush', 'invocation-1', 0, []).transition,
      },
      context(),
    )
    const reserved = await store.dispatchAdmission(
      {
        ...dispatchBody(action, 'invocation-1', 0, 'admission-budget'),
        budget: {
          reservation: {
            accountRef: {
              authorityId: 'authority-1',
              recordId: 'account-1',
              recordRevision: 1,
              schema: inline({}).schema,
              digest: 'a'.repeat(64),
            },
            parentReservationRef: null,
            unitsByKind: [{ unit: 'token', value: '1' }],
            amount: null,
          },
          quota: [],
        },
      },
      context(),
    )
    const live = await store.dispatchAdmission(
      {
        ...dispatchBody(action, 'invocation-1', 0, 'admission-live', [{ name: 'live-agent', amount: 1 }]),
      },
      context(),
    )
    const hooked = await store.dispatchAdmission(
      {
        ...dispatchBody(action, 'invocation-1', 0, 'admission-hook'),
        hookResults: [
          {
            stageId: 'stage-1',
            event: 'tool_call',
            registrationDigest: 'b'.repeat(64),
            inputDigest: 'c'.repeat(64),
            entries: [],
            output: inline({ ok: true }),
            digest: 'd'.repeat(64),
            sourceActionId: null,
          },
        ],
      },
      context(),
    )
    const acked = await store.dispatchAdmission(
      {
        ...dispatchBody(action, 'invocation-1', 0, 'admission-ack'),
        approvalTaintAck: {
          interaction: {
            authorityId: 'authority-1',
            recordId: 'interaction-1',
            recordRevision: 1,
            schema: inline({}).schema,
            digest: 'a'.repeat(64),
          },
          responseId: 'response-1',
        },
      },
      context(),
    )
    const other: CommitControlRequest = {
      commitId: 'control-other',
      guard: commitGuard('invocation-1', 0),
      command: {
        kind: 'mark_unknown',
        attemptId: 'attempt-x',
        expectedAttemptRevision: 1,
        evidence: [],
        reconciliationOwnerRef: { kind: 'run', id: 'run-1' },
        reason: 'lost',
      },
    }
    const refused = await store.commitControl(other, context())
    const zero = await store.dispatchAdmission(
      dispatchBody(action, 'invocation-1', 0, 'admission-zero', [{ name: 'parallel-action', amount: 0 }]),
      context(),
    )
    store.close()
    expect(signal.ok).toBe(false)
    if (!signal.ok) expect(signal.error).toMatchObject({ code: 'conflict', detailCode: 'signal_absent' })
    expect(conversation.ok).toBe(false)
    if (!conversation.ok)
      expect(conversation.error.message).toBe('conversation contribution is not implemented')
    expect(failed.ok).toBe(false)
    if (!failed.ok)
      expect(failed.error.message).toBe('wait, complete, and fail transitions are not implemented')
    expect(flushed.ok).toBe(false)
    if (!flushed.ok)
      expect(flushed.error).toMatchObject({ code: 'invalid_input', detailCode: 'grant_absent' })
    expect(reserved.ok).toBe(false)
    if (!reserved.ok)
      expect(reserved.error.message).toBe('bounded-units and cost-hard budget reservation is not implemented')
    expect(live.ok).toBe(false)
    if (!live.ok) expect(live.error.message).toBe('live-agent quota is not implemented')
    expect(hooked.ok).toBe(false)
    if (!hooked.ok)
      expect(hooked.error.message).toBe('hook results and approval taint acknowledgement are not implemented')
    expect(acked.ok).toBe(false)
    if (!acked.ok)
      expect(acked.error.message).toBe('hook results and approval taint acknowledgement are not implemented')
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.message).toBe('control command is not implemented')
    expect(zero.ok).toBe(false)
    if (!zero.ok) expect(zero.error).toMatchObject({ code: 'invalid_input', detailCode: 'quota_amount' })
    expect(count(path, 'events')).toBe(before)
    expect(
      query(path, "SELECT request_id FROM runtime_request_results WHERE method = 'dispatchAdmission'"),
    ).toEqual([])
  })

  it('rejects a non-zero observed query count without closing the invocation', async () => {
    const { path, store } = await leasedRun()
    unwrap(
      await store.admitInvocation(
        {
          requestId: 'admit-invocation-1',
          runId: 'run-1',
          targetActionId: null,
          baseRevision: 0,
          bindingId: 'binding-1',
          writerEpoch: 1,
          invocationId: 'invocation-1',
          deadline: future,
          queryAllowance: 0,
        },
        context(),
      ),
      'admit',
    )
    const before = count(path, 'events')
    const refused = await store.closeInvocation(
      {
        requestId: 'close-bad',
        invocationId: 'invocation-1',
        state: 'prepared',
        readGuards: [],
        domainReads: [],
        unresolvedInflightIds: [],
        observedQueryCount: 2,
      },
      context(),
    )
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error).toMatchObject({ code: 'invalid_input', detailCode: 'query_count' })
    expect(count(path, 'events')).toBe(before)
    expect(recordValue<{ state: string }>(path, 'invocation:invocation-1').state).toBe('active')
    expect(
      query<{ invocation_id: string }>(path, 'SELECT invocation_id FROM runtime_active_invocation'),
    ).toEqual([{ invocation_id: 'invocation-1' }])
    const second = await store.admitInvocation(
      {
        requestId: 'admit-invocation-2',
        runId: 'run-1',
        targetActionId: null,
        baseRevision: 0,
        bindingId: 'binding-1',
        writerEpoch: 1,
        invocationId: 'invocation-2',
        deadline: future,
        queryAllowance: 0,
      },
      context(),
    )
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error).toMatchObject({ code: 'conflict', detailCode: 'invocation_state' })
    unwrap(
      await store.closeInvocation(
        {
          requestId: 'close-invocation-1',
          invocationId: 'invocation-1',
          state: 'prepared',
          readGuards: [],
          domainReads: [],
          unresolvedInflightIds: [],
          observedQueryCount: 0,
        },
        context(),
      ),
      'close',
    )
    expect(count(path, 'runtime_active_invocation')).toBe(0)
    store.close()
  })

  it('rejects an over-cap parallel hold and an expired deadline in the admission transaction', async () => {
    const { path, store } = await leasedRun()
    await preparedInvocation(store, 'invocation-1', 0)
    const first = preparedAction('step-1')
    unwrap(await store.advanceRun(advanceBody('advance-1', 'invocation-1', 0, [first]), context()), 'advance')
    const held = unwrap(
      await store.dispatchAdmission(
        dispatchBody(first, 'invocation-1', 1, 'admission-hold', [{ name: 'parallel-action', amount: 16 }]),
        context(),
      ),
      'hold',
    )
    expect(held.state).toBe('admitted')
    if (held.state === 'admitted') {
      expect(held.quotaReservationRefs).toEqual([stableId('qr', 'admission-hold')])
      expect(held.budgetReservationRefs).toEqual([])
    }
    await preparedInvocation(store, 'invocation-2', 1)
    const second = preparedAction('step-2')
    unwrap(
      await store.advanceRun(advanceBody('advance-2', 'invocation-2', 1, [second]), context()),
      'advance 2',
    )
    const rejected = unwrap(
      await store.dispatchAdmission(
        dispatchBody(second, 'invocation-2', 2, 'admission-over', [{ name: 'parallel-action', amount: 1 }]),
        context(),
      ),
      'over cap',
    )
    expect(rejected).toMatchObject({ state: 'rejected', reason: 'quota', commitId: 'commit-admission-over' })
    if (rejected.state === 'rejected') expect(rejected.error.code).toBe('quota')
    const settled = recordValue<{ state: string; currentAttemptId: string }>(
      path,
      `action:${stableId('act', 'run-1\0step-2')}`,
    )
    expect(settled.state).toBe('settled')
    expect(settled.currentAttemptId).toBe(stableId('ctl', 'admission-over'))
    const control = recordValue<{
      kind: string
      number: number
      authorizationRef: null
      requestIdentity: null
    }>(path, `attempt:${stableId('ctl', 'admission-over')}`)
    expect(control).toMatchObject({
      kind: 'control',
      number: 0,
      authorizationRef: null,
      requestIdentity: null,
    })
    expect(
      query(path, `SELECT record_id FROM runtime_records WHERE record_id = 'attempt:attempt-admission-over'`),
    ).toEqual([])
    const mirrors = query<{ value_json: string }>(
      path,
      "SELECT value_json FROM runtime_records WHERE record_id LIKE 'quota:%'",
    )
    expect(
      mirrors.filter(
        (row) =>
          (JSON.parse(row.value_json) as { requestFingerprint: string }).requestFingerprint ===
          canonicalDigest(
            dispatchBody(second, 'invocation-2', 2, 'admission-over', [
              { name: 'parallel-action', amount: 1 },
            ]),
          ),
      ),
    ).toEqual([])
    await preparedInvocation(store, 'invocation-3', 2)
    const third = preparedAction('step-3')
    unwrap(
      await store.advanceRun(advanceBody('advance-3', 'invocation-3', 2, [third]), context()),
      'advance 3',
    )
    const expired = unwrap(
      await store.dispatchAdmission(
        dispatchBody(third, 'invocation-3', 3, 'admission-old', [], past),
        context(),
      ),
      'expired',
    )
    expect(expired).toMatchObject({ state: 'rejected', reason: 'expired' })
    if (expired.state === 'rejected')
      expect(expired.error).toMatchObject({ code: 'timeout', detailCode: 'expired' })
    const probe = unwrap(await store.probeDispatchAdmission('admission-over', context()), 'probe over')
    expect(probe).toMatchObject({ state: 'decided', result: rejected })
    store.close()
    const reopened = openStore(path)
    expect((await reopened.open(readOpen('open-after-reject'), context())).ok).toBe(true)
    reopened.close()
  })

  it('commits a quota rejection beside an admitted sibling in one dispatch batch', async () => {
    const { path, store } = await leasedRun()
    await preparedInvocation(store, 'invocation-1', 0)
    const heldAction = preparedAction('step-hold')
    const rejectedAction = preparedAction('step-over')
    unwrap(
      await store.advanceRun(
        advanceBody('advance-batch', 'invocation-1', 0, [heldAction, rejectedAction]),
        context(),
      ),
      'advance',
    )
    const before = count(path, 'events')
    const heldRequest = dispatchBody(heldAction, 'invocation-1', 1, 'admission-hold', [
      { name: 'parallel-action', amount: 16 },
    ])
    const rejectedRequest = dispatchBody(rejectedAction, 'invocation-1', 1, 'admission-over', [
      { name: 'parallel-action', amount: 1 },
    ])
    const dispatched = unwrap(
      await store.commitDispatchBatch('commit-batch-hold', [heldRequest, rejectedRequest], context()),
      'batch',
    )
    expect(dispatched).toHaveLength(2)
    expect(dispatched[0]).toMatchObject({
      state: 'admitted',
      commitId: 'commit-batch-hold',
      quotaReservationRefs: [stableId('qr', 'admission-hold')],
    })
    expect(dispatched[1]).toMatchObject({
      state: 'rejected',
      reason: 'quota',
      commitId: 'commit-batch-hold',
    })
    if (dispatched[1]?.state === 'rejected') expect(dispatched[1].error.code).toBe('quota')
    expect(count(path, 'events')).toBe(before + 1)
    expect(actionState(path, 'step-hold')).toBe('dispatching')
    expect(actionState(path, 'step-over')).toBe('settled')
    expect(quotaFingerprints(path)).toEqual([canonicalDigest(heldRequest)])
    const replayed = unwrap(
      await store.commitDispatchBatch('commit-batch-replay', [heldRequest, rejectedRequest], context()),
      'replay',
    )
    expect(replayed).toEqual(dispatched)
    expect(count(path, 'events')).toBe(before + 1)
    await preparedInvocation(store, 'invocation-2', 1)
    const third = preparedAction('step-next')
    unwrap(
      await store.advanceRun(advanceBody('advance-next', 'invocation-2', 1, [third]), context()),
      'advance next',
    )
    const beforePartial = count(path, 'events')
    const partial = unwrap(
      await store.commitDispatchBatch(
        'commit-batch-partial',
        [
          heldRequest,
          dispatchBody(third, 'invocation-2', 2, 'admission-next', [{ name: 'parallel-action', amount: 1 }]),
        ],
        context(),
      ),
      'partial',
    )
    expect(partial[0]).toEqual(dispatched[0])
    expect(partial[1]).toMatchObject({
      state: 'rejected',
      reason: 'quota',
      commitId: 'commit-batch-partial',
    })
    expect(count(path, 'events')).toBe(beforePartial + 1)
    expect(actionState(path, 'step-hold')).toBe('dispatching')
    expect(quotaFingerprints(path)).toEqual([canonicalDigest(heldRequest)])
    store.close()
    const reopened = openStore(path)
    unwrap(await reopened.open(readOpen('open-after-batch'), context()), 'reopen')
    reopened.close()
  })

  it('rolls the dispatch batch back when one admission is refused', async () => {
    const { path, store } = await leasedRun()
    await preparedInvocation(store, 'invocation-1', 0)
    const first = preparedAction('step-a')
    const second = preparedAction('step-b')
    unwrap(
      await store.advanceRun(advanceBody('advance-refuse', 'invocation-1', 0, [first, second]), context()),
      'advance',
    )
    const before = count(path, 'events')
    const refused = await store.commitDispatchBatch(
      'commit-batch-refuse',
      [
        dispatchBody(first, 'invocation-1', 1, 'admission-keep', [{ name: 'parallel-action', amount: 1 }]),
        {
          ...dispatchBody(second, 'invocation-1', 1, 'admission-bad', [
            { name: 'parallel-action', amount: 1 },
          ]),
          expectedActionRevision: 99,
        },
      ],
      context(),
    )
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error).toMatchObject({ code: 'conflict', detailCode: 'action_state' })
    expect(count(path, 'events')).toBe(before)
    expect(actionState(path, 'step-a')).toBe('prepared')
    expect(actionState(path, 'step-b')).toBe('prepared')
    expect(
      query(path, "SELECT request_id FROM runtime_request_results WHERE method = 'dispatchAdmission'"),
    ).toEqual([])
    expect(
      query<{ domain: string | null }>(
        path,
        'SELECT dispatch_domain_json AS domain FROM runtime_session_meta',
      ),
    ).toEqual([{ domain: null }])
    const admitted = unwrap(
      await store.dispatchAdmission(
        dispatchBody(first, 'invocation-1', 1, 'admission-keep', [{ name: 'parallel-action', amount: 1 }]),
        context(),
      ),
      'after rollback',
    )
    expect(admitted.state).toBe('admitted')
    expect(actionState(path, 'step-a')).toBe('dispatching')
    expect(actionState(path, 'step-b')).toBe('prepared')
    store.close()
    const reopened = openStore(path)
    expect((await reopened.open(readOpen('open-after-rollback'), context())).ok).toBe(true)
    reopened.close()
  })

  it('publishes the no-hook ready view, result, and completion signal for a rejection', async () => {
    const { path, store } = await leasedRun()
    await preparedInvocation(store, 'invocation-1', 0)
    const action = preparedAction('step-1')
    unwrap(
      await store.advanceRun(advanceBody('advance-1', 'invocation-1', 0, [action]), context()),
      'advance',
    )
    const before = count(path, 'events')
    const rejected = unwrap(
      await store.dispatchAdmission(
        dispatchBody(action, 'invocation-1', 1, 'admission-old', [], past),
        context(),
      ),
      'expired',
    )
    expect(rejected).toMatchObject({ state: 'rejected', reason: 'expired' })
    expect(count(path, 'events')).toBe(before + 1)
    if (rejected.state !== 'rejected') throw new Error('expected a rejected admission')
    const receiptId = stableId('rcpt', 'admission-old')
    const signalId = stableId('sig', `authority-1\0${receiptId}\0run`)
    const eventId = stableId('obx', `${rejected.commitId}\0result\0${receiptId}`)
    const visibility = recordValue<{
      state: string
      stageActionId: null
      registrationDigest: null
      publishedByCommitId: string
      result: {
        outcome: string
        result?: unknown
        error: { code: string }
        viewId: string
        sourceReceiptId: string
      }
    }>(path, `visibility:${receiptId}`)
    expect(visibility).toMatchObject({
      state: 'ready',
      stageActionId: null,
      registrationDigest: null,
      publishedByCommitId: rejected.commitId,
      result: {
        outcome: 'failed',
        viewId: stableId('view', `${receiptId}\0`),
        sourceReceiptId: receiptId,
        error: { code: 'timeout' },
      },
    })
    expect(visibility.result.result).toBeUndefined()
    const signal = recordValue<{
      consumedByCommitId: null
      signal: { signalId: string; seq: number; targetActionId: null; typeId: string }
    }>(path, `signal:${signalId}`)
    expect(signal).toMatchObject({
      consumedByCommitId: null,
      signal: {
        signalId,
        seq: 1,
        targetActionId: null,
        typeId: 'agh.runtime/action-completed@1',
      },
    })
    expect(
      recordValue<{ delivery: string; claim: null; attempts: number; typeId: string }>(
        path,
        `outbox:${eventId}`,
      ),
    ).toEqual(
      expect.objectContaining({
        delivery: 'pending',
        claim: null,
        attempts: 0,
        typeId: 'agh.runtime/action-result@1',
        destination: stableId('obxdst', authority.authorityId),
        eventId,
        sourceCommitId: rejected.commitId,
      }),
    )
    expect(
      query<{ kind: string }>(
        path,
        `SELECT kind FROM runtime_side_entries WHERE commit_id = '${rejected.commitId}' ORDER BY kind`,
      ),
    ).toEqual([{ kind: 'outbox-created' }, { kind: 'receipt-created' }])
    expect(recordValue<{ state: string }>(path, `action:${stableId('act', 'run-1\0step-1')}`).state).toBe(
      'settled',
    )
    store.close()
    const reopened = openStore(path)
    expect((await reopened.open(readOpen('open-after-reject'), context())).ok).toBe(true)
    reopened.close()
  })

  it('fails open when the stored decisionRef no longer matches the admission fingerprint', async () => {
    const { path, store } = await leasedRun()
    await preparedInvocation(store, 'invocation-1', 0)
    const action = preparedAction('step-1')
    unwrap(
      await store.advanceRun(advanceBody('advance-1', 'invocation-1', 0, [action]), context()),
      'advance',
    )
    const request = dispatchBody(action, 'invocation-1', 1, 'admission-1')
    unwrap(await store.dispatchAdmission(request, context()), 'dispatch')
    store.close()
    mutate(path, (db) => {
      const row = db
        .prepare("SELECT result_json FROM runtime_request_results WHERE method = 'dispatchAdmission'")
        .get() as { result_json: string }
      const payload = JSON.parse(row.result_json) as {
        request: { decisionRef: unknown }
        decisionRef: unknown
      }
      payload.request.decisionRef = inline({ allow: 'changed' })
      payload.decisionRef = payload.request.decisionRef
      db.prepare("UPDATE runtime_request_results SET result_json = ? WHERE method = 'dispatchAdmission'").run(
        JSON.stringify(payload),
      )
    })
    const reopened = openStore(path)
    const opened = await reopened.open(writeOpen('open-tampered-decision'), context())
    reopened.close()
    expect(opened.ok).toBe(false)
    if (!opened.ok) {
      expect(opened.error).toMatchObject({ code: 'incompatible', detailCode: 'integrity' })
      expect(opened.error.message).toBe('stored dispatch request does not match its fingerprint')
    }
  })

  it('fails open when an admitted attempt authorization differs from the saved decision', async () => {
    const { path, store } = await leasedRun()
    await preparedInvocation(store, 'invocation-1', 0)
    const action = preparedAction('step-1')
    unwrap(
      await store.advanceRun(advanceBody('advance-1', 'invocation-1', 0, [action]), context()),
      'advance',
    )
    const request = dispatchBody(action, 'invocation-1', 1, 'admission-1')
    unwrap(await store.dispatchAdmission(request, context()), 'dispatch')
    store.close()
    mutate(path, (db) => {
      const attemptId = `attempt:${request.attemptId}`
      const head = db
        .prepare('SELECT owner_json, value_json, schema_json FROM runtime_records WHERE record_id = ?')
        .get(attemptId) as {
        owner_json: string
        value_json: string
        schema_json: string
      }
      const value = JSON.parse(head.value_json) as { authorizationRef: string }
      value.authorizationRef = 'forged-authorization'
      const owner = JSON.parse(head.owner_json) as RecordOwner
      const digest = bodyDigest(owner, value)
      const valueJson = canonicalJson(value)
      db.prepare('UPDATE runtime_records SET value_json = ?, body_digest = ? WHERE record_id = ?').run(
        valueJson,
        digest,
        attemptId,
      )
      db.prepare('UPDATE runtime_record_versions SET value_json = ?, digest = ? WHERE record_id = ?').run(
        valueJson,
        digest,
        attemptId,
      )
      const manifests = db
        .prepare(
          'SELECT record_id, previous_revision, next_json FROM runtime_mutation_manifests WHERE commit_id = ?',
        )
        .all(request.commitId) as {
        record_id: string
        previous_revision: number | null
        next_json: string | null
      }[]
      const decoded: CommitMutationManifest[] = manifests.map((row) => {
        const next =
          row.next_json === null ? null : (JSON.parse(row.next_json) as CommitMutationManifest['next'])
        if (next && row.record_id === attemptId) next.digest = digest
        if (next && row.record_id === attemptId) {
          db.prepare(
            'UPDATE runtime_mutation_manifests SET next_json = ? WHERE commit_id = ? AND record_id = ?',
          ).run(canonicalJson(next), request.commitId, row.record_id)
        }
        return {
          commitId: request.commitId,
          recordId: row.record_id,
          previousRevision: row.previous_revision,
          next,
        }
      })
      const event = commitEvent(path, request.commitId)
      event.data.mutationsDigest = mutationDigest(decoded)
      saveCommitEvent(path, event.seq, event.data)
    })
    rehashSession(path)
    const reopened = openStore(path)
    const opened = await reopened.open(readOpen('open-forged-auth'), context())
    reopened.close()
    expect(opened.ok).toBe(false)
    if (!opened.ok) {
      expect(opened.error).toMatchObject({ code: 'incompatible', detailCode: 'integrity' })
      expect(opened.error.message).toBe('admitted authorization does not match the decision')
    }
  })

  it('fails open when a rejected admission still holds quota for the same fingerprint', async () => {
    const { path, store } = await leasedRun()
    await preparedInvocation(store, 'invocation-1', 0)
    const first = preparedAction('step-1')
    unwrap(await store.advanceRun(advanceBody('advance-1', 'invocation-1', 0, [first]), context()), 'advance')
    unwrap(
      await store.dispatchAdmission(
        dispatchBody(first, 'invocation-1', 1, 'admission-hold', [{ name: 'parallel-action', amount: 1 }]),
        context(),
      ),
      'hold',
    )
    await preparedInvocation(store, 'invocation-2', 1)
    const second = preparedAction('step-2')
    unwrap(
      await store.advanceRun(advanceBody('advance-2', 'invocation-2', 1, [second]), context()),
      'advance 2',
    )
    const request = dispatchBody(second, 'invocation-2', 2, 'admission-old', [], past)
    unwrap(await store.dispatchAdmission(request, context()), 'expired')
    store.close()
    const fingerprint = canonicalDigest(request)
    mutate(path, (db) => {
      const sample = db
        .prepare("SELECT schema_json, owner_json FROM runtime_records WHERE record_id LIKE 'quota:%' LIMIT 1")
        .get() as { schema_json: string; owner_json: string }
      const reservationId = 'forged-quota'
      const value = {
        source: {
          authorityId: 'authority-1',
          recordId: 'quota-source',
          recordRevision: 1,
          schema: inline({}).schema,
          digest: 'a'.repeat(64),
        },
        reservationId,
        ownerRef: { kind: 'run', id: 'run-1' },
        scopeIds: ['run-1'],
        kind: 'parallel-action',
        quantity: 1,
        status: 'held',
        requestFingerprint: fingerprint,
        createdAt: admittedAt,
        releasedAt: null,
      }
      const owner = JSON.parse(sample.owner_json) as RecordOwner
      const digest = bodyDigest(owner, value)
      const valueJson = canonicalJson(value)
      const recordId = `quota:${reservationId}`
      db.prepare(
        `INSERT INTO runtime_records (
           record_id, schema_json, min_reader, record_revision, last_commit_id, created_at, updated_at,
           owner_json, value_json, body_digest
         ) VALUES (?, ?, 2, 1, ?, ?, ?, ?, ?, ?)`,
      ).run(
        recordId,
        sample.schema_json,
        request.commitId,
        admittedAt,
        admittedAt,
        sample.owner_json,
        valueJson,
        digest,
      )
      db.prepare(
        `INSERT INTO runtime_record_versions (
           record_id, record_revision, schema_json, commit_id, digest, owner_json, value_json
         ) VALUES (?, 1, ?, ?, ?, ?, ?)`,
      ).run(recordId, sample.schema_json, request.commitId, digest, sample.owner_json, valueJson)
      const next = {
        recordRevision: 1,
        schema: JSON.parse(sample.schema_json) as CommitMutationManifest['next'],
        digest,
      }
      db.prepare(
        `INSERT INTO runtime_mutation_manifests (commit_id, record_id, previous_revision, next_json)
         VALUES (?, ?, NULL, ?)`,
      ).run(
        request.commitId,
        recordId,
        canonicalJson({ recordRevision: 1, schema: JSON.parse(sample.schema_json), digest }),
      )
      const manifests = db
        .prepare(
          'SELECT record_id, previous_revision, next_json FROM runtime_mutation_manifests WHERE commit_id = ?',
        )
        .all(request.commitId) as { record_id: string; previous_revision: number | null; next_json: string }[]
      const decoded: CommitMutationManifest[] = manifests.map((row) => ({
        commitId: request.commitId,
        recordId: row.record_id,
        previousRevision: row.previous_revision,
        next: JSON.parse(row.next_json) as CommitMutationManifest['next'],
      }))
      void next
      const event = commitEvent(path, request.commitId)
      event.data.mutationsDigest = mutationDigest(decoded)
      event.data.mutationCount = decoded.length
      saveCommitEvent(path, event.seq, event.data)
    })
    rehashSession(path)
    const reopened = openStore(path)
    const opened = await reopened.open(readOpen('open-held-quota'), context())
    reopened.close()
    expect(opened.ok).toBe(false)
    if (!opened.ok) {
      expect(opened.error).toMatchObject({ code: 'incompatible', detailCode: 'integrity' })
      expect(opened.error.message).toBe('rejected admission still holds quota')
    }
  })

  it('fails open when an action-created side entry is removed or no longer names its action', async () => {
    const { path, store } = await leasedRun()
    await preparedInvocation(store, 'invocation-1', 0)
    const action = preparedAction('step-1')
    const advanced = unwrap(
      await store.advanceRun(advanceBody('advance-1', 'invocation-1', 0, [action]), context()),
      'advance',
    )
    store.close()
    mutate(path, (db) => {
      db.prepare("DELETE FROM runtime_side_entries WHERE kind = 'action-created'").run()
    })
    const damaged = openStore(path)
    const missingSide = await damaged.open(readOpen('open-missing-side'), context())
    damaged.close()
    expect(missingSide.ok).toBe(false)
    if (!missingSide.ok)
      expect(missingSide.error).toMatchObject({ code: 'incompatible', detailCode: 'integrity' })
    expect(
      query<{ writer_id: string | null }>(
        path,
        'SELECT writer_id FROM runtime_leases WHERE writer_id IS NOT NULL',
      ),
    ).toEqual([{ writer_id: 'writer-a' }])
    const restored = file()
    const second = openStore(restored)
    unwrap(await second.createRun(admission(), context()), 'create')
    unwrap(await second.open(writeOpen('open-write'), context()), 'open')
    await preparedInvocation(second, 'invocation-1', 0)
    const committed = unwrap(
      await second.advanceRun(
        advanceBody('advance-1', 'invocation-1', 0, [preparedAction('step-1')]),
        context(),
      ),
      'advance',
    )
    second.close()
    mutate(restored, (db) => {
      db.prepare("DELETE FROM runtime_side_entries WHERE kind = 'action-created'").run()
      const event = commitEvent(restored, committed.commitId)
      event.data.sideListsDigest = sideListsDigest([])
      const counts = event.data.counts as { createdActions: number }
      counts.createdActions = 0
      saveCommitEvent(restored, event.seq, event.data)
    })
    rehashSession(restored)
    const reopened = openStore(restored)
    const opened = await reopened.open(readOpen('open-no-side'), context())
    reopened.close()
    expect(opened.ok).toBe(false)
    if (!opened.ok) expect(opened.error.message).toBe('action creation side entry does not match the action')
    void advanced
  })

  it('rolls the whole advance back when the commit is rejected', async () => {
    const path = file()
    let armed = false
    const store = openStore(
      path,
      () => Date.parse(admittedAt),
      () => {
        if (armed) throw new Error('stop before commit')
      },
    )
    unwrap(await store.createRun(admission(), context()), 'createRun')
    unwrap(await store.open(writeOpen('open-write'), context()), 'open')
    await preparedInvocation(store, 'invocation-1', 0)
    const before = count(path, 'events')
    armed = true
    const advanced = await store.advanceRun(
      advanceBody('advance-1', 'invocation-1', 0, [preparedAction('step-1')]),
      context(),
    )
    store.close()
    expect(advanced.ok).toBe(false)
    if (!advanced.ok) expect(advanced.error).toMatchObject({ code: 'internal', detailCode: 'fault' })
    expect(count(path, 'events')).toBe(before)
    expect(query(path, "SELECT record_id FROM runtime_records WHERE record_id LIKE 'action:%'")).toEqual([])
  })

  it('refuses a read guard that does not match the current record', async () => {
    const { path, store } = await leasedRun()
    unwrap(
      await store.admitInvocation(
        {
          requestId: 'admit-invocation-1',
          runId: 'run-1',
          targetActionId: null,
          baseRevision: 0,
          bindingId: 'binding-1',
          writerEpoch: 1,
          invocationId: 'invocation-1',
          deadline: future,
          queryAllowance: 0,
        },
        context(),
      ),
      'admit',
    )
    const before = count(path, 'events')
    const refused = await store.closeInvocation(
      {
        requestId: 'close-bad-guard',
        invocationId: 'invocation-1',
        state: 'prepared',
        readGuards: [{ recordId: 'run:run-1', expectedRecordRevision: 99 }],
        domainReads: [],
        unresolvedInflightIds: [],
        observedQueryCount: 0,
      },
      context(),
    )
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error).toMatchObject({ code: 'conflict', detailCode: 'read_guard' })
    expect(count(path, 'events')).toBe(before)
    unwrap(
      await store.closeInvocation(
        {
          requestId: 'close-invocation-1',
          invocationId: 'invocation-1',
          state: 'prepared',
          readGuards: [{ recordId: 'missing-record', expectedRecordRevision: null }],
          domainReads: [],
          unresolvedInflightIds: [],
          observedQueryCount: 0,
        },
        context(),
      ),
      'close',
    )
    const advanced = unwrap(
      await store.advanceRun(
        {
          ...advanceBody('advance-1', 'invocation-1', 0, []),
          guard: commitGuard('invocation-1', 0, [
            { recordId: 'missing-record', expectedRecordRevision: null },
          ]),
        },
        context(),
      ),
      'advance',
    )
    expect(advanced.runRevision).toBe(1)
    store.close()
  })

  it('stops an empty continue after 64 transitions that submit no action', async () => {
    const { path, store } = await leasedRun()
    for (let index = 0; index < 64; index += 1) {
      await preparedInvocation(store, `invocation-${index}`, index)
      unwrap(
        await store.advanceRun(advanceBody(`advance-${index}`, `invocation-${index}`, index, []), context()),
        `advance ${index}`,
      )
    }
    await preparedInvocation(store, 'invocation-64', 64)
    const before = count(path, 'events')
    const refused = await store.advanceRun(advanceBody('advance-64', 'invocation-64', 64, []), context())
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error).toMatchObject({ code: 'conflict', detailCode: 'quota' })
    expect(count(path, 'events')).toBe(before)
    store.close()
  })

  it('pins the dispatch domain on the first committed admission and ignores an unimplemented reservation', async () => {
    const { path, store } = await leasedRun()
    await preparedInvocation(store, 'invocation-1', 0)
    const action = preparedAction('step-1')
    unwrap(
      await store.advanceRun(advanceBody('advance-1', 'invocation-1', 0, [action]), context()),
      'advance',
    )
    const reserved = await store.dispatchAdmission(
      {
        ...dispatchBody(action, 'invocation-1', 1, 'admission-budget'),
        budget: {
          reservation: {
            accountRef: {
              authorityId: 'authority-1',
              recordId: 'account-1',
              recordRevision: 1,
              schema: inline({}).schema,
              digest: 'a'.repeat(64),
            },
            parentReservationRef: null,
            unitsByKind: [],
            amount: null,
          },
          quota: [],
        },
      },
      context(),
    )
    expect(reserved.ok).toBe(false)
    const admitted = unwrap(
      await store.dispatchAdmission(dispatchBody(action, 'invocation-1', 1, 'admission-1'), context()),
      'dispatch',
    )
    expect(admitted.state).toBe('admitted')
    expect(count(path, 'runtime_dispatch_domains')).toBe(1)
    const moved = await store.dispatchAdmission(
      {
        ...dispatchBody(action, 'invocation-1', 1, 'admission-2'),
        atomicDomain: atomicDomain('domain-2'),
      },
      context(),
    )
    expect(moved.ok).toBe(false)
    if (!moved.ok) expect(moved.error).toMatchObject({ code: 'conflict', detailCode: 'domain' })
    store.close()
  })

  it('conflicts when a running attempt repeats an external request with a different digest', async () => {
    const { path, store } = await leasedRun()
    await preparedInvocation(store, 'invocation-1', 0)
    const action = preparedAction('step-1')
    unwrap(
      await store.advanceRun(advanceBody('advance-1', 'invocation-1', 0, [action]), context()),
      'advance',
    )
    const request = dispatchBody(action, 'invocation-1', 1, 'admission-1')
    unwrap(await store.dispatchAdmission(request, context()), 'dispatch')
    unwrap(
      await store.commitControl(
        {
          commitId: 'mark-1',
          guard: commitGuard('invocation-1', 1),
          command: {
            kind: 'mark_running',
            attemptId: request.attemptId,
            expectedAttemptRevision: 1,
            externalRequests: [{ system: 'ext', requestId: 'ext-1', requestDigest: 'e'.repeat(64) }],
          },
        },
        context(),
      ),
      'mark',
    )
    const before = count(path, 'events')
    const conflict = await store.commitControl(
      {
        commitId: 'mark-2',
        guard: commitGuard('invocation-1', 1),
        command: {
          kind: 'mark_running',
          attemptId: request.attemptId,
          expectedAttemptRevision: 2,
          externalRequests: [{ system: 'ext', requestId: 'ext-1', requestDigest: 'f'.repeat(64) }],
        },
      },
      context(),
    )
    expect(conflict.ok).toBe(false)
    if (!conflict.ok)
      expect(conflict.error).toMatchObject({ code: 'conflict', detailCode: 'external_request' })
    expect(count(path, 'events')).toBe(before)
    store.close()
  })
})

const externalRequest = {
  system: 'ext',
  requestId: 'ext-1',
  requestDigest: 'e'.repeat(64),
}

function usageFact(actionId: string, attemptId: string, originKey = 'origin-1'): UsageFact {
  return {
    usageId: `usage-${originKey}`,
    originKey,
    actionId,
    attemptId,
    source: toolBinding,
    dimensions: inline({ tokens: 1 }),
    externalRequest,
    observedAt: admittedAt,
    certainty: 'measured',
  }
}

function intakeOf(
  intakeId: string,
  action: PreparedAction,
  attemptId: string,
  authorizationRef: string,
  receiptId: string,
  options: {
    originKey?: string
    references?: RetentionRef[]
    kind?: 'no-hook' | 'inline-pure' | 'staged'
  } = {},
): ReceiptIntakeRequest {
  const actionId = stableId('act', `run-1\0${action.key}`)
  const usage = usageFact(actionId, attemptId, options.originKey ?? 'origin-1')
  const receipt: Receipt = {
    receiptId,
    actionId,
    attemptId,
    bindingId: 'binding-1',
    inputDigest: canonicalDigest(action.input),
    outcome: 'succeeded',
    result: inline({ ok: true }),
    externalRequests: [externalRequest],
    usageRefs: [usage.usageId],
    references: options.references ?? [],
    provenance: { sourceRefs: [], producer: toolBinding, trustLabels: [] },
    completedAt: admittedAt,
  }
  const resultHandling =
    options.kind === 'inline-pure'
      ? {
          kind: 'inline-pure' as const,
          evaluation: {
            source: {
              sourceReceiptId: receiptId,
              sourceReceiptDigest: 'a'.repeat(64),
              evaluator: toolBinding,
              authorizationRef,
            },
            request: {
              stageId: 'stage-1',
              event: 'tool_result' as const,
              owner: { runId: 'run-1', actionId, requestId: receiptId },
              registrationDigest: 'b'.repeat(64),
              input: inline({ ok: true }),
              inputDigest: 'c'.repeat(64),
            },
            hookResultSet: {
              stageId: 'stage-1',
              event: 'tool_result',
              registrationDigest: 'b'.repeat(64),
              inputDigest: 'c'.repeat(64),
              entries: [],
              output: inline({ ok: true }),
              digest: 'd'.repeat(64),
              sourceActionId: null,
            },
          },
        }
      : options.kind === 'staged'
        ? { kind: 'staged' as const }
        : { kind: 'no-hook' as const }
  usageSource
    .prepare('INSERT OR IGNORE INTO observed_usage VALUES (?,?,?,NULL)')
    .run(jcs(usage), jcs(receipt), jcs([]))
  return {
    intakeId,
    receipt,
    usage: [usage],
    evidence: [],
    sourceAuthorizationRef: authorizationRef,
    queryUsage: null,
    resultHandling,
  }
}

async function markRunning(
  store: RuntimeStateStore,
  invocationId: string,
  revision: number,
  attemptId: string,
  commitId: string,
) {
  return unwrap(
    await store.commitControl(
      {
        commitId,
        guard: commitGuard(invocationId, revision),
        command: {
          kind: 'mark_running',
          attemptId,
          expectedAttemptRevision: 1,
          externalRequests: [externalRequest],
        },
      },
      context(),
    ),
    'mark_running',
  )
}

function loadSides(path: string, commitId: string): CommitSideEntry[] {
  return query<{ entry_json: string }>(
    path,
    `SELECT entry_json FROM runtime_side_entries WHERE commit_id = '${commitId}'`,
  ).map((row) => JSON.parse(row.entry_json) as CommitSideEntry)
}

function rewriteRecord(path: string, recordId: string, value: unknown): void {
  mutate(path, (db) => {
    const head = db
      .prepare('SELECT owner_json, record_revision, last_commit_id FROM runtime_records WHERE record_id = ?')
      .get(recordId) as { owner_json: string; record_revision: number; last_commit_id: string } | undefined
    if (!head) throw new Error(`missing record ${recordId}`)
    const owner = JSON.parse(head.owner_json) as RecordOwner
    const digest = bodyDigest(owner, value)
    const valueJson = canonicalJson(value)
    db.prepare('UPDATE runtime_records SET value_json = ?, body_digest = ? WHERE record_id = ?').run(
      valueJson,
      digest,
      recordId,
    )
    db.prepare(
      `UPDATE runtime_record_versions SET value_json = ?, digest = ?
       WHERE record_id = ? AND record_revision = ? AND commit_id = ?`,
    ).run(valueJson, digest, recordId, head.record_revision, head.last_commit_id)
    const manifests = db
      .prepare(
        'SELECT record_id, previous_revision, next_json FROM runtime_mutation_manifests WHERE commit_id = ?',
      )
      .all(head.last_commit_id) as {
      record_id: string
      previous_revision: number | null
      next_json: string | null
    }[]
    const decoded: CommitMutationManifest[] = manifests.map((row) => {
      const next =
        row.next_json === null ? null : (JSON.parse(row.next_json) as CommitMutationManifest['next'])
      if (next && row.record_id === recordId) {
        next.digest = digest
        db.prepare(
          'UPDATE runtime_mutation_manifests SET next_json = ? WHERE commit_id = ? AND record_id = ?',
        ).run(canonicalJson(next), head.last_commit_id, row.record_id)
      }
      return {
        commitId: head.last_commit_id,
        recordId: row.record_id,
        previousRevision: row.previous_revision,
        next,
      }
    })
    const event = db
      .prepare(
        `SELECT seq, data FROM events
         WHERE session_key = 'session-1' AND json_extract(data, '$.commitId') = ?`,
      )
      .get(head.last_commit_id) as { seq: number; data: string } | undefined
    if (!event) throw new Error(`missing commit ${head.last_commit_id}`)
    const data = JSON.parse(event.data) as Record<string, unknown>
    data.mutationsDigest = mutationDigest(decoded)
    db.prepare('UPDATE events SET data = ? WHERE session_key = ? AND seq = ?').run(
      JSON.stringify(data),
      'session-1',
      event.seq,
    )
  })
  rehashSession(path)
}

function replaceSides(path: string, commitId: string, sides: CommitSideEntry[]): void {
  mutate(path, (db) => {
    db.prepare('DELETE FROM runtime_side_entries WHERE commit_id = ?').run(commitId)
    const insert = db.prepare(
      `INSERT INTO runtime_side_entries (commit_id, kind, identity, entry_json) VALUES (?, ?, ?, ?)`,
    )
    for (const entry of sides) {
      insert.run(entry.commitId, entry.kind, sideEntryIdentity(entry), canonicalJson(entry))
    }
  })
  const event = commitEvent(path, commitId)
  event.data.sideListsDigest = sideListsDigest(sides)
  event.data.counts = {
    createdActions: sides.filter((side) => side.kind === 'action-created').length,
    consumedSignals: sides.filter((side) => side.kind === 'signal-consumed').length,
    outboxEvents: sides.filter((side) => side.kind === 'outbox-created').length,
    receipts: sides.filter((side) => side.kind === 'receipt-created').length,
    usageOrigins: sides.filter((side) => side.kind === 'usage-origin').length,
  }
  saveCommitEvent(path, event.seq, event.data)
  rehashSession(path)
}

describe('runtime state receipt intake, outbox, and query flush', () => {
  it('publishes a no-hook receipt once and reuses that decision', async () => {
    const { path, store } = await leasedRun()
    await preparedInvocation(store, 'invocation-1', 0)
    const action = preparedAction('step-1')
    unwrap(
      await store.advanceRun(advanceBody('advance-1', 'invocation-1', 0, [action]), context()),
      'advance',
    )
    const request = dispatchBody(action, 'invocation-1', 1, 'admission-1')
    const admitted = unwrap(await store.dispatchAdmission(request, context()), 'dispatch')
    if (admitted.state !== 'admitted') throw new Error('expected an admission')
    await markRunning(store, 'invocation-1', 1, request.attemptId, 'mark-1')
    const receiptId = 'receipt-1'
    const intake = intakeOf('intake-1', action, request.attemptId, admitted.authorizationId, receiptId)
    const absent = unwrap(
      await store.probeActionResult(
        { actionId: intake.receipt.actionId, sourceReceiptId: receiptId },
        context(),
      ),
      'probe absent',
    )
    expect(absent).toBeNull()
    const before = count(path, 'events')
    const observedUsage = intake.usage[0]
    if (!observedUsage) throw new Error('fixture producer observation is absent')
    const forgedUsage = { ...intake, usage: [{ ...observedUsage, dimensions: inline({ tokens: 2 }) }] }
    const unproven = await store.intakeReceipt(forgedUsage, context())
    expect(unproven.ok).toBe(false)
    if (!unproven.ok) expect(unproven.error.detailCode).toBe('usage_source')
    expect(count(path, 'events')).toBe(before)
    const accepted = unwrap(await store.intakeReceipt(intake, context()), 'intake')
    expect(accepted).toEqual({ intakeId: 'intake-1', state: 'accepted' })
    expect(count(path, 'events')).toBe(before + 1)
    const signalId = stableId('sig', `authority-1\0${receiptId}\0run`)
    const visibility = recordValue<{
      state: string
      publishedByCommitId: string
      result: { outcome: string; viewId: string; hookResultSetRef: null }
    }>(path, `visibility:${receiptId}`)
    expect(visibility.state).toBe('ready')
    expect(visibility.result).toMatchObject({
      outcome: 'succeeded',
      viewId: stableId('view', `${receiptId}\0`),
      hookResultSetRef: null,
      sourceReceiptId: receiptId,
    })
    const commitId = visibility.publishedByCommitId
    expect(
      recordValue<{ signal: { signalId: string; seq: number; targetActionId: null } }>(
        path,
        `signal:${signalId}`,
      ),
    ).toMatchObject({
      consumedByCommitId: null,
      targetRevisionAtCreation: 1,
      signal: { signalId, seq: 1, targetActionId: null, typeId: 'agh.runtime/action-completed@1' },
    })
    const eventId = stableId('obx', `${commitId}\0result\0${receiptId}`)
    expect(
      recordValue<{ eventId: string; delivery: string; claim: null }>(path, `outbox:${eventId}`),
    ).toMatchObject({
      eventId,
      destination: stableId('obxdst', authority.authorityId),
      typeId: 'agh.runtime/action-result@1',
      delivery: 'pending',
      claim: null,
      attempts: 0,
      sourceCommitId: commitId,
    })
    expect(
      recordValue<{ status: string }>(path, `usage:${stableId('use', 'authority-1\0origin-1')}`),
    ).toMatchObject({
      usage: { originKey: 'origin-1' },
    })
    expect(
      loadSides(path, commitId)
        .map((side) => side.kind)
        .sort(),
    ).toEqual(['outbox-created', 'receipt-created', 'usage-origin'])
    expect(
      recordValue<{ state: string; resolvedReceiptId: string }>(path, `action:${intake.receipt.actionId}`),
    ).toMatchObject({
      state: 'settled',
      resolvedReceiptId: receiptId,
    })
    expect(recordValue<{ state: string }>(path, `attempt:${request.attemptId}`).state).toBe('settled')
    const probed = unwrap(
      await store.probeActionResult(
        { actionId: intake.receipt.actionId, sourceReceiptId: receiptId } satisfies ProbeActionResultRequest,
        context(),
      ),
      'probe',
    )
    expect(probed).toMatchObject({ state: 'ready', sourceReceiptId: receiptId })
    expect(count(path, 'events')).toBe(before + 1)
    const replayed = unwrap(await store.intakeReceipt(intake, context()), 'replay')
    expect(replayed).toEqual(accepted)
    expect(count(path, 'events')).toBe(before + 1)
    const duplicate = unwrap(
      await store.intakeReceipt({ ...intake, intakeId: 'intake-2' }, context()),
      'duplicate',
    )
    expect(duplicate).toEqual({ intakeId: 'intake-1', state: 'duplicate' })
    expect(count(path, 'events')).toBe(before + 1)
    expect(
      query<{ n: number }>(path, "SELECT COUNT(*) AS n FROM runtime_records WHERE record_id LIKE 'signal:%'"),
    ).toEqual([{ n: 1 }])
    const changed = intakeOf('intake-1', action, request.attemptId, admitted.authorizationId, receiptId, {
      originKey: 'origin-2',
    })
    const sameId = await store.intakeReceipt(changed, context())
    expect(sameId.ok).toBe(false)
    if (!sameId.ok)
      expect(sameId.error).toMatchObject({ code: 'conflict', detailCode: 'idempotency_conflict' })
    const otherReceipt = intakeOf(
      'intake-3',
      action,
      request.attemptId,
      admitted.authorizationId,
      'receipt-2',
    )
    const conflict = await store.intakeReceipt(otherReceipt, context())
    expect(conflict.ok).toBe(false)
    if (!conflict.ok)
      expect(conflict.error).toMatchObject({ code: 'conflict', detailCode: 'receipt_conflict' })
    expect(count(path, 'events')).toBe(before + 1)
    store.close()
    const reopened = openStore(path)
    expect((await reopened.open(readOpen('open-after-intake'), context())).ok).toBe(true)
    reopened.close()
  })

  it('refuses inline-pure and staged handling before writing', async () => {
    const { path, store } = await leasedRun()
    await preparedInvocation(store, 'invocation-1', 0)
    const action = preparedAction('step-1')
    unwrap(
      await store.advanceRun(advanceBody('advance-1', 'invocation-1', 0, [action]), context()),
      'advance',
    )
    const request = dispatchBody(action, 'invocation-1', 1, 'admission-1')
    const admitted = unwrap(await store.dispatchAdmission(request, context()), 'dispatch')
    if (admitted.state !== 'admitted') throw new Error('expected an admission')
    await markRunning(store, 'invocation-1', 1, request.attemptId, 'mark-1')
    const before = count(path, 'events')
    const inlinePure = await store.intakeReceipt(
      intakeOf('intake-pure', action, request.attemptId, admitted.authorizationId, 'receipt-pure', {
        kind: 'inline-pure',
      }),
      context(),
    )
    const staged = await store.intakeReceipt(
      intakeOf('intake-staged', action, request.attemptId, admitted.authorizationId, 'receipt-staged', {
        kind: 'staged',
      }),
      context(),
    )
    expect(inlinePure.ok).toBe(false)
    if (!inlinePure.ok)
      expect(inlinePure.error.message).toBe('inline pure result handling is not implemented')
    expect(staged.ok).toBe(false)
    if (!staged.ok) expect(staged.error.message).toBe('staged result handling is not implemented')
    expect(count(path, 'events')).toBe(before)
    const accepted = unwrap(
      await store.intakeReceipt(
        intakeOf('intake-pure', action, request.attemptId, admitted.authorizationId, 'receipt-pure'),
        context(),
      ),
      'no-hook after refusal',
    )
    expect(accepted.state).toBe('accepted')
    store.close()
  })

  it('releases a held parallel-action mirror in the intake transaction', async () => {
    const { path, store } = await leasedRun()
    await preparedInvocation(store, 'invocation-1', 0)
    const action = preparedAction('step-1')
    unwrap(
      await store.advanceRun(advanceBody('advance-1', 'invocation-1', 0, [action]), context()),
      'advance',
    )
    const request = dispatchBody(action, 'invocation-1', 1, 'admission-1', [
      { name: 'parallel-action', amount: 1 },
    ])
    const admitted = unwrap(await store.dispatchAdmission(request, context()), 'dispatch')
    if (admitted.state !== 'admitted') throw new Error('expected an admission')
    await markRunning(store, 'invocation-1', 1, request.attemptId, 'mark-1')
    const mirrorId = stableId('qr', 'admission-1')
    expect(recordValue<{ status: string }>(path, `quota:${mirrorId}`).status).toBe('held')
    unwrap(
      await store.intakeReceipt(
        intakeOf('intake-1', action, request.attemptId, admitted.authorizationId, 'receipt-1'),
        context(),
      ),
      'intake',
    )
    expect(recordValue<{ status: string; releasedAt: string }>(path, `quota:${mirrorId}`)).toMatchObject({
      status: 'released',
      releasedAt: admittedAt,
    })
    expect(
      recordValue<{ activeQuotaReservationRefs: string[] }>(path, 'run-quota:run-1')
        .activeQuotaReservationRefs,
    ).toEqual([])
    expect(
      query<{ target_key: string; next_seq: number }>(
        path,
        'SELECT target_key, next_seq FROM runtime_signal_seq',
      ),
    ).toEqual([{ target_key: '', next_seq: 2 }])
    expect(count(path, 'runtime_active_invocation')).toBe(0)
    store.close()
  })

  it('keeps one reference when the receipt names a retained pin', async () => {
    const { path, store } = await leasedRun()
    await preparedInvocation(store, 'invocation-1', 0)
    const action = preparedAction('step-1')
    unwrap(
      await store.advanceRun(advanceBody('advance-1', 'invocation-1', 0, [action]), context()),
      'advance',
    )
    const request = dispatchBody(action, 'invocation-1', 1, 'admission-1')
    const admitted = unwrap(await store.dispatchAdmission(request, context()), 'dispatch')
    if (admitted.state !== 'admitted') throw new Error('expected an admission')
    await markRunning(store, 'invocation-1', 1, request.attemptId, 'mark-1')
    const dataDir = dirname(file())
    const blob = createBlobService({
      dataDir,
      authorityId: 'fixture-blob-authority',
      binding: {
        bindingId: 'fixture-blob',
        contract: 'agh.blob',
        logicalName: 'default',
        providerId: 'fixture-blob',
      },
      now: () => Date.parse(admittedAt),
    })
    blobServices.push(blob)
    const source = openBlobStore({
      dataDir,
      authorityId: 'fixture-blob-authority',
      now: () => Date.parse(admittedAt),
    })
    retentionSources.push(source)
    const bytes = new TextEncoder().encode('retained result')
    unwrap(
      await blob.stage(
        { uploadId: 'fixture-upload', size: bytes.byteLength, mediaType: 'text/plain', expectedDigest: null },
        context(),
      ),
      'blob stage',
    )
    const writer = unwrap(blob.openWriter('fixture-upload', context()), 'blob writer')
    unwrap(writer.write(0, bytes), 'blob write')
    const sealed = unwrap(await writer.seal(), 'blob seal')
    writer.close()
    const staged = unwrap(
      await blob.promote({ upload: sealed.upload, expectedDigest: sealed.upload.digest }, context()),
      'blob promote',
    )
    const blobRef = unwrap(
      await blob.pin(
        {
          stagedBlob: staged,
          ownerRef: { kind: 'artifact', value: { artifactId: 'fixture-artifact', version: 1 } },
          retentionUntil: null,
        },
        context(),
      ),
      'blob pin',
    )
    const pin: RetentionRef = {
      kind: 'blob',
      authorityId: blobRef.authorityId,
      resourceId: blobRef.blobId,
      version: '1',
      digest: blobRef.digest,
      pinId: blobRef.pinId,
    }
    unwrap(
      await store.intakeReceipt(
        intakeOf('intake-1', action, request.attemptId, admitted.authorizationId, 'receipt-1', {
          references: [pin],
        }),
        context(),
      ),
      'intake',
    )
    expect(
      recordValue<{ status: string; target: { kind: 'retained'; retention: RetentionRef } }>(
        path,
        `reference:${stableId('ref', `receipt-1\0${pin.pinId}`)}`,
      ),
    ).toMatchObject({
      status: 'confirmed',
      target: { kind: 'retained', retention: pin },
    })
    store.close()
    const reopened = openStore(path)
    expect((await reopened.open(readOpen('open-reference'), context())).ok).toBe(true)
    reopened.close()
  })

  it('consumes one completion signal and conflicts when it is consumed again', async () => {
    const { path, store } = await leasedRun()
    await preparedInvocation(store, 'invocation-1', 0)
    const action = preparedAction('step-1')
    unwrap(
      await store.advanceRun(advanceBody('advance-1', 'invocation-1', 0, [action]), context()),
      'advance',
    )
    const request = dispatchBody(action, 'invocation-1', 1, 'admission-1')
    const admitted = unwrap(await store.dispatchAdmission(request, context()), 'dispatch')
    if (admitted.state !== 'admitted') throw new Error('expected an admission')
    await markRunning(store, 'invocation-1', 1, request.attemptId, 'mark-1')
    unwrap(
      await store.intakeReceipt(
        intakeOf('intake-1', action, request.attemptId, admitted.authorizationId, 'receipt-1'),
        context(),
      ),
      'intake',
    )
    const signalId = stableId('sig', 'authority-1\0receipt-1\0run')
    await preparedInvocation(store, 'invocation-2', 1)
    const waiting = await store.advanceRun(
      {
        ...advanceBody('advance-wait', 'invocation-2', 1, []),
        transition: {
          ...advanceBody('advance-wait', 'invocation-2', 1, []).transition,
          next: {
            kind: 'wait',
            condition: {
              anyOf: [{ kind: 'signals', typeIds: ['agh.runtime/action-completed@1'], afterSeq: 0 }],
            },
          },
        },
      },
      context(),
    )
    expect(waiting.ok).toBe(false)
    if (!waiting.ok)
      expect(waiting.error.message).toBe('wait, complete, and fail transitions are not implemented')
    const before = count(path, 'events')
    const unknown = await store.advanceRun(
      {
        ...advanceBody('advance-missing', 'invocation-2', 1, []),
        transition: {
          ...advanceBody('advance-missing', 'invocation-2', 1, []).transition,
          consumeSignals: ['missing-signal'],
        },
      },
      context(),
    )
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error).toMatchObject({ code: 'conflict', detailCode: 'signal_absent' })
    const duplicated = await store.advanceRun(
      {
        ...advanceBody('advance-dup', 'invocation-2', 1, []),
        transition: {
          ...advanceBody('advance-dup', 'invocation-2', 1, []).transition,
          consumeSignals: [signalId, signalId],
        },
      },
      context(),
    )
    expect(duplicated.ok).toBe(false)
    if (!duplicated.ok)
      expect(duplicated.error).toMatchObject({ code: 'invalid_input', detailCode: 'signal_duplicate' })
    expect(count(path, 'events')).toBe(before)
    const consumed = unwrap(
      await store.advanceRun(
        {
          ...advanceBody('advance-consume', 'invocation-2', 1, []),
          transition: {
            ...advanceBody('advance-consume', 'invocation-2', 1, []).transition,
            consumeSignals: [signalId],
          },
        },
        context(),
      ),
      'consume',
    )
    expect(consumed.runRevision).toBe(2)
    expect(recordValue<{ consumedByCommitId: string }>(path, `signal:${signalId}`).consumedByCommitId).toBe(
      consumed.commitId,
    )
    expect(loadSides(path, consumed.commitId).map((side) => side.kind)).toEqual(['signal-consumed'])
    expect(
      recordValue<{ noProgressTransitions: number }>(path, 'run-quota:run-1').noProgressTransitions,
    ).toBe(0)
    expect(count(path, 'events')).toBe(before + 1)
    await preparedInvocation(store, 'invocation-3', 2)
    const again = await store.advanceRun(
      {
        ...advanceBody('advance-again', 'invocation-3', 2, []),
        transition: {
          ...advanceBody('advance-again', 'invocation-3', 2, []).transition,
          consumeSignals: [signalId],
        },
      },
      context(),
    )
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error).toMatchObject({ code: 'conflict', detailCode: 'signal_consumed' })
    expect(count(path, 'events')).toBe(before + 3)
    store.close()
  })

  it('claims and acknowledges an outbox event with a persistent epoch', async () => {
    const path = file()
    const clock = { ms: Date.parse(admittedAt) }
    const store = openStore(path, () => clock.ms)
    unwrap(await store.createRun(admission(), context()), 'createRun')
    unwrap(await store.open(writeOpen('open-write', 'writer-a', 600_000), context()), 'open')
    await preparedInvocation(store, 'invocation-1', 0)
    const action = preparedAction('step-1')
    unwrap(
      await store.advanceRun(advanceBody('advance-1', 'invocation-1', 0, [action]), context()),
      'advance',
    )
    const request = dispatchBody(action, 'invocation-1', 1, 'admission-1')
    const admitted = unwrap(await store.dispatchAdmission(request, context()), 'dispatch')
    if (admitted.state !== 'admitted') throw new Error('expected an admission')
    await markRunning(store, 'invocation-1', 1, request.attemptId, 'mark-1')
    unwrap(
      await store.intakeReceipt(
        intakeOf('intake-1', action, request.attemptId, admitted.authorizationId, 'receipt-1'),
        context(),
      ),
      'intake',
    )
    const destination = stableId('obxdst', authority.authorityId)
    const before = count(path, 'events')
    const empty = unwrap(
      await store.claimOutbox(
        {
          requestId: 'claim-empty',
          destination: 'other-destination',
          ownerId: 'owner-1',
          limit: 10,
          leaseMs: 1_000,
        },
        context(),
      ),
      'empty claim',
    )
    expect(empty).toEqual([])
    const claimed = unwrap(
      await store.claimOutbox(
        {
          requestId: 'claim-1',
          destination,
          ownerId: 'owner-1',
          limit: 10,
          leaseMs: 1_000,
        } satisfies ClaimOutboxRequest,
        context(),
      ),
      'claim',
    )
    expect(claimed).toHaveLength(1)
    const first = claimed[0]
    if (!first) throw new Error('missing claim')
    expect(first.claim).toMatchObject({ ownerId: 'owner-1', epoch: 1, until: '2026-04-01T00:00:01.000Z' })
    expect(first.event.delivery).toBe('claimed')
    expect(first.event.consecutiveFailures).toBe(0)
    expect(first.event.lastError).toBeNull()
    expect(first.event.eventId).toBe(first.claim.eventId)
    const replayed = unwrap(
      await store.claimOutbox(
        { requestId: 'claim-1', destination, ownerId: 'owner-1', limit: 10, leaseMs: 1_000 },
        context(),
      ),
      'claim replay',
    )
    expect(replayed).toEqual(claimed)
    expect(count(path, 'events')).toBe(before)
    const acked = unwrap(
      await store.ackOutbox(
        { requestId: 'ack-1', claim: first.claim, acknowledgement: inline({ acked: true }) },
        context(),
      ),
      'ack',
    )
    expect(acked).toEqual({ eventId: first.claim.eventId, state: 'acked' })
    const ackedAgain = unwrap(
      await store.ackOutbox(
        { requestId: 'ack-1', claim: first.claim, acknowledgement: inline({ acked: true }) },
        context(),
      ),
      'ack replay',
    )
    expect(ackedAgain).toEqual(acked)
    expect(
      query<{ n: number }>(path, "SELECT COUNT(*) AS n FROM runtime_records WHERE record_id LIKE 'outbox:%'"),
    ).toEqual([{ n: 1 }])
    expect(count(path, 'events')).toBe(before)
    store.close()
  })

  it('rejects an acknowledgement from an older claim epoch', async () => {
    const path = file()
    const clock = { ms: Date.parse(admittedAt) }
    const store = openStore(path, () => clock.ms)
    unwrap(await store.createRun(admission(), context()), 'createRun')
    unwrap(await store.open(writeOpen('open-write', 'writer-a', 600_000), context()), 'open')
    await preparedInvocation(store, 'invocation-1', 0)
    const action = preparedAction('step-1')
    unwrap(
      await store.advanceRun(advanceBody('advance-1', 'invocation-1', 0, [action]), context()),
      'advance',
    )
    const request = dispatchBody(action, 'invocation-1', 1, 'admission-1')
    const admitted = unwrap(await store.dispatchAdmission(request, context()), 'dispatch')
    if (admitted.state !== 'admitted') throw new Error('expected an admission')
    await markRunning(store, 'invocation-1', 1, request.attemptId, 'mark-1')
    unwrap(
      await store.intakeReceipt(
        intakeOf('intake-1', action, request.attemptId, admitted.authorizationId, 'receipt-1'),
        context(),
      ),
      'intake',
    )
    const destination = stableId('obxdst', authority.authorityId)
    const claimed = unwrap(
      await store.claimOutbox(
        { requestId: 'claim-1', destination, ownerId: 'owner-1', limit: 10, leaseMs: 1_000 },
        context(),
      ),
      'claim',
    )
    const stale = claimed[0]?.claim
    if (!stale) throw new Error('missing claim')
    const failed = unwrap(
      await store.failOutbox(
        {
          requestId: 'fail-1',
          claim: stale,
          error: {
            code: 'internal',
            detailCode: 'downstream',
            message: 'downstream failed',
            retryAdvice: { kind: 'never' },
            diagnosticId: 'diag-fail-1',
          },
        },
        context(),
      ),
      'fail',
    )
    expect(failed.state).toBe('pending')
    clock.ms += 1_000
    const next = unwrap(
      await store.claimOutbox(
        { requestId: 'claim-2', destination, ownerId: 'owner-2', limit: 10, leaseMs: 1_000 },
        context(),
      ),
      'reclaim',
    )
    const current = next[0]?.claim
    if (!current) throw new Error('missing reclaim')
    expect(current.epoch).toBe(2)
    expect(current.eventId).toBe(stale.eventId)
    expect(next[0]?.event.delivery).toBe('claimed')
    expect(next[0]?.event.consecutiveFailures).toBe(1)
    expect(next[0]?.event.attempts).toBe(1)
    expect(next[0]?.event.lastError).toMatchObject({ code: 'internal', detailCode: 'downstream' })
    const oldAck = await store.ackOutbox(
      { requestId: 'ack-old', claim: stale, acknowledgement: inline({ acked: true }) },
      context(),
    )
    expect(oldAck.ok).toBe(false)
    if (!oldAck.ok) expect(oldAck.error).toMatchObject({ code: 'conflict', detailCode: 'claim_epoch' })
    const acked = unwrap(
      await store.ackOutbox(
        { requestId: 'ack-current', claim: current, acknowledgement: inline({ acked: true }) },
        context(),
      ),
      'ack',
    )
    expect(acked).toEqual({ eventId: stale.eventId, state: 'acked' })
    store.close()
  })

  it('checks successful state results against the runtime schema', async () => {
    const leasedPath = file()
    const leased = openStore(leasedPath)
    expectSchema('AdmissionProbe', unwrap(await leased.createRun(admission(), context()), 'createRun'))
    expectSchema('StateOpenResult', unwrap(await leased.open(readOpen('open-read'), context()), 'read'))
    expectSchema(
      'StateLeaseResult',
      unwrap(
        await leased.lease(leaseRequest(leasedPath, 'lease-acquire', 'acquire', 'writer-a', 0), context()),
        'lease',
      ),
    )
    leased.close()

    const path = file()
    const clock = { ms: Date.parse(admittedAt) }
    const store = openStore(path, () => clock.ms)
    unwrap(await store.createRun(admission(), context()), 'createRun')
    expectSchema(
      'StateOpenResult',
      unwrap(await store.open(writeOpen('open-write', 'writer-a', 600_000), context()), 'open'),
    )
    const admittedInvocation = await preparedInvocation(store, 'invocation-1', 0)
    expectSchema('AdmitInvocationResult', admittedInvocation.admitted)
    const action = preparedAction('step-1')
    expectSchema(
      'StateCommitReceipt',
      unwrap(
        await store.advanceRun(advanceBody('advance-1', 'invocation-1', 0, [action]), context()),
        'advance',
      ),
    )
    const request = dispatchBody(action, 'invocation-1', 1, 'admission-1')
    const admitted = unwrap(await store.dispatchAdmission(request, context()), 'dispatch')
    expectSchema('DispatchAdmissionResult', admitted)
    if (admitted.state !== 'admitted') throw new Error('expected an admission')
    await markRunning(store, 'invocation-1', 1, request.attemptId, 'mark-1')
    expectSchema(
      'ReceiptIntakeResult',
      unwrap(
        await store.intakeReceipt(
          intakeOf('intake-1', action, request.attemptId, admitted.authorizationId, 'receipt-1'),
          context(),
        ),
        'intake',
      ),
    )
    const pending = publicOutbox(storedOutbox(path))
    expectSchema('OutboxRecord', pending)
    expect(pending).toMatchObject({
      delivery: 'pending',
      attempts: 0,
      consecutiveFailures: 0,
      lastError: null,
    })
    const destination = stableId('obxdst', authority.authorityId)
    const claimed = unwrap(
      await store.claimOutbox(
        { requestId: 'claim-1', destination, ownerId: 'owner-1', limit: 10, leaseMs: 1_000 },
        context(),
      ),
      'claim',
    )
    expectSchema('ClaimOutboxResult', claimed)
    expect(claimed[0]?.event).toMatchObject({
      delivery: 'claimed',
      attempts: 0,
      consecutiveFailures: 0,
      lastError: null,
    })
    const claim = claimed[0]?.claim
    if (!claim) throw new Error('missing claim')
    const error = {
      code: 'internal' as const,
      detailCode: 'downstream',
      message: 'downstream failed',
      retryAdvice: { kind: 'never' as const },
      diagnosticId: 'diag-fail-1',
    }
    const failed = unwrap(await store.failOutbox({ requestId: 'fail-1', claim, error }, context()), 'fail')
    expectSchema('FailOutboxResult', failed)
    expect(failed.state).toBe('pending')
    const live = query<{
      attempts: number
      consecutive_failures: number
      next_attempt_at: number
      ack_ref: string | null
      error_json: string
    }>(
      path,
      'SELECT attempts, consecutive_failures, next_attempt_at, ack_ref, error_json FROM runtime_outbox_delivery',
    )[0]
    if (!live) throw new Error('missing delivery')
    expectSchema('OutboxRecord', {
      ...publicOutbox(storedOutbox(path)),
      delivery: 'pending',
      attempts: live.attempts,
      consecutiveFailures: live.consecutive_failures,
      nextAttemptAt: new Date(live.next_attempt_at).toISOString(),
      claim: null,
      ackRef: live.ack_ref,
      lastError: JSON.parse(live.error_json),
    })
    clock.ms += 1_000
    const again = unwrap(
      await store.claimOutbox(
        { requestId: 'claim-2', destination, ownerId: 'owner-1', limit: 10, leaseMs: 1_000 },
        context(),
      ),
      'reclaim',
    )
    expect(again[0]?.event).toMatchObject({
      delivery: 'claimed',
      attempts: 1,
      consecutiveFailures: 1,
      lastError: error,
    })
    const current = again[0]?.claim
    if (!current) throw new Error('missing reclaim')
    expectSchema(
      'AckOutboxResult',
      unwrap(
        await store.ackOutbox(
          { requestId: 'ack-1', claim: current, acknowledgement: inline({ acked: true }) },
          context(),
        ),
        'ack',
      ),
    )
    const acked = query<{
      delivery: string
      attempts: number
      consecutive_failures: number
      error_json: string | null
      ack_ref: string | null
      next_attempt_at: number
    }>(
      path,
      'SELECT delivery, attempts, consecutive_failures, error_json, ack_ref, next_attempt_at FROM runtime_outbox_delivery',
    )[0]
    if (!acked) throw new Error('missing acknowledgement')
    expectSchema('OutboxRecord', {
      ...publicOutbox(storedOutbox(path)),
      delivery: 'acked',
      attempts: acked.attempts,
      consecutiveFailures: acked.consecutive_failures,
      nextAttemptAt: new Date(acked.next_attempt_at).toISOString(),
      claim: null,
      ackRef: acked.ack_ref,
      lastError: null,
    })
    expect(acked).toMatchObject({ delivery: 'acked', attempts: 1, consecutive_failures: 1, error_json: null })
    store.close()
    const reopened = openStore(path, () => clock.ms)
    expect((await reopened.open(readOpen('open-after-ack'), context())).ok).toBe(true)
    reopened.close()
  })

  it('dead-letters the original outbox event after 20 failures', async () => {
    const path = file()
    const clock = { ms: Date.parse(admittedAt) }
    const store = openStore(path, () => clock.ms)
    unwrap(await store.createRun(admission(), context()), 'createRun')
    unwrap(await store.open(writeOpen('open-write', 'writer-a', 600_000), context()), 'open')
    await preparedInvocation(store, 'invocation-1', 0)
    const action = preparedAction('step-1')
    unwrap(
      await store.advanceRun(advanceBody('advance-1', 'invocation-1', 0, [action]), context()),
      'advance',
    )
    const request = dispatchBody(action, 'invocation-1', 1, 'admission-1')
    const admitted = unwrap(await store.dispatchAdmission(request, context()), 'dispatch')
    if (admitted.state !== 'admitted') throw new Error('expected an admission')
    await markRunning(store, 'invocation-1', 1, request.attemptId, 'mark-1')
    unwrap(
      await store.intakeReceipt(
        intakeOf('intake-1', action, request.attemptId, admitted.authorizationId, 'receipt-1'),
        context(),
      ),
      'intake',
    )
    const destination = stableId('obxdst', authority.authorityId)
    const error = {
      code: 'internal' as const,
      detailCode: 'downstream',
      message: 'downstream failed',
      retryAdvice: { kind: 'never' as const },
      diagnosticId: 'diag-fail-1',
    }
    let eventId = ''
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const claimed = unwrap(
        await store.claimOutbox(
          { requestId: `claim-${attempt}`, destination, ownerId: 'owner-1', limit: 10, leaseMs: 1_000 },
          context(),
        ),
        `claim ${attempt}`,
      )
      const claim = claimed[0]?.claim
      const event = claimed[0]?.event
      if (!claim || !event) throw new Error(`missing claim ${attempt}`)
      eventId = claim.eventId
      expect(claim.epoch).toBe(attempt)
      expect(event.delivery).toBe('claimed')
      expect(event.attempts).toBe(attempt - 1)
      expect(event.consecutiveFailures).toBe(attempt - 1)
      expect(event.lastError).toEqual(attempt === 1 ? null : error)
      const failed = unwrap(
        await store.failOutbox({ requestId: `fail-${attempt}`, claim, error }, context()),
        `fail ${attempt}`,
      )
      if (attempt < 20) {
        const delay = Math.min(60_000, 1_000 * 2 ** (attempt - 1))
        expect(failed).toEqual({
          eventId,
          state: 'pending',
          nextAttemptAt: new Date(clock.ms + delay).toISOString(),
        })
        clock.ms += delay
      } else {
        expect(failed).toMatchObject({ eventId, state: 'dead' })
      }
    }
    const again = unwrap(
      await store.claimOutbox(
        { requestId: 'claim-after-dead', destination, ownerId: 'owner-2', limit: 10, leaseMs: 1_000 },
        context(),
      ),
      'claim after dead',
    )
    expect(again).toEqual([])
    expect(
      query<{ n: number }>(path, "SELECT COUNT(*) AS n FROM runtime_records WHERE record_id LIKE 'outbox:%'"),
    ).toEqual([{ n: 1 }])
    expect(
      query<{ delivery: string; event_id: string; attempts: number; consecutive_failures: number }>(
        path,
        'SELECT delivery, event_id, attempts, consecutive_failures FROM runtime_outbox_delivery',
      ),
    ).toEqual([{ delivery: 'dead', event_id: eventId, attempts: 20, consecutive_failures: 20 }])
    const deadRow = query<{
      next_attempt_at: number
      ack_ref: string | null
      error_json: string
    }>(path, 'SELECT next_attempt_at, ack_ref, error_json FROM runtime_outbox_delivery')[0]
    if (!deadRow) throw new Error('missing dead letter')
    const stored = storedOutbox(path)
    expectSchema('OutboxRecord', {
      ...publicOutbox(stored),
      delivery: 'dead',
      attempts: 20,
      consecutiveFailures: 20,
      nextAttemptAt: new Date(deadRow.next_attempt_at).toISOString(),
      claim: null,
      ackRef: deadRow.ack_ref,
      lastError: JSON.parse(deadRow.error_json),
    })
    store.close()
    const reopened = openStore(path, () => clock.ms)
    const opened = await reopened.open(readOpen('open-after-dead'), context())
    reopened.close()
    expect(opened.ok).toBe(true)
  })

  it('issues query tickets in memory and flushes only the unflushed delta', async () => {
    const path = file()
    const commits: CommitNotice[] = []
    const store = openStore(
      path,
      () => Date.parse(admittedAt),
      undefined,
      (commit) => commits.push(commit),
    )
    unwrap(await store.createRun(admission(), context()), 'createRun')
    unwrap(await store.open(writeOpen('open-write'), context()), 'open')
    const admitted = unwrap(
      await store.admitInvocation(
        {
          requestId: 'admit-invocation-1',
          runId: 'run-1',
          targetActionId: null,
          baseRevision: 0,
          bindingId: 'binding-1',
          writerEpoch: 1,
          invocationId: 'invocation-1',
          deadline: future,
          queryAllowance: 4,
        },
        context(),
      ),
      'admit',
    )
    expect(admitted.grantedQueries).toBe(4)
    const grantId = admitted.queryGrantId
    const before = count(path, 'events')
    const marked = commits.length
    const fingerprint = 'a'.repeat(64)
    const first = unwrap(
      await store.admitQuery(
        {
          requestId: 'query-1',
          invocationId: 'invocation-1',
          queryFingerprint: fingerprint,
        } satisfies QueryAdmission,
        context(),
      ),
      'query 1',
    )
    expect(first).toEqual({
      queryTicketId: stableId('qt', `${grantId}\0query-1`),
      remainingQueries: 3,
    })
    const second = unwrap(
      await store.admitQuery(
        { requestId: 'query-2', invocationId: 'invocation-1', queryFingerprint: fingerprint },
        context(),
      ),
      'query 2',
    )
    expect(second.remainingQueries).toBe(2)
    const replayed = unwrap(
      await store.admitQuery(
        { requestId: 'query-1', invocationId: 'invocation-1', queryFingerprint: fingerprint },
        context(),
      ),
      'query replay',
    )
    expect(replayed).toEqual(first)
    const changed = await store.admitQuery(
      { requestId: 'query-1', invocationId: 'invocation-1', queryFingerprint: 'b'.repeat(64) },
      context(),
    )
    expect(changed.ok).toBe(false)
    if (!changed.ok)
      expect(changed.error).toMatchObject({ code: 'conflict', detailCode: 'idempotency_conflict' })
    expect(count(path, 'events')).toBe(before)
    expect(commits.length).toBe(marked)
    unwrap(
      await store.closeInvocation(
        {
          requestId: 'close-invocation-1',
          invocationId: 'invocation-1',
          state: 'prepared',
          readGuards: [],
          domainReads: [],
          unresolvedInflightIds: [],
          observedQueryCount: 2,
        },
        context(),
      ),
      'close',
    )
    expect(recordValue<{ state: string; queryCount: number }>(path, 'invocation:invocation-1')).toMatchObject(
      {
        state: 'prepared',
        queryCount: 2,
      },
    )
    expect(
      recordValue<{ totalQueries: number; reservedQueries: number; settledCount: number; state: string }>(
        path,
        `grant:${grantId}`,
      ),
    ).toMatchObject({
      state: 'settled',
      flushedCount: 2,
      settledCount: 2,
    })
    expect(
      recordValue<{ totalQueries: number; reservedQueries: number }>(path, 'run-quota:run-1'),
    ).toMatchObject({
      totalQueries: 2,
      reservedQueries: 0,
    })
    const over = await store.advanceRun(
      {
        ...advanceBody('advance-over', 'invocation-1', 0, []),
        guard: {
          ...commitGuard('invocation-1', 0),
          queryUsage: { grantId, invocationId: 'invocation-1', writerEpoch: 1, cumulativeCount: 3 },
        },
      },
      context(),
    )
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.error).toMatchObject({ code: 'conflict', detailCode: 'query_count' })
    expect(recordValue<{ totalQueries: number }>(path, 'run-quota:run-1').totalQueries).toBe(2)
    const advanced = unwrap(
      await store.advanceRun(
        {
          ...advanceBody('advance-flush', 'invocation-1', 0, []),
          guard: {
            ...commitGuard('invocation-1', 0),
            queryUsage: { grantId, invocationId: 'invocation-1', writerEpoch: 1, cumulativeCount: 2 },
          },
        },
        context(),
      ),
      'flush again',
    )
    expect(advanced.runRevision).toBe(1)
    expect(recordValue<{ totalQueries: number }>(path, 'run-quota:run-1').totalQueries).toBe(2)
    store.close()
  })

  it('charges the remaining capacity when the query meter is lost', async () => {
    const path = file()
    const store = openStore(path)
    unwrap(await store.createRun(admission(), context()), 'createRun')
    unwrap(await store.open(writeOpen('open-write'), context()), 'open')
    unwrap(
      await store.admitInvocation(
        {
          requestId: 'admit-invocation-1',
          runId: 'run-1',
          targetActionId: null,
          baseRevision: 0,
          bindingId: 'binding-1',
          writerEpoch: 1,
          invocationId: 'invocation-1',
          deadline: future,
          queryAllowance: 4,
        },
        context(),
      ),
      'admit',
    )
    store.close()
    const recovered = openStore(path)
    const closed = unwrap(
      await recovered.closeInvocation(
        {
          requestId: 'close-lost',
          invocationId: 'invocation-1',
          state: 'prepared',
          readGuards: [],
          domainReads: [],
          unresolvedInflightIds: [],
          observedQueryCount: 0,
        },
        context(),
      ),
      'worst close',
    )
    expect(closed).toEqual({ invocationId: 'invocation-1', state: 'faulted' })
    const grantId = stableId('qg', 'invocation-1')
    expect(recordValue<{ settledCount: number; state: string }>(path, `grant:${grantId}`)).toMatchObject({
      state: 'settled',
      settledCount: 4,
    })
    expect(
      recordValue<{ totalQueries: number; failedInvocations: number }>(path, 'run-quota:run-1'),
    ).toMatchObject({
      totalQueries: 4,
      reservedQueries: 0,
      failedInvocations: 1,
    })
    const events = count(path, 'events')
    const replayed = unwrap(
      await recovered.closeInvocation(
        {
          requestId: 'close-lost',
          invocationId: 'invocation-1',
          state: 'prepared',
          readGuards: [],
          domainReads: [],
          unresolvedInflightIds: [],
          observedQueryCount: 0,
        },
        context(),
      ),
      'replay worst close',
    )
    expect(replayed).toEqual(closed)
    expect(count(path, 'events')).toBe(events)
    expect(recordValue<{ totalQueries: number }>(path, 'run-quota:run-1').totalQueries).toBe(4)
    const refused = await recovered.admitQuery(
      { requestId: 'query-late', invocationId: 'invocation-1', queryFingerprint: 'a'.repeat(64) },
      context(),
    )
    expect(refused.ok).toBe(false)
    recovered.close()
  })

  it('fails open when publication sides, the ready view, or an outbox epoch is damaged', async () => {
    const published = async () => {
      const path = file()
      const store = openStore(path)
      unwrap(await store.createRun(admission(), context()), 'createRun')
      unwrap(await store.open(writeOpen('open-write'), context()), 'open')
      await preparedInvocation(store, 'invocation-1', 0)
      const action = preparedAction('step-1')
      unwrap(
        await store.advanceRun(advanceBody('advance-1', 'invocation-1', 0, [action]), context()),
        'advance',
      )
      const request = dispatchBody(action, 'invocation-1', 1, 'admission-1')
      const admitted = unwrap(await store.dispatchAdmission(request, context()), 'dispatch')
      if (admitted.state !== 'admitted') throw new Error('expected an admission')
      await markRunning(store, 'invocation-1', 1, request.attemptId, 'mark-1')
      unwrap(
        await store.intakeReceipt(
          intakeOf('intake-1', action, request.attemptId, admitted.authorizationId, 'receipt-1'),
          context(),
        ),
        'intake',
      )
      const signalId = stableId('sig', 'authority-1\0receipt-1\0run')
      await preparedInvocation(store, 'invocation-2', 1)
      const consumed = unwrap(
        await store.advanceRun(
          {
            ...advanceBody('advance-consume', 'invocation-2', 1, []),
            transition: {
              ...advanceBody('advance-consume', 'invocation-2', 1, []).transition,
              consumeSignals: [signalId],
            },
          },
          context(),
        ),
        'consume',
      )
      store.close()
      const visibility = recordValue<{ publishedByCommitId: string }>(path, 'visibility:receipt-1')
      return { path, commitId: visibility.publishedByCommitId, consumedId: consumed.commitId, signalId }
    }

    const missingSide = await published()
    mutate(missingSide.path, (db) => {
      db.prepare("DELETE FROM runtime_side_entries WHERE kind = 'receipt-created'").run()
    })
    const opened = openStore(missingSide.path)
    const refused = await opened.open(readOpen('open-missing-receipt-side'), context())
    opened.close()
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.message).toBe('side list digest does not match entries')

    const usage = await published()
    replaceSides(
      usage.path,
      usage.commitId,
      loadSides(usage.path, usage.commitId).filter((side) => side.kind !== 'usage-origin'),
    )
    const usageOpen = openStore(usage.path)
    const usageRefused = await usageOpen.open(readOpen('open-missing-usage'), context())
    usageOpen.close()
    expect(usageRefused.ok).toBe(false)
    if (!usageRefused.ok)
      expect(usageRefused.error.message).toBe('usage origin side entry does not match the usage mirror')

    const outbox = await published()
    replaceSides(
      outbox.path,
      outbox.commitId,
      loadSides(outbox.path, outbox.commitId).filter((side) => side.kind !== 'outbox-created'),
    )
    const outboxOpen = openStore(outbox.path)
    const outboxRefused = await outboxOpen.open(readOpen('open-missing-outbox'), context())
    outboxOpen.close()
    expect(outboxRefused.ok).toBe(false)
    if (!outboxRefused.ok)
      expect(outboxRefused.error.message).toBe('outbox creation side entry does not match the outbox')

    const doubled = await published()
    const extra: CommitSideEntry = {
      commitId: doubled.commitId,
      kind: 'signal-consumed',
      signalId: doubled.signalId,
    }
    replaceSides(doubled.path, doubled.commitId, [...loadSides(doubled.path, doubled.commitId), extra])
    const doubleOpen = openStore(doubled.path)
    const doubleRefused = await doubleOpen.open(readOpen('open-double-signal'), context())
    doubleOpen.close()
    expect(doubleRefused.ok).toBe(false)
    if (!doubleRefused.ok) expect(doubleRefused.error.message).toBe('signal was consumed more than once')

    const origin = await published()
    const duplicateOrigin: CommitSideEntry = {
      commitId: origin.consumedId,
      kind: 'usage-origin',
      sourceAuthorityId: authority.authorityId,
      originKey: 'origin-1',
    }
    replaceSides(origin.path, origin.consumedId, [
      ...loadSides(origin.path, origin.consumedId),
      duplicateOrigin,
    ])
    const originOpen = openStore(origin.path)
    const originRefused = await originOpen.open(readOpen('open-double-origin'), context())
    originOpen.close()
    expect(originRefused.ok).toBe(false)
    if (!originRefused.ok) expect(originRefused.error.message).toBe('usage origin was recorded twice')

    const view = await published()
    mutate(view.path, (db) => {
      const recordId = 'visibility:receipt-1'
      const head = db
        .prepare('SELECT owner_json, value_json FROM runtime_records WHERE record_id = ?')
        .get(recordId) as {
        owner_json: string
        value_json: string
      }
      const value = JSON.parse(head.value_json) as { result: { outcome: string } }
      value.result.outcome = 'failed'
      const owner = JSON.parse(head.owner_json) as RecordOwner
      const digest = bodyDigest(owner, value)
      const valueJson = canonicalJson(value)
      db.prepare('UPDATE runtime_records SET value_json = ?, body_digest = ? WHERE record_id = ?').run(
        valueJson,
        digest,
        recordId,
      )
      db.prepare('UPDATE runtime_record_versions SET value_json = ?, digest = ? WHERE record_id = ?').run(
        valueJson,
        digest,
        recordId,
      )
      const manifests = db
        .prepare(
          'SELECT record_id, previous_revision, next_json FROM runtime_mutation_manifests WHERE commit_id = ?',
        )
        .all(view.commitId) as {
        record_id: string
        previous_revision: number | null
        next_json: string | null
      }[]
      const decoded: CommitMutationManifest[] = manifests.map((row) => {
        const next =
          row.next_json === null ? null : (JSON.parse(row.next_json) as CommitMutationManifest['next'])
        if (next && row.record_id === recordId) {
          next.digest = digest
          db.prepare(
            'UPDATE runtime_mutation_manifests SET next_json = ? WHERE commit_id = ? AND record_id = ?',
          ).run(canonicalJson(next), view.commitId, row.record_id)
        }
        return {
          commitId: view.commitId,
          recordId: row.record_id,
          previousRevision: row.previous_revision,
          next,
        }
      })
      const event = commitEvent(view.path, view.commitId)
      event.data.mutationsDigest = mutationDigest(decoded)
      saveCommitEvent(view.path, event.seq, event.data)
    })
    rehashSession(view.path)
    const viewOpen = openStore(view.path)
    const viewRefused = await viewOpen.open(readOpen('open-view-mismatch'), context())
    viewOpen.close()
    expect(viewRefused.ok).toBe(false)
    if (!viewRefused.ok) expect(viewRefused.error.message).toBe('ready view does not match the receipt')

    const acked = await published()
    const destination = stableId('obxdst', authority.authorityId)
    const claimStore = openStore(acked.path)
    const claimed = unwrap(
      await claimStore.claimOutbox(
        { requestId: 'claim-1', destination, ownerId: 'owner-1', limit: 10, leaseMs: 1_000 },
        context(),
      ),
      'claim',
    )
    const claim = claimed[0]?.claim
    if (!claim) throw new Error('missing claim')
    unwrap(
      await claimStore.ackOutbox(
        { requestId: 'ack-1', claim, acknowledgement: inline({ acked: true }) },
        context(),
      ),
      'ack',
    )
    claimStore.close()
    mutate(acked.path, (db) => {
      db.prepare("UPDATE runtime_outbox_delivery SET acked_epoch = NULL WHERE delivery = 'acked'").run()
    })
    const epochOpen = openStore(acked.path)
    const epochRefused = await epochOpen.open(readOpen('open-ack-without-epoch'), context())
    epochOpen.close()
    expect(epochRefused.ok).toBe(false)
    if (!epochRefused.ok) expect(epochRefused.error.message).toBe('outbox acknowledgement has no claim epoch')
  })

  it('fails open when a rejection commit drops its completion', async () => {
    const { path, store } = await leasedRun()
    await preparedInvocation(store, 'invocation-1', 0)
    const action = preparedAction('step-1')
    unwrap(
      await store.advanceRun(advanceBody('advance-1', 'invocation-1', 0, [action]), context()),
      'advance',
    )
    const rejected = unwrap(
      await store.dispatchAdmission(
        dispatchBody(action, 'invocation-1', 1, 'admission-old', [], past),
        context(),
      ),
      'expired',
    )
    if (rejected.state !== 'rejected') throw new Error('expected a rejection')
    store.close()
    replaceSides(
      path,
      rejected.commitId,
      loadSides(path, rejected.commitId).filter((side) => side.kind !== 'outbox-created'),
    )
    const reopened = openStore(path)
    const opened = await reopened.open(readOpen('open-rejection-without-outbox'), context())
    reopened.close()
    expect(opened.ok).toBe(false)
    if (!opened.ok) expect(opened.error.message).toBe('rejected admission does not publish a completion')
  })

  it('refuses open when an acceleration index or quota ref does not match the records', async () => {
    async function intakeOnce(): Promise<string> {
      const { path, store } = await leasedRun()
      await preparedInvocation(store, 'invocation-1', 0)
      const action = preparedAction('step-1')
      unwrap(
        await store.advanceRun(advanceBody('advance-1', 'invocation-1', 0, [action]), context()),
        'advance',
      )
      const request = dispatchBody(action, 'invocation-1', 1, 'admission-1')
      const admitted = unwrap(await store.dispatchAdmission(request, context()), 'dispatch')
      if (admitted.state !== 'admitted') throw new Error('expected an admission')
      await markRunning(store, 'invocation-1', 1, request.attemptId, 'mark-1')
      unwrap(
        await store.intakeReceipt(
          intakeOf('intake-1', action, request.attemptId, admitted.authorizationId, 'receipt-1'),
          context(),
        ),
        'intake',
      )
      store.close()
      return path
    }

    const bumped = await intakeOnce()
    expect(query<{ next_seq: number }>(bumped, 'SELECT next_seq FROM runtime_signal_seq')).toEqual([
      { next_seq: 2 },
    ])
    mutate(bumped, (db) => {
      db.prepare('UPDATE runtime_signal_seq SET next_seq = next_seq + 1').run()
    })
    const bumpOpen = openStore(bumped)
    const bumpRefused = await bumpOpen.open(readOpen('open-signal-seq'), context())
    bumpOpen.close()
    expect(bumpRefused.ok).toBe(false)
    if (!bumpRefused.ok)
      expect(bumpRefused.error.message).toBe('signal sequence index does not match the records')

    const removed = await intakeOnce()
    mutate(removed, (db) => {
      db.prepare('DELETE FROM runtime_signal_seq').run()
    })
    const removedOpen = openStore(removed)
    const removedRefused = await removedOpen.open(readOpen('open-signal-seq-missing'), context())
    removedOpen.close()
    expect(removedRefused.ok).toBe(false)
    if (!removedRefused.ok)
      expect(removedRefused.error.message).toBe('signal sequence index does not match the records')

    const { path: activePath, store: activeStore } = await leasedRun()
    unwrap(
      await activeStore.admitInvocation(
        {
          requestId: 'admit-invocation-1',
          runId: 'run-1',
          targetActionId: null,
          baseRevision: 0,
          bindingId: 'binding-1',
          writerEpoch: 1,
          invocationId: 'invocation-1',
          deadline: future,
          queryAllowance: 0,
        },
        context(),
      ),
      'admit',
    )
    expect(
      query<{ invocation_id: string }>(activePath, 'SELECT invocation_id FROM runtime_active_invocation'),
    ).toEqual([{ invocation_id: 'invocation-1' }])
    activeStore.close()
    mutate(activePath, (db) => {
      db.prepare('DELETE FROM runtime_active_invocation').run()
    })
    const activeOpen = openStore(activePath)
    const activeRefused = await activeOpen.open(readOpen('open-active-invocation'), context())
    activeOpen.close()
    expect(activeRefused.ok).toBe(false)
    if (!activeRefused.ok)
      expect(activeRefused.error.message).toBe('active invocation index does not match the records')

    const held = await leasedRun()
    await preparedInvocation(held.store, 'invocation-1', 0)
    const heldAction = preparedAction('step-1')
    unwrap(
      await held.store.advanceRun(advanceBody('advance-1', 'invocation-1', 0, [heldAction]), context()),
      'advance',
    )
    const heldRequest = dispatchBody(heldAction, 'invocation-1', 1, 'admission-1', [
      { name: 'parallel-action', amount: 1 },
    ])
    const heldAdmission = unwrap(await held.store.dispatchAdmission(heldRequest, context()), 'dispatch')
    expect(heldAdmission.state).toBe('admitted')
    held.store.close()
    const quota = recordValue<{ activeQuotaReservationRefs: string[] }>(held.path, 'run-quota:run-1')
    expect(quota.activeQuotaReservationRefs).toEqual([stableId('qr', 'admission-1')])
    rewriteRecord(held.path, 'run-quota:run-1', { ...quota, activeQuotaReservationRefs: [] })
    const quotaOpen = openStore(held.path)
    const quotaRefused = await quotaOpen.open(readOpen('open-quota-ref'), context())
    quotaOpen.close()
    expect(quotaRefused.ok).toBe(false)
    if (!quotaRefused.ok)
      expect(quotaRefused.error.message).toBe('active quota reservation does not match the held mirror')

    const dangling = await leasedRun()
    await preparedInvocation(dangling.store, 'invocation-1', 0)
    const first = preparedAction('step-1')
    unwrap(
      await dangling.store.advanceRun(advanceBody('advance-1', 'invocation-1', 0, [first]), context()),
      'advance',
    )
    unwrap(
      await dangling.store.dispatchAdmission(
        dispatchBody(first, 'invocation-1', 1, 'admission-1', [{ name: 'parallel-action', amount: 1 }]),
        context(),
      ),
      'hold',
    )
    await preparedInvocation(dangling.store, 'invocation-2', 1)
    const second = preparedAction('step-2')
    unwrap(
      await dangling.store.advanceRun(advanceBody('advance-2', 'invocation-2', 1, [second]), context()),
      'advance 2',
    )
    const current = recordValue<{ activeQuotaReservationRefs: string[] }>(dangling.path, 'run-quota:run-1')
    // Rebuild every source digest, version and manifest so this probes the
    // quota relationship itself instead of failing at the earlier body gate.
    rewriteRecord(dangling.path, 'run-quota:run-1', {
      ...current,
      activeQuotaReservationRefs: [...current.activeQuotaReservationRefs, 'missing'],
    })
    dangling.store.close()
    const danglingReopened = openStore(dangling.path)
    const missing = await danglingReopened.dispatchAdmission(
      dispatchBody(second, 'invocation-2', 2, 'admission-2', [{ name: 'parallel-action', amount: 1 }]),
      context(),
    )
    expect(missing.ok).toBe(false)
    if (!missing.ok) {
      expect(missing.error).toMatchObject({ code: 'incompatible', detailCode: 'integrity' })
      expect(missing.error.message).toBe('active quota reservation does not match the held mirror')
    }
    danglingReopened.close()
  })

  it('pins every commit in a tool round and drains that round’s outbox', async () => {
    const path = file()
    const commits: CommitNotice[] = []
    const store = openStore(
      path,
      () => Date.parse(admittedAt),
      undefined,
      (commit) => commits.push(commit),
    )
    unwrap(await store.createRun(admission(), context()), 'createRun')
    unwrap(await store.open(writeOpen('open-write'), context()), 'open')
    await preparedInvocation(store, 'invocation-1', 0)
    const action = preparedAction('step-1')
    unwrap(
      await store.advanceRun(advanceBody('advance-create', 'invocation-1', 0, [action]), context()),
      'create',
    )
    const request = dispatchBody(action, 'invocation-1', 1, 'admission-1')
    const admitted = unwrap(await store.dispatchAdmission(request, context()), 'dispatch')
    if (admitted.state !== 'admitted') throw new Error('expected an admission')
    await markRunning(store, 'invocation-1', 1, request.attemptId, 'mark-running')
    const intake = intakeOf('intake-1', action, request.attemptId, admitted.authorizationId, 'receipt-1')
    unwrap(await store.intakeReceipt(intake, context()), 'intake')
    await preparedInvocation(store, 'invocation-2', 1)
    const signalId = stableId('sig', 'authority-1\0receipt-1\0run')
    unwrap(
      await store.advanceRun(
        {
          ...advanceBody('advance-consume', 'invocation-2', 1, []),
          transition: {
            ...advanceBody('advance-consume', 'invocation-2', 1, []).transition,
            consumeSignals: [signalId],
          },
        },
        context(),
      ),
      'consume',
    )
    const destination = stableId('obxdst', authority.authorityId)
    const claimed = unwrap(
      await store.claimOutbox(
        { requestId: 'claim-1', destination, ownerId: 'owner-1', limit: 10, leaseMs: 1_000 },
        context(),
      ),
      'claim',
    )
    const claim = claimed[0]?.claim
    if (!claim) throw new Error('missing claim')
    unwrap(
      await store.ackOutbox(
        { requestId: 'ack-1', claim, acknowledgement: inline({ acked: true }) },
        context(),
      ),
      'ack',
    )
    const drained = unwrap(
      await store.claimOutbox(
        { requestId: 'claim-after', destination, ownerId: 'owner-1', limit: 10, leaseMs: 1_000 },
        context(),
      ),
      'drained',
    )
    expect(drained).toEqual([])
    store.close()
    // Tool window: dispatch, mark_running, intake. Three wrote commits.
    // Eight more wrote commits belong to the round, so the round is eleven.
    // The initial run and immutable write-open proof each add one real wrote
    // commit outside the eleven-commit round. The empty
    // claim after acknowledgement is recorded and does not count.
    expect(commits).toEqual([
      { method: 'createRun', requestId: 'ticket-1', wrote: true },
      { method: 'open', requestId: 'open-write', wrote: true },
      { method: 'admitInvocation', requestId: 'admit-invocation-1', wrote: true },
      { method: 'closeInvocation', requestId: 'close-invocation-1', wrote: true },
      { method: 'advanceRun', requestId: 'advance-create', wrote: true },
      { method: 'dispatchAdmission', requestId: 'admission-1', wrote: true },
      { method: 'commitControl', requestId: 'mark-running', wrote: true },
      { method: 'intakeReceipt', requestId: 'intake-1', wrote: true },
      { method: 'admitInvocation', requestId: 'admit-invocation-2', wrote: true },
      { method: 'closeInvocation', requestId: 'close-invocation-2', wrote: true },
      { method: 'advanceRun', requestId: 'advance-consume', wrote: true },
      { method: 'claimOutbox', requestId: 'claim-1', wrote: true },
      { method: 'ackOutbox', requestId: 'ack-1', wrote: true },
      { method: 'claimOutbox', requestId: 'claim-after', wrote: false },
    ])
    const round = commits.filter((commit) => commit.method !== 'createRun' && commit.method !== 'open')
    const tool = round.filter(
      (commit) =>
        commit.method === 'dispatchAdmission' ||
        commit.method === 'commitControl' ||
        commit.method === 'intakeReceipt',
    )
    expect(tool).toEqual([
      { method: 'dispatchAdmission', requestId: 'admission-1', wrote: true },
      { method: 'commitControl', requestId: 'mark-running', wrote: true },
      { method: 'intakeReceipt', requestId: 'intake-1', wrote: true },
    ])
    expect(round.filter((commit) => commit.wrote)).toHaveLength(11)
    expect(commits.filter((commit) => commit.wrote)).toHaveLength(13)
    expect(
      query(
        path,
        "SELECT (SELECT COUNT(*) FROM events WHERE type='runtime/state-commit') + (SELECT COUNT(*) FROM runtime_aux_commits) AS n",
      ),
    ).toEqual([{ n: 13 }])
    const delivery = query<{ delivery: string; acked_epoch: number | null }>(
      path,
      'SELECT delivery, acked_epoch FROM runtime_outbox_delivery',
    )
    expect(delivery.length).toBeGreaterThan(0)
    expect(delivery.every((row) => row.delivery === 'acked' && (row.acked_epoch ?? 0) >= 1)).toBe(true)
    expect(
      query<{ n: number }>(
        path,
        "SELECT COUNT(*) AS n FROM runtime_outbox_delivery WHERE delivery IN ('pending', 'claimed', 'dead')",
      ),
    ).toEqual([{ n: 0 }])
  })
})
