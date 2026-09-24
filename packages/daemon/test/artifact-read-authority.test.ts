import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteStorage, type TableHandle as HostTableHandle } from '@agnes/host'
import { describe, expect, it, vi } from 'vitest'
import {
  type ArtifactAuthorityBinding,
  createArtifactReadAuthorityPort,
  PersistentArtifactReadAuthorityIndex,
} from '../src/local/artifact-read-authority.js'
import type { TableHandle } from '../src/storage/table.js'
import { sqliteTables } from './sqlite-tables.js'

function adaptHostTable(table: HostTableHandle): TableHandle {
  return {
    exec(sql, params = []) {
      if (params.length > 0) table.run(sql, params)
      else table.exec(sql)
    },
    get: <T>(sql: string, params: unknown[] = []) => table.get<T>(sql, params),
    all: <T>(sql: string, params: unknown[] = []) => table.all<T>(sql, params),
    transaction: <T>(fn: () => T) => table.transaction(fn),
  }
}

const ref = (text: string, mime = 'application/octet-stream') => {
  const bytes = new TextEncoder().encode(text)
  return Object.freeze({
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength,
    mime,
  })
}

const first = ref('first')
const second = ref('second', 'image/png')
const binding = (artifact = first): ArtifactAuthorityBinding =>
  Object.freeze({ sessionId: 'session-a', laneId: 'lane-a', ownerId: 'owner-a', artifact })
const writer = (permission: 'append' | 'replace') =>
  Object.freeze({ permission, sessionId: 'session-a', laneId: 'lane-a', principalId: 'owner-a' })

describe('durable artifact read authority index', () => {
  it('persists the complete session/lane/owner/artifact binding across reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agnes-artifact-authority-'))
    const file = join(directory, 'index.sqlite')
    try {
      const initialTables = sqliteTables(file)
      const initial = new PersistentArtifactReadAuthorityIndex(initialTables.table('artifact-read-authority'))
      expect(initial.append(writer('append'), binding())).toEqual({ ok: true, code: 'appended' })
      expect(initial.append(writer('append'), binding())).toEqual({ ok: true, code: 'already_present' })
      await initialTables.close()

      const reopenedTables = sqliteTables(file)
      const reopened = new PersistentArtifactReadAuthorityIndex(
        reopenedTables.table('artifact-read-authority'),
      )
      expect(reopened.resolve('session-a', 'lane-a', first.sha256)).toEqual(binding())
      expect(reopened.resolve('session-b', 'lane-a', first.sha256)).toBeUndefined()
      await reopenedTables.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('initializes and reopens through the production package-table adapter without PRAGMA', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agnes-artifact-authority-host-'))
    const open = () =>
      createSqliteStorage({
        file: join(directory, 'sessions.sqlite'),
        tablesDir: join(directory, 'tables'),
      })
    let storage = open()
    try {
      const initial = new PersistentArtifactReadAuthorityIndex(
        adaptHostTable(
          storage.tables('@agnes/daemon/artifact-read-authority-test').table('artifact_read_authority'),
        ),
      )
      expect(initial.append(writer('append'), binding())).toEqual({ ok: true, code: 'appended' })
      await storage.close()

      storage = open()
      const owner = storage
        .tables('@agnes/daemon/artifact-read-authority-test')
        .table('artifact_read_authority')
      const reopened = new PersistentArtifactReadAuthorityIndex(adaptHostTable(owner))
      expect(reopened.resolve('session-a', 'lane-a', first.sha256)).toEqual(binding())
      owner.exec(
        `CREATE TEMP TRIGGER artifact_read_authority_temp_mutate
         AFTER DELETE ON artifact_read_authority_v1
         BEGIN UPDATE artifact_read_authority_v1 SET owner_id = 'attacker'; END`,
      )
      expect(reopened.replace(writer('replace'), binding(), binding(second))).toEqual({
        ok: false,
        code: 'storage_unavailable',
      })
      expect(
        owner.get<{ owner_id: unknown; sha256: unknown }>(
          'SELECT owner_id, sha256 FROM artifact_read_authority_v1 WHERE session_id = ? AND lane_id = ?',
          ['session-a', 'lane-a'],
        ),
      ).toEqual({ owner_id: 'owner-a', sha256: first.sha256 })
    } finally {
      await storage.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('enforces append and replace authority without crossing session, lane, or owner', () => {
    const tables = sqliteTables()
    const index = new PersistentArtifactReadAuthorityIndex(tables.table('artifact-read-authority'))

    expect(index.append(writer('replace'), binding())).toMatchObject({ ok: false, code: 'forbidden' })
    for (const authority of [
      { ...writer('append'), sessionId: 'session-b' },
      { ...writer('append'), laneId: 'lane-b' },
      { ...writer('append'), principalId: 'owner-b' },
    ]) {
      expect(index.append(authority, binding())).toMatchObject({ ok: false, code: 'forbidden' })
    }
    expect(index.resolve('session-a', 'lane-a', first.sha256)).toBeUndefined()

    expect(index.append(writer('append'), binding())).toMatchObject({ ok: true, code: 'appended' })
    const otherLaneWriter = {
      permission: 'append',
      sessionId: 'session-a',
      laneId: 'lane-b',
      principalId: 'owner-b',
    }
    const otherLane = { ...binding(), laneId: 'lane-b', ownerId: 'owner-b' }
    expect(index.append(otherLaneWriter, otherLane)).toMatchObject({ ok: true, code: 'appended' })
    expect(index.resolve('session-a', 'lane-a', first.sha256)).toEqual(binding())
    expect(index.resolve('session-a', 'lane-b', first.sha256)).toEqual(otherLane)

    const replacement = binding(second)
    expect(index.replace(writer('append'), binding(), replacement)).toMatchObject({
      ok: false,
      code: 'forbidden',
    })
    expect(
      index.replace(
        writer('replace'),
        { ...binding(), artifact: { ...first, mime: 'image/png' } },
        replacement,
      ),
    ).toMatchObject({ ok: false, code: 'conflict' })
    expect(index.replace(writer('replace'), binding(), { ...replacement, ownerId: 'owner-b' })).toMatchObject(
      { ok: false, code: 'forbidden' },
    )
    expect(index.replace(writer('replace'), binding(), replacement)).toEqual({ ok: true, code: 'replaced' })
    expect(index.resolve('session-a', 'lane-a', first.sha256)).toBeUndefined()
    expect(index.resolve('session-a', 'lane-a', second.sha256)).toEqual(replacement)
    expect(index.replace(writer('replace'), replacement, replacement)).toEqual({
      ok: true,
      code: 'unchanged',
    })
  })

  it('revokes only the exact writer-fenced session lane and owner scope', () => {
    const tables = sqliteTables()
    const index = new PersistentArtifactReadAuthorityIndex(tables.table('artifact-read-authority'))
    expect(index.append(writer('append'), binding())).toMatchObject({ ok: true })
    const laneB = { ...binding(second), laneId: 'lane-b' }
    expect(
      index.append(
        { permission: 'append', sessionId: 'session-a', laneId: 'lane-b', principalId: 'owner-a' },
        laneB,
      ),
    ).toMatchObject({ ok: true })
    for (const stale of [
      writer('append'),
      { permission: 'revoke', sessionId: 'session-b', laneId: 'lane-a', principalId: 'owner-a' },
      { permission: 'revoke', sessionId: 'session-a', laneId: 'lane-b', principalId: 'owner-b' },
    ])
      expect(index.revoke(stale, binding())).toMatchObject({ ok: false, code: 'forbidden' })
    const revokeWriter = { ...writer('append'), permission: 'revoke' as const }
    expect(index.revoke(revokeWriter, binding())).toEqual({
      ok: true,
      code: 'revoked',
    })
    expect(index.resolve('session-a', 'lane-a', first.sha256)).toBeUndefined()
    expect(index.resolve('session-a', 'lane-b', second.sha256)).toEqual(laneB)
    expect(index.revoke(revokeWriter, binding())).toEqual({
      ok: true,
      code: 'unchanged',
    })
    void tables.close()
  })

  it('rejects path fields, Proxy, accessors, extras, and malformed refs without executing hostile code', () => {
    const tables = sqliteTables()
    const index = new PersistentArtifactReadAuthorityIndex(tables.table('artifact-read-authority'))
    const getter = vi.fn(() => first)
    const accessor = {
      sessionId: 'session-a',
      laneId: 'lane-a',
      ownerId: 'owner-a',
    } as Record<string, unknown>
    Object.defineProperty(accessor, 'artifact', { enumerable: true, get: getter })
    const trap = vi.fn(() => {
      throw new Error('Bearer sk-hostile-secret')
    })
    const samples: unknown[] = [
      { ...binding(), path: '/tmp/secret' },
      accessor,
      new Proxy(binding(), { get: trap }),
      { ...binding(), artifact: { ...first, extra: 'secret' } },
      { ...binding(), artifact: { ...first, sha256: first.sha256.toUpperCase() } },
    ]
    for (const sample of samples) {
      const outcome = index.append(writer('append'), sample)
      expect(outcome).toEqual({ ok: false, code: 'invalid' })
      expect(JSON.stringify(outcome)).not.toContain('secret')
    }
    const principalGetter = vi.fn(() => 'owner-a')
    const accessorWriter = {
      permission: 'append',
      sessionId: 'session-a',
      laneId: 'lane-a',
    } as Record<string, unknown>
    Object.defineProperty(accessorWriter, 'principalId', { enumerable: true, get: principalGetter })
    for (const authority of [
      accessorWriter,
      new Proxy(writer('append'), { get: trap }),
      { ...writer('append'), secret: 'Bearer sk-writer-secret' },
    ]) {
      const outcome = index.append(authority, binding())
      expect(outcome).toEqual({ ok: false, code: 'invalid' })
      expect(JSON.stringify(outcome)).not.toContain('secret')
    }
    expect(getter).not.toHaveBeenCalled()
    expect(principalGetter).not.toHaveBeenCalled()
    expect(trap).not.toHaveBeenCalled()
    expect(index.resolve('session-a', 'lane-a', first.sha256)).toBeUndefined()
  })

  it('adapts durable bindings to the read port and fails closed on session drift or abort', async () => {
    const tables = sqliteTables()
    const index = new PersistentArtifactReadAuthorityIndex(tables.table('artifact-read-authority'))
    expect(index.append(writer('append'), binding())).toMatchObject({ ok: true })
    const port = createArtifactReadAuthorityPort(index)
    const active = new AbortController()
    await expect(port.resolve('session-a', 'lane-a', first.sha256, active.signal)).resolves.toEqual({
      sessionId: 'session-a',
      laneId: 'lane-a',
      ownerId: 'owner-a',
      artifact: first,
    })
    await expect(port.resolve('session-b', 'lane-a', first.sha256, active.signal)).resolves.toBeUndefined()

    const aborted = new AbortController()
    aborted.abort(new Error('Bearer sk-abort-secret'))
    const error = await port
      .resolve('session-a', 'lane-a', first.sha256, aborted.signal)
      .catch((value) => value)
    expect(error).toEqual(new Error('artifact read authority lookup unavailable'))
    expect(String(error)).not.toContain('secret')
  })

  it('maps storage faults and corrupt rows to fixed non-secret failures', async () => {
    const tables = sqliteTables()
    const raw = tables.table('artifact-read-authority')
    const index = new PersistentArtifactReadAuthorityIndex(raw)
    raw.exec(
      `INSERT INTO artifact_read_authority_v1 (session_id, lane_id, owner_id, sha256, size, mime)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['session-a', 'lane-a', 'owner-a', first.sha256, -1, 'Bearer/sk-database-secret'],
    )
    expect(() => index.resolve('session-a', 'lane-a', first.sha256)).toThrow(
      'artifact read authority index unavailable',
    )

    let fail = false
    const failureTables = sqliteTables()
    const failureRaw = failureTables.table('artifact-read-authority')
    const failing: TableHandle = {
      exec: (sql, params) => {
        if (fail) throw new Error(`Bearer sk-storage-secret ${sql} ${String(params)}`)
        failureRaw.exec(sql, params)
      },
      get: (sql, params) => {
        if (fail) throw new Error(`Bearer sk-storage-secret ${sql} ${String(params)}`)
        return failureRaw.get(sql, params)
      },
      all: (sql, params) => failureRaw.all(sql, params),
      transaction: (fn) => failureRaw.transaction(fn),
    }
    const unavailable = new PersistentArtifactReadAuthorityIndex(failing)
    fail = true
    const outcome = unavailable.append(writer('append'), binding(second))
    expect(outcome).toEqual({ ok: false, code: 'storage_unavailable' })
    expect(JSON.stringify(outcome)).not.toContain('secret')
    const port = createArtifactReadAuthorityPort(unavailable)
    const error = await port
      .resolve('session-a', 'lane-a', second.sha256, new AbortController().signal)
      .catch((value) => value)
    expect(error).toEqual(new Error('artifact read authority index unavailable'))
    expect(String(error)).not.toContain('secret')
  })

  it('rejects weak or ambiguous pre-existing schemas instead of selecting an arbitrary row', () => {
    for (const ddl of [
      `CREATE TABLE artifact_read_authority_v1 (
        session_id TEXT NOT NULL, lane_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        sha256 TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL,
        PRIMARY KEY (session_id, sha256))`,
      `CREATE TABLE artifact_read_authority_v1 (
        session_id TEXT NOT NULL, lane_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        sha256 TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL)`,
    ]) {
      const tables = sqliteTables()
      const table = tables.table('artifact-read-authority')
      table.exec(ddl)
      if (!ddl.includes('PRIMARY KEY')) {
        for (const owner of ['owner-a', 'owner-b'])
          table.exec(
            `INSERT INTO artifact_read_authority_v1
             (session_id, lane_id, owner_id, sha256, size, mime) VALUES (?, ?, ?, ?, ?, ?)`,
            ['session-a', 'lane-a', owner, first.sha256, first.size, first.mime],
          )
      }
      expect(() => new PersistentArtifactReadAuthorityIndex(table)).toThrow(
        'artifact read authority index unavailable',
      )
    }
  })

  it('rejects trigger-based write mutation and incompatible schema versions', () => {
    const triggerTables = sqliteTables()
    const triggerTable = triggerTables.table('artifact-read-authority')
    new PersistentArtifactReadAuthorityIndex(triggerTable)
    triggerTable.exec(
      `CREATE TRIGGER artifact_read_authority_mutate AFTER INSERT ON artifact_read_authority_v1
       BEGIN UPDATE artifact_read_authority_v1 SET owner_id = 'attacker'; END`,
    )
    expect(() => new PersistentArtifactReadAuthorityIndex(triggerTable)).toThrow(
      'artifact read authority index unavailable',
    )

    const versionTables = sqliteTables()
    const versionTable = versionTables.table('artifact-read-authority')
    new PersistentArtifactReadAuthorityIndex(versionTable)
    versionTable.exec('UPDATE artifact_read_authority_meta SET version = 2 WHERE id = 1')
    expect(() => new PersistentArtifactReadAuthorityIndex(versionTable)).toThrow(
      'artifact read authority index unavailable',
    )
  })

  it('re-attests main schema before every operation and enforces the 4096-row bound', () => {
    const driftTables = sqliteTables()
    const driftTable = driftTables.table('artifact-read-authority')
    const drift = new PersistentArtifactReadAuthorityIndex(driftTable)
    driftTable.exec('CREATE INDEX artifact_read_authority_extra ON artifact_read_authority_v1 (owner_id)')
    expect(drift.append(writer('append'), binding())).toEqual({
      ok: false,
      code: 'storage_unavailable',
    })
    expect(() => drift.resolve('session-a', 'lane-a', first.sha256)).toThrow(
      'artifact read authority index unavailable',
    )

    const capTables = sqliteTables()
    const capTable = capTables.table('artifact-read-authority')
    const capped = new PersistentArtifactReadAuthorityIndex(capTable)
    capTable.exec(
      `WITH RECURSIVE rows(n) AS (
         VALUES(0) UNION ALL SELECT n + 1 FROM rows WHERE n < 4095
       )
       INSERT INTO artifact_read_authority_v1
       (session_id, lane_id, owner_id, sha256, size, mime)
       SELECT 'session-' || n, 'lane', 'owner', printf('%064x', n), 1, 'application/octet-stream'
       FROM rows`,
    )
    expect(new PersistentArtifactReadAuthorityIndex(capTable)).toBeDefined()
    expect(capped.append(writer('append'), binding())).toEqual({
      ok: false,
      code: 'storage_unavailable',
    })
    capTable.exec(
      `INSERT INTO artifact_read_authority_v1
       (session_id, lane_id, owner_id, sha256, size, mime)
       VALUES ('overflow', 'lane', 'owner', '${'f'.repeat(64)}', 1, 'application/octet-stream')`,
    )
    expect(() => new PersistentArtifactReadAuthorityIndex(capTable)).toThrow(
      'artifact read authority index unavailable',
    )
  })

  it('captures table capabilities at construction so later replacement cannot alter CAS', () => {
    const tables = sqliteTables()
    const raw = tables.table('artifact-read-authority')
    const facade: TableHandle = {
      exec: (sql, params) => raw.exec(sql, params),
      get: (sql, params) => raw.get(sql, params),
      all: (sql, params) => raw.all(sql, params),
      transaction: (fn) => raw.transaction(fn),
    }
    const index = new PersistentArtifactReadAuthorityIndex(facade)
    facade.exec = () => {
      throw new Error('Bearer sk-replaced-exec')
    }
    facade.get = () => {
      throw new Error('Bearer sk-replaced-get')
    }
    facade.all = () => {
      throw new Error('Bearer sk-replaced-all')
    }
    facade.transaction = () => {
      throw new Error('Bearer sk-replaced-transaction')
    }
    expect(index.append(writer('append'), binding())).toEqual({ ok: true, code: 'appended' })
    expect(index.resolve('session-a', 'lane-a', first.sha256)).toEqual(binding())
  })
})
