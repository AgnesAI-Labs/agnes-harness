import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { type CoreError, defaultIds, SessionLogImpl } from '@agnes/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ev } from '../../../host/test/adapters/events.js'
import { createSqliteStorage, DATA_DIR_VERSION } from '../../src/adapters/storage-sqlite.js'
import { sqlitePersistenceProvider } from '../../src/adapters/storage-sqlite-provider.js'

describe('data directory version', () => {
  let dir: string
  let file: string
  let tablesDir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agnes-data-dir-'))
    file = join(dir, 'sessions.db')
    tablesDir = join(dir, 'tables')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  const open = () => createSqliteStorage({ file, tablesDir })
  const userVersion = (path: string) => {
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    } finally {
      db.close()
    }
  }
  const refusal = (fn: () => unknown) => {
    try {
      fn()
    } catch (error) {
      return error as CoreError
    }
    throw new Error('expected a refusal')
  }
  const reset = () =>
    `Stop AGH, back up ${dir}, then delete ${file}, ${file}-wal, ${file}-shm and the directory ${tablesDir}. ` +
    'Sessions, schedules, workspace bindings and plugin settings are lost; plugins you installed yourself must be reinstalled. Nothing was changed.'
  const rawCreate = (path: string, ...statements: string[]) => {
    const db = new DatabaseSync(path)
    for (const statement of statements) db.exec(statement)
    db.close()
  }
  const rawCreateWal = (version: number, ...statements: string[]) => {
    const source = join(dir, 'source.db')
    const db = new DatabaseSync(source)
    try {
      for (const statement of statements) db.exec(statement)
      db.exec(`PRAGMA user_version = 0; PRAGMA journal_mode = WAL; PRAGMA user_version = ${version}`)
      // A detached WAL models an interrupted shutdown, without starting another process.
      copyFileSync(source, file)
      copyFileSync(`${source}-wal`, `${file}-wal`)
    } finally {
      db.close()
    }
  }

  // Preserve persisted bytes. A read-only SQLite connection can maintain the disposable -shm cache
  // or create an empty WAL; neither contains saved changes and neither is a data-format migration.
  const snapshot = () =>
    [file, `${file}-wal`].map((path) => {
      const bytes = existsSync(path) ? readFileSync(path) : undefined
      return bytes?.length ? createHash('sha256').update(bytes).digest('hex') : null
    })

  it('stamps a new data directory with the current version', async () => {
    const s = open()
    await s.close()
    expect(DATA_DIR_VERSION).toBe(2)
    expect(userVersion(file)).toBe(DATA_DIR_VERSION)
  })

  it('treats an empty sessions.db as new', async () => {
    // The artifact GC may create the file before the first storage open.
    writeFileSync(file, '')
    const s = open()
    await s.close()
    expect(userVersion(file)).toBe(DATA_DIR_VERSION)
  })

  it('refuses an empty database stamped with a retired format instead of restamping it', () => {
    rawCreate(file, 'PRAGMA user_version = 1')
    const before = snapshot()
    expect(() => {
      void open().close()
    }).toThrow(
      expect.objectContaining({ code: 'E_DATA_DIR_STALE', detail: expect.objectContaining({ found: 1 }) }),
    )
    expect(snapshot()).toEqual(before)
    expect(userVersion(file)).toBe(1)
  })

  it('reopens a data directory of the current version', async () => {
    const s = open()
    await s.open('k', { writerRunId: 'r', ttlMs: 1000 })
    await s.commit('k', { events: [ev('user/message', {})], expectedWriterRunId: 'r' })
    await s.close()
    const s2 = createSqliteStorage({ file, tablesDir, clock: () => Date.now() + 5000 })
    try {
      expect((await s2.open('k', { writerRunId: 'r2', ttlMs: 1000 })).lastSeq).toBe(1)
    } finally {
      await s2.close()
    }
  })

  it.each([
    ['before', false],
    ['after', false],
    ['before', true],
    ['after', true],
  ] as const)(
    'refuses format 1 ledger fixtures from %s the integrity merge (pending WAL: %s) without changing data',
    (build, pendingWal) => {
      const dump = readFileSync(new URL(`../fixtures/ledger-upgrade/${build}.sql`, import.meta.url), 'utf8')
      if (pendingWal) rawCreateWal(1, dump)
      else rawCreate(file, dump)
      mkdirSync(tablesDir)
      const packageFile = join(tablesDir, '_40agnes_2fdaemon.db')
      rawCreate(
        packageFile,
        'CREATE TABLE schedules (id TEXT)',
        "INSERT INTO schedules VALUES ('saved-task')",
      )
      const packageBefore = readFileSync(packageFile)
      const before = snapshot()
      const error = refusal(() => {
        void open().close()
      })
      expect(error).toMatchObject({
        code: 'E_DATA_DIR_STALE',
        detail: { reason: 'older', dataDir: dir, file, tablesDir, found: 1, supported: DATA_DIR_VERSION },
      })
      expect(error.message).toBe(
        `E_DATA_DIR_STALE: data directory ${dir} was created by an older AGH (data format 1; this build supports ${DATA_DIR_VERSION}). ${reset()}`,
      )
      expect(snapshot()).toEqual(before)
      expect(readFileSync(packageFile)).toEqual(packageBefore)
      expect(userVersion(file)).toBe(1)
    },
  )

  it.each(['before', 'after'])(
    'opens and continues real ledger fixtures from %s the integrity merge',
    async (build) => {
      rawCreate(
        file,
        readFileSync(new URL(`../fixtures/ledger-upgrade/${build}.sql`, import.meta.url), 'utf8'),
      )
      // Version 1 directories are refused since schedule tables changed; the ledger layout did not.
      expect(refusal(open)).toMatchObject({ code: 'E_DATA_DIR_STALE', detail: { reason: 'older', found: 1 } })
      rawCreate(file, `PRAGMA user_version = ${DATA_DIR_VERSION}`)
      const storage = open()
      const options = (key: string) => ({
        storage,
        key,
        writerRunId: 'tip',
        ttlMs: 60_000,
        ids: defaultIds(),
        clock: Date.now,
      })
      try {
        for (const [key, lastSeq] of [
          ['upgrade-parent', 2],
          ['upgrade-child', 3],
        ] as const) {
          const log = await SessionLogImpl.open(options(key))
          try {
            expect(log.lastSeq).toBe(lastSeq)
            expect((await storage.scan(key, { fromSeq: 1, limit: 10 })).map((event) => event.data)).toEqual([
              { content: [{ type: 'text', text: 'before restart' }] },
              { content: [{ type: 'text', text: 'saved history' }] },
              ...(key === 'upgrade-child' ? [{ content: [{ type: 'text', text: 'child history' }] }] : []),
            ])
            await log.verifyHistory()
            await log.append([
              {
                actor: { id: 'synthetic', org: 'local', role: 'owner', deptPath: [], attrs: {} },
                origin: 'principal',
                trust: 'trusted',
                type: 'user/message',
                data: { content: [{ type: 'text', text: 'continued at tip' }] },
              },
            ])
            expect(log.lastSeq).toBe(lastSeq + 1)
            expect(await storage.readIntegrityFailure(key)).toBeUndefined()
          } finally {
            await log.close()
          }
          const reopened = await SessionLogImpl.open(options(key))
          try {
            expect(reopened.lastSeq).toBe(lastSeq + 1)
            await reopened.verifyHistory()
          } finally {
            await reopened.close()
          }
        }
      } finally {
        await storage.close()
      }
    },
  )

  it('refuses a sessions.db from an older build and changes nothing', () => {
    rawCreate(file, 'CREATE TABLE events (x)')
    const closes = vi.spyOn(DatabaseSync.prototype, 'close')
    const error = refusal(open)
    expect(error).toMatchObject({
      code: 'E_DATA_DIR_STALE',
      detail: { reason: 'older', dataDir: dir, file, tablesDir, found: 0, supported: DATA_DIR_VERSION },
    })
    expect(error.message).toBe(
      `E_DATA_DIR_STALE: data directory ${dir} was created by an older AGH (data format 0; this build supports ${DATA_DIR_VERSION}). ${reset()}`,
    )
    expect(closes).toHaveBeenCalledOnce()
    closes.mockRestore()
    const raw = new DatabaseSync(file, { readOnly: true })
    try {
      expect(
        (
          raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
        ).map((r) => r.name),
      ).toEqual(['events'])
      expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 })
      // The probe runs before the switch to WAL.
      expect(raw.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' })
    } finally {
      raw.close()
    }
  })

  it('refuses package tables without a ledger and leaves no sessions.db behind', () => {
    mkdirSync(tablesDir)
    rawCreate(join(tablesDir, '_40agnes_2fdaemon.db'), 'CREATE TABLE jobs (id TEXT)')
    const error = refusal(open)
    expect(error).toMatchObject({
      code: 'E_DATA_DIR_STALE',
      detail: {
        reason: 'orphan-tables',
        dataDir: dir,
        file,
        tablesDir,
        found: 0,
        supported: DATA_DIR_VERSION,
      },
    })
    expect(error.message).toBe(
      `E_DATA_DIR_STALE: data directory ${dir} has package tables in ${tablesDir} but no ledger at ${file}. ${reset()}`,
    )
    expect(existsSync(file)).toBe(false)
  })

  it.each([false, true])(
    'refuses a data directory written by a newer build (pending WAL: %s)',
    (pendingWal) => {
      const newer = DATA_DIR_VERSION + 1
      if (pendingWal) rawCreateWal(newer, 'CREATE TABLE events (x)')
      else rawCreate(file, 'CREATE TABLE events (x)', 'PRAGMA user_version = ' + newer)
      const before = snapshot()
      const error = refusal(open)
      expect(error).toMatchObject({
        code: 'E_DATA_DIR_NEWER',
        detail: { dataDir: dir, file, found: newer, supported: DATA_DIR_VERSION },
      })
      expect(error.message).toBe(
        `E_DATA_DIR_NEWER: data directory ${dir} was written by a newer AGH (data format ${newer}; this build supports ${DATA_DIR_VERSION}); upgrade AGH. Nothing was changed.`,
      )
      expect(userVersion(file)).toBe(newer)
      expect(snapshot()).toEqual(before)
    },
  )

  it.each(['ledger_heads', 'child_control_meta'])(
    'refuses a stamped directory that an older build wrote %s into, and changes nothing',
    async (table) => {
      const s = open()
      await s.close()
      rawCreate(file, `CREATE TABLE ${table} (session_key TEXT PRIMARY KEY)`)
      const before = snapshot()
      const error = refusal(open)
      expect(error).toMatchObject({
        code: 'E_DATA_DIR_STALE',
        detail: {
          reason: 'older',
          dataDir: dir,
          file,
          tablesDir,
          found: DATA_DIR_VERSION,
          supported: DATA_DIR_VERSION,
        },
      })
      expect(error.message).toContain('was created by an older AGH')
      expect(error.message).toContain(
        `(data format ${DATA_DIR_VERSION}; an older AGH wrote into it after it was stamped)`,
      )
      expect(error.message).not.toContain('this build supports')
      expect(error.message).toContain(reset())
      expect(snapshot()).toEqual(before)
      expect(userVersion(file)).toBe(DATA_DIR_VERSION)
    },
  )

  it('is refused the same way through the Host persistence provider', () => {
    rawCreate(file, 'CREATE TABLE events (x)')
    expect(() =>
      sqlitePersistenceProvider.open({ dataDir: dir } as Parameters<
        typeof sqlitePersistenceProvider.open
      >[0]),
    ).toThrow(/^E_DATA_DIR_STALE: /)
  })
})
