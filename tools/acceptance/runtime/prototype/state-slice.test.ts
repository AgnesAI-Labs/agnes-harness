import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultIds, openTracked } from '../../../../packages/core/src/index.ts'
import type {
  AdvanceRunRequest,
  CallContext,
  CloseInvocationRequest,
  CommitControlRequest,
  CommitGuard,
  DispatchAdmissionRequest,
  InvocationAdmission,
  Outcome,
  PreparedAction,
  RunAdmission,
  StateAuthorityRef,
} from '../../../../packages/extension-api/src/runtime/index.ts'
import { createSqliteStorage } from '../../../../packages/host/src/adapters/storage-sqlite.ts'
import {
  createRuntimeStateStore,
  type RuntimeStateStore,
  UNIMPLEMENTED_STATE_METHODS,
} from '../../../../packages/host/src/runtime/providers/state.ts'
import { canonicalJson } from '../../../../packages/host/src/runtime/state/canonical-json.ts'
import {
  bodyDigest,
  type CommitMutationManifest,
  digestOf as canonicalDigest,
  emptyIntegrity,
  type LedgerEvent,
  mutationDigest,
  protectEvent,
  type RecordOwner,
  sideListsDigest,
} from '../../../../packages/host/src/runtime/state/records.ts'
import { jcs } from '../../../../packages/protocol/src/jcs.ts'

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

function openStore(
  path: string,
  now = () => Date.parse(admittedAt),
  beforeCommit?: () => void,
): RuntimeStateStore {
  return createRuntimeStateStore({ file: path, authority, now, ...(beforeCommit ? { beforeCommit } : {}) })
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
    expectedLastSeq: 2,
    ttlMs,
  }
}

async function refuseDamaged(path: string, requestId: string): Promise<void> {
  const reopened = openStore(path)
  const opened = await reopened.open(writeOpen(requestId), context())
  reopened.close()
  expect(opened.ok).toBe(false)
  if (opened.ok) expect(opened.value.snapshot).toBeUndefined()
  if (!opened.ok) expect(opened.error).toMatchObject({ code: 'incompatible', detailCode: 'integrity' })
  expect(query<{ writer_id: string | null }>(path, 'SELECT writer_id FROM runtime_leases')).toEqual([])
}

afterEach(() => {
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
    const store = openStore(path)
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
    expect(data.mutationCount).toBe(3)
    expect(count(path, 'runtime_mutation_manifests')).toBe(3)
    expect(count(path, 'runtime_side_entries')).toBe(0)
    expect(count(path, 'runtime_record_versions')).toBe(3)
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
        expectedLastSeq: 2,
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
        expectedLastSeq: 2,
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
        expectedLastSeq: 2,
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
        expectedLastSeq: 2,
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
        expectedLastSeq: 2,
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
    expect(query<{ writer_id: string | null }>(path, 'SELECT writer_id FROM runtime_leases')).toEqual([])
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
    await refuseDamaged(path, 'open-reader')
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
    expect(query<{ writer_id: string | null }>(path, 'SELECT writer_id FROM runtime_leases')).toEqual([])
  })

  it('returns the original write-open result for the same request', async () => {
    const path = file()
    const store = openStore(path)
    expect((await store.createRun(admission(), context())).ok).toBe(true)
    const request = writeOpen('open-write')
    const first = await store.open(request, context())
    const second = await store.open(request, context())
    const changed = await store.open(writeOpen('open-write', 'writer-b'), context())
    store.close()
    expect(first.ok).toBe(true)
    expect(second).toEqual(first)
    expect(changed.ok).toBe(false)
    if (!changed.ok) expect(changed.error.detailCode).toBe('idempotency_conflict')
    expect(query<{ n: number }>(path, 'SELECT COUNT(*) AS n FROM runtime_leases')).toEqual([{ n: 1 }])
  })

  it('returns the original lease for the same acquire request', async () => {
    const path = file()
    const store = openStore(path)
    expect((await store.createRun(admission(), context())).ok).toBe(true)
    const request = leaseRequest('lease-acquire', 'acquire', 'writer-a', 0)
    const first = await store.lease(request, context())
    const second = await store.lease(request, context())
    const changed = await store.lease(leaseRequest('lease-acquire', 'acquire', 'writer-b', 0), context())
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
    expect((await store.lease(leaseRequest('lease-acquire', 'acquire', 'writer-a', 0), context())).ok).toBe(
      true,
    )
    const request = leaseRequest('lease-renew', 'renew', 'writer-a', 1, 5_000)
    const first = await store.lease(request, context())
    now += 1
    const second = await store.lease(request, context())
    const changed = await store.lease(leaseRequest('lease-renew', 'renew', 'writer-a', 1, 9_000), context())
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
    if (continued.ok && continued.value.state === 'created') expect(continued.value.commit.lastSeq).toBe(3)
    expect(damaged.ok).toBe(false)
    if (!damaged.ok) expect(damaged.error).toMatchObject({ code: 'incompatible', detailCode: 'integrity' })
    expect(
      query<{ writer_id: string | null }>(
        path,
        "SELECT writer_id FROM runtime_leases WHERE scope_id = 'session-2'",
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
    expect(query<{ writer_id: string | null }>(path, 'SELECT writer_id FROM runtime_leases')).toEqual([])
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

  it('leaves an uncovered record head for the next open', async () => {
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
    expect(continued.ok).toBe(true)
    if (continued.ok && continued.value.state === 'created') expect(continued.value.commit.lastSeq).toBe(3)
    expect(opened.ok).toBe(false)
    if (!opened.ok) expect(opened.error).toMatchObject({ code: 'incompatible', detailCode: 'integrity' })
    expect(query<{ writer_id: string | null }>(path, 'SELECT writer_id FROM runtime_leases')).toEqual([])
  })

  it('leaves a changed record reader for the next open', async () => {
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
    expect(continued.ok).toBe(true)
    expect(opened.ok).toBe(false)
    if (!opened.ok) expect(opened.error).toMatchObject({ code: 'incompatible', detailCode: 'integrity' })
    expect(query<{ writer_id: string | null }>(path, 'SELECT writer_id FROM runtime_leases')).toEqual([])
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
    expect(query<{ writer_id: string | null }>(path, 'SELECT writer_id FROM runtime_leases')).toEqual([])
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
          "SELECT result_json FROM runtime_request_results WHERE method = 'open' AND request_id = 'open-write'",
        )
        .get() as { result_json: string }
      const result = JSON.parse(row.result_json) as { claim: { writerEpoch: number } }
      result.claim.writerEpoch = 42
      db.prepare(
        "UPDATE runtime_request_results SET result_json = ? WHERE method = 'open' AND request_id = 'open-write'",
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
    const request = leaseRequest('lease-acquire', 'acquire', 'writer-a', 0)
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
    expect(query<{ writer_id: string | null }>(path, 'SELECT writer_id FROM runtime_leases')).toEqual([])
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

function recordValue<T>(path: string, recordId: string): T {
  const rows = query<{ value_json: string }>(
    path,
    `SELECT value_json FROM runtime_records WHERE record_id = '${recordId}'`,
  )
  if (!rows[0]) throw new Error(`missing record ${recordId}`)
  return JSON.parse(rows[0].value_json) as T
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
  it('continues a run, admits an action, and marks the attempt running', async () => {
    const { path, store } = await leasedRun()
    expect(count(path, 'runtime_records')).toBe(3)
    const prepared = await preparedInvocation(store, 'invocation-1', 0, 1_000)
    expect(prepared.admitted).toMatchObject({
      prepareId: stableId('prep', 'run-1\0invocation-1'),
      invocationId: 'invocation-1',
      queryGrantId: stableId('qg', 'invocation-1'),
      grantedQueries: 128,
      remainingQueries: 65_536 - 128,
    })
    expect(prepared.closed).toEqual({ invocationId: 'invocation-1', state: 'prepared' })
    expect(count(path, 'runtime_records')).toBe(7)
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
    if (!signal.ok) expect(signal.error.message).toBe('signal consumption is not implemented')
    expect(conversation.ok).toBe(false)
    if (!conversation.ok)
      expect(conversation.error.message).toBe('conversation contribution is not implemented')
    expect(failed.ok).toBe(false)
    if (!failed.ok)
      expect(failed.error.message).toBe('wait, complete, and fail transitions are not implemented')
    expect(flushed.ok).toBe(false)
    if (!flushed.ok) expect(flushed.error.message).toBe('query usage flush is not implemented')
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

  it('does not publish a ready view, result fact, or completion signal for a rejection', async () => {
    // A rejected admission settles the action and stores one receipt. It does not publish the
    // no-hook ready view, the unique result fact, or the completion signal. Receipt intake has to
    // publish those three together, and this rejection has to use that same publication in its
    // admission transaction so the action cannot remain settled without a completion signal.
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
    expect(rejected).toMatchObject({ state: 'rejected', reason: 'expired' })
    store.close()
    expect(query<{ kind: string }>(path, 'SELECT kind FROM runtime_side_entries ORDER BY kind')).toEqual([
      { kind: 'action-created' },
      { kind: 'receipt-created' },
    ])
    const ids = query<{ record_id: string }>(path, 'SELECT record_id FROM runtime_records').map(
      (row) => row.record_id,
    )
    expect(ids.some((id) => /^(outbox:|signal:|visibility:|result:|ready:)/.test(id))).toBe(false)
    expect(recordValue<{ state: string }>(path, `action:${stableId('act', 'run-1\0step-1')}`).state).toBe(
      'settled',
    )
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
         ) VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?, ?)`,
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
    expect(query<{ writer_id: string | null }>(path, 'SELECT writer_id FROM runtime_leases')).toEqual([
      { writer_id: 'writer-a' },
    ])
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
