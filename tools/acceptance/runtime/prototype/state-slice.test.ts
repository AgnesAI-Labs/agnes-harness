import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultIds, openTracked } from '../../../../packages/core/src/index.ts'
import type {
  CallContext,
  Outcome,
  RunAdmission,
  StateAuthorityRef,
} from '../../../../packages/extension-api/src/runtime/index.ts'
import { createSqliteStorage } from '../../../../packages/host/src/adapters/storage-sqlite.ts'
import {
  createRuntimeStateStore,
  type RuntimeStateStore,
  UNIMPLEMENTED_STATE_METHODS,
} from '../../../../packages/host/src/runtime/providers/state.ts'
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
