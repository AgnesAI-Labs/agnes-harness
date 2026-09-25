import { randomBytes } from 'node:crypto'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { DDL } from '../src/adapters/ddl.js'
import { ARTIFACT_REF_EXTRACTOR_VERSION } from '../src/artifact-ledger-refs.js'
import {
  ARTIFACT_REF_INDEX_FILE,
  catchUpArtifactRefIndex,
  catchUpArtifactRefIndexWithinBudget,
  openArtifactRefIndex,
  readIndexedRoots,
  verifyRootsUnderLedgerLock,
  withIndexTransaction,
} from '../src/artifact-ref-index.js'
import { fullScanRefIndex, indexTables } from './support/full-scan-roots-oracle.js'

const temporary: string[] = []
const open: DatabaseSync[] = []
afterEach(async () => {
  for (const database of open.splice(0)) if (database.isOpen) database.close()
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function prng(seed: number) {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    chance: (p: number) => next() < p,
  }
}
const digest = (n: number) => n.toString(16).padStart(2, '0').repeat(32)

async function ledgerFixture() {
  const dataDir = resolve(await mkdtemp(join(tmpdir(), 'agnes-ref-index-')))
  temporary.push(dataDir)
  const file = join(dataDir, 'sessions.db')
  const writer = new DatabaseSync(file)
  open.push(writer)
  writer.exec('PRAGMA journal_mode = WAL')
  // A fixture writer: skipping the per-row fsync keeps thousands of single-row commits fast on
  // Windows, where each flush costs milliseconds. Readers see the same rows either way.
  writer.exec('PRAGMA synchronous = OFF')
  for (const ddl of DDL) writer.exec(ddl)
  const insert = writer.prepare(
    `INSERT INTO events (session_key, seq, ts, id, type, lane, actor, origin, trust, data, integrity_digest)
     VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)`,
  )
  const row = (
    key: string,
    seq: number,
    value: {
      type?: string
      data?: unknown
      origin?: string
      trust?: string
      lane?: string
      id?: string
      digest?: string | null
      raw?: string
    } = {},
  ) =>
    insert.run(
      key,
      seq,
      new Date(Date.UTC(2026, 8, 24, 0, 0, seq)).toISOString(),
      value.id ?? `${key}-${seq}`,
      value.type ?? 'user/message',
      new TextEncoder().encode(value.lane ?? 'main'),
      value.origin ?? 'user',
      value.trust ?? 'trusted',
      value.raw ?? JSON.stringify(value.data ?? {}),
      value.digest === undefined ? `d-${key}-${seq}` : value.digest,
    )
  const ledger = () => {
    const reader = new DatabaseSync(file, { readOnly: true })
    open.push(reader)
    return reader
  }
  const index = async () => {
    const opened = await openArtifactRefIndex(dataDir)
    open.push(opened)
    return opened
  }
  return { dataDir, file, writer, row, ledger, index }
}
type Fixture = Awaited<ReturnType<typeof ledgerFixture>>

/** A random ledger row mixing every reference shape the extractor recognises. */
function randomRow(random: ReturnType<typeof prng>, fixture: Fixture, key: string, seq: number, id?: string) {
  const sha = digest(random.int(1, 24))
  const kind = random.int(0, 6)
  if (kind === 0)
    fixture.row(key, seq, {
      type: 'tool/result',
      origin: 'tool:computer_use',
      trust: 'untrusted',
      ...(id ? { id } : {}),
      data: {
        isError: false,
        content: [
          { type: 'text', text: 'shot' },
          { type: 'resource_link', uri: `artifact://${sha}`, mimeType: 'image/png', name: 'image' },
        ],
      },
    })
  else if (kind === 1)
    fixture.row(key, seq, {
      type: 'tool/result',
      origin: 'tool:other',
      trust: 'untrusted',
      ...(id ? { id } : {}),
      data: {
        isError: false,
        content: [{ type: 'resource_link', uri: `artifact://${sha}`, mimeType: 'image/png' }],
      },
    })
  else if (kind === 2)
    fixture.row(key, seq, {
      type: 'request/header',
      origin: 'system',
      ...(id ? { id } : {}),
      data: { media: { manifest: [{ sha256: sha, artifactUri: `artifact://${sha}`, nodeSeq: 1 }] } },
    })
  else if (kind === 3) {
    let nested: unknown = { sha256: sha }
    for (let depth = 0; depth < random.int(0, 30); depth += 1)
      nested = random.chance(0.5) ? [nested] : { n: nested }
    fixture.row(key, seq, { ...(id ? { id } : {}), data: nested })
  } else if (kind === 4)
    fixture.row(key, seq, {
      type: random.chance(0.5) ? 'turn/start' : 'turn/end',
      lane: random.chance(0.5) ? 'main' : 'side',
      ...(id ? { id } : {}),
      ...(random.chance(0.3) ? { digest: null } : {}),
    })
  else fixture.row(key, seq, { ...(id ? { id } : {}), data: { text: `row ${seq}` } })
}

function expectMatchesOracle(fixture: Fixture, index: DatabaseSync) {
  const oracle = fullScanRefIndex(fixture.file)
  expect(indexTables(index)).toEqual({ refs: oracle.refs, cursors: oracle.cursors })
}

const neverAborted = new AbortController().signal
/** A signal whose `aborted` flag is read once per chunk; the callback runs on every read. */
function chunkProbe(onRead: (read: number) => boolean): AbortSignal {
  let reads = 0
  return {
    get aborted() {
      reads += 1
      return onRead(reads)
    },
  } as AbortSignal
}

describe('Computer Use artifact reference index', () => {
  it.each([1, 2, 3, 4])(
    'matches a full-ledger scan across backfill and later changes (seed %i)',
    async (seed) => {
      const random = prng(seed)
      const fixture = await ledgerFixture()
      const sessions = Array.from({ length: random.int(2, 5) }, (_, index) => `s${index}`)
      const lengths = new Map(sessions.map((key) => [key, random.int(0, 1200)]))
      for (const key of sessions)
        for (let seq = 1; seq <= (lengths.get(key) ?? 0); seq += 1) randomRow(random, fixture, key, seq)
      const index = await fixture.index()
      const ledger = fixture.ledger()
      await expect(catchUpArtifactRefIndex({ ledger, index, signal: neverAborted })).resolves.toBe('complete')
      expectMatchesOracle(fixture, index)

      // Direct inserts (as an older writer would do), a discarded and re-created session with new
      // ids, a deleted session, and a brand-new child session.
      const [first, second, third] = sessions
      for (
        let seq = (lengths.get(first as string) ?? 0) + 1;
        seq <= (lengths.get(first as string) ?? 0) + 40;
        seq += 1
      )
        randomRow(random, fixture, first as string, seq)
      fixture.writer.prepare('DELETE FROM events WHERE session_key = ?').run(second as string)
      for (let seq = 1; seq <= (lengths.get(second as string) ?? 0) + 10; seq += 1)
        randomRow(random, fixture, second as string, seq, `rebuilt-${seq}`)
      if (third) fixture.writer.prepare('DELETE FROM events WHERE session_key = ?').run(third)
      for (let seq = 1; seq <= 30; seq += 1) randomRow(random, fixture, 'child', seq)
      await expect(catchUpArtifactRefIndex({ ledger, index, signal: neverAborted })).resolves.toBe('complete')
      expectMatchesOracle(fixture, index)
      const roots = await readIndexedRoots(index, new Set(Array.from({ length: 30 }, (_, n) => digest(n))))
      const oracle = fullScanRefIndex(fixture.file)
      expect(roots).toEqual({ ledger: oracle.ledger, requestMedia: oracle.requestMedia })
    },
  )

  it('re-indexes a session discarded and re-created between two chunks of one round', async () => {
    const fixture = await ledgerFixture()
    for (let seq = 1; seq <= 700; seq += 1) fixture.row('s', seq, { data: { text: `old ${seq}` } })
    const index = await fixture.index()
    const ledger = fixture.ledger()
    const rebuilt = digest(7)
    const signal = chunkProbe((read) => {
      if (read === 2) {
        fixture.writer.prepare('DELETE FROM events WHERE session_key = ?').run('s')
        for (let seq = 1; seq <= 900; seq += 1)
          fixture.row('s', seq, { id: `new-${seq}`, data: seq === 3 ? { sha256: rebuilt } : { text: 'new' } })
      }
      return false
    })
    await catchUpArtifactRefIndex({ ledger, index, signal })
    expectMatchesOracle(fixture, index)
    expect((await readIndexedRoots(index, new Set([rebuilt]))).ledger).toEqual(new Set([rebuilt]))
  })

  it('continues after a same-content re-creation without rescanning the prefix', async () => {
    const fixture = await ledgerFixture()
    for (let seq = 1; seq <= 700; seq += 1) fixture.row('s', seq, { data: { text: `row ${seq}` } })
    const index = await fixture.index()
    const reads: number[] = []
    const real = fixture.ledger()
    const ledger = new Proxy(real, {
      get(target, property) {
        if (property !== 'prepare') return Reflect.get(target, property).bind(target)
        return (sql: string) => {
          const statement = target.prepare(sql)
          if (!sql.includes('seq > ?')) return statement
          return new Proxy(statement, {
            get(inner, name) {
              if (name !== 'iterate') return Reflect.get(inner, name).bind(inner)
              return (...args: unknown[]) => {
                reads.push(args[1] as number)
                return inner.iterate(...(args as never[]))
              }
            },
          })
        }
      },
    })
    await catchUpArtifactRefIndex({ ledger, index, signal: chunkProbe((read) => read > 1) })
    fixture.writer.prepare('DELETE FROM events WHERE session_key = ?').run('s')
    for (let seq = 1; seq <= 720; seq += 1) fixture.row('s', seq, { data: { text: `row ${seq}` } })
    await catchUpArtifactRefIndex({ ledger, index, signal: neverAborted })
    expect(reads).toEqual([0, 500, 720])
    expectMatchesOracle(fixture, index)
  })

  it('rescans on a replaced ledger, a truncated session and a digest change, and compares only ids for legacy rows', async () => {
    const fixture = await ledgerFixture()
    for (const key of ['a', 'b', 'c', 'd']) for (let seq = 1; seq <= 5; seq += 1) fixture.row(key, seq)
    fixture.row('d', 6, { digest: null, data: { sha256: digest(1) } })
    const index = await fixture.index()
    const ledger = fixture.ledger()
    await catchUpArtifactRefIndex({ ledger, index, signal: neverAborted })
    // Truncated below the cursor; a digest changed at the anchor (with a changed prefix row that
    // only a rescan can see); a legacy anchor without a digest whose prefix changed under the same
    // id, which by design is not detected until the anchor id itself changes.
    fixture.writer.prepare('DELETE FROM events WHERE session_key = ? AND seq > 3').run('a')
    fixture.writer
      .prepare('UPDATE events SET integrity_digest = ? WHERE session_key = ? AND seq = 5')
      .run('x', 'b')
    const setData = fixture.writer.prepare('UPDATE events SET data = ? WHERE session_key = ? AND seq = 2')
    setData.run(JSON.stringify({ sha256: digest(2) }), 'b')
    setData.run(JSON.stringify({ sha256: digest(3) }), 'd')
    await catchUpArtifactRefIndex({ ledger, index, signal: neverAborted })
    const oracle = fullScanRefIndex(fixture.file)
    const tables = indexTables(index)
    const notD = <T extends { session_key: string }>(rows: T[]) =>
      rows.filter((row) => row.session_key !== 'd')
    expect({ refs: notD(tables.refs), cursors: notD(tables.cursors) }).toEqual({
      refs: notD(oracle.refs),
      cursors: notD(oracle.cursors),
    })
    expect(tables.refs.some((row) => row.sha256 === digest(3))).toBe(false)
    expect(tables.cursors.find((row) => row.session_key === 'd')).toMatchObject({
      last_seq: 6,
      anchor_digest: null,
    })
    fixture.writer.prepare('UPDATE events SET id = ? WHERE session_key = ? AND seq = 6').run('d-6-new', 'd')
    await catchUpArtifactRefIndex({ ledger, index, signal: neverAborted })
    expectMatchesOracle(fixture, index)

    // A different sessions.db under the same data directory.
    fixture.writer.close()
    ledger.close()
    await rm(fixture.file, { force: true })
    await rm(`${fixture.file}-wal`, { force: true })
    await rm(`${fixture.file}-shm`, { force: true })
    const replacement = new DatabaseSync(fixture.file)
    open.push(replacement)
    for (const ddl of DDL) replacement.exec(ddl)
    replacement
      .prepare(
        "INSERT INTO events (session_key, seq, ts, id, type, actor, origin, trust, data) VALUES ('a', 1, '2026-09-24T00:00:00.000Z', 'other', 'user/message', '{}', 'user', 'trusted', ?)",
      )
      .run(JSON.stringify({ sha256: digest(9) }))
    const reopened = new DatabaseSync(fixture.file, { readOnly: true })
    open.push(reopened)
    await catchUpArtifactRefIndex({ ledger: reopened, index, signal: neverAborted })
    expectMatchesOracle(fixture, index)
  })

  it('bounds each chunk by rows and by data bytes, always taking at least one row', async () => {
    const fixture = await ledgerFixture()
    for (let seq = 1; seq <= 501; seq += 1) fixture.row('rows', seq)
    const MiB = 1024 * 1024
    for (let seq = 1; seq <= 6; seq += 1)
      fixture.row('bytes', seq, { raw: JSON.stringify({ t: 'x'.repeat(MiB - 12) }) })
    fixture.row('huge', 1, { raw: JSON.stringify({ t: 'x'.repeat(5 * MiB) }) })
    const index = await fixture.index()
    const ledger = fixture.ledger()
    const cursor = index.prepare('SELECT session_key, last_seq FROM session_cursor ORDER BY session_key')
    // Sessions run in key order (bytes, huge, rows); every chunk reads the abort flag once.
    await catchUpArtifactRefIndex({ ledger, index, signal: chunkProbe((read) => read > 1) })
    expect(cursor.all()).toEqual([{ session_key: 'bytes', last_seq: 4 }])
    await catchUpArtifactRefIndex({ ledger, index, signal: chunkProbe((read) => read > 5) })
    expect(cursor.all()).toEqual([
      { session_key: 'bytes', last_seq: 6 },
      { session_key: 'huge', last_seq: 1 },
      { session_key: 'rows', last_seq: 500 },
    ])
    await catchUpArtifactRefIndex({ ledger, index, signal: neverAborted })
    expectMatchesOracle(fixture, index)
  })

  it('stops at a malformed row and keeps the rows before it indexed', async () => {
    const fixture = await ledgerFixture()
    fixture.row('s', 1, { data: { sha256: digest(3) } })
    fixture.row('s', 2, { type: 'request/header', data: { media: { manifest: {} } } })
    fixture.row('s', 3, { data: { sha256: digest(4) } })
    const index = await fixture.index()
    await expect(
      catchUpArtifactRefIndex({ ledger: fixture.ledger(), index, signal: neverAborted }),
    ).rejects.toThrow('manifest is malformed')
    expect(index.prepare('SELECT last_seq FROM session_cursor').all()).toEqual([{ last_seq: 1 }])
  })

  it('under the ledger write lock proves the whole ledger or declines within its budget', async () => {
    const fixture = await ledgerFixture()
    const indexed = digest(1)
    const later = digest(2)
    fixture.row('s', 1, { data: { sha256: indexed } })
    const index = await fixture.index()
    await catchUpArtifactRefIndex({ ledger: fixture.ledger(), index, signal: neverAborted })
    fixture.row('s', 2, {
      type: 'request/header',
      data: { media: { manifest: [{ sha256: later, artifactUri: `artifact://${later}` }] } },
    })
    fixture.row('t', 1, { data: { sha256: later } })
    const candidates = new Set([indexed, later, digest(3)])
    const locked = new DatabaseSync(fixture.file)
    open.push(locked)
    locked.exec('BEGIN IMMEDIATE')
    await expect(verifyRootsUnderLedgerLock({ ledger: locked, index, candidates })).resolves.toMatchObject({
      ledger: new Set([indexed, later]),
      requestMedia: new Set([later]),
    })
    locked.exec('ROLLBACK')
    for (let seq = 3; seq <= 2003; seq += 1) fixture.row('s', seq)
    locked.exec('BEGIN IMMEDIATE')
    await expect(verifyRootsUnderLedgerLock({ ledger: locked, index, candidates })).resolves.toBeUndefined()
    locked.exec('ROLLBACK')
    await expect(catchUpArtifactRefIndexWithinBudget({ ledger: fixture.ledger(), index })).resolves.toBe(
      false,
    )
    await expect(catchUpArtifactRefIndexWithinBudget({ ledger: fixture.ledger(), index })).resolves.toBe(true)
    // A changed anchor is a refusal too, never a silent rescan under the lock: first the same id
    // with a different integrity digest, then a different id.
    fixture.writer
      .prepare('UPDATE events SET integrity_digest = ? WHERE session_key = ? AND seq = 2003')
      .run('other-digest', 's')
    locked.exec('BEGIN IMMEDIATE')
    await expect(verifyRootsUnderLedgerLock({ ledger: locked, index, candidates })).resolves.toBeUndefined()
    locked.exec('ROLLBACK')
    fixture.writer
      .prepare('UPDATE events SET integrity_digest = ? WHERE session_key = ? AND seq = 2003')
      .run('d-s-2003', 's')
    locked.exec('BEGIN IMMEDIATE')
    await expect(verifyRootsUnderLedgerLock({ ledger: locked, index, candidates })).resolves.toBeDefined()
    locked.exec('ROLLBACK')
    fixture.writer
      .prepare('UPDATE events SET id = ? WHERE session_key = ? AND seq = 2003')
      .run('changed', 's')
    locked.exec('BEGIN IMMEDIATE')
    await expect(verifyRootsUnderLedgerLock({ ledger: locked, index, candidates })).resolves.toBeUndefined()
    locked.exec('ROLLBACK')
  })

  it('declines under the lock when a session was re-created with more rows than its cursor', async () => {
    const fixture = await ledgerFixture()
    const hidden = digest(5)
    for (let seq = 1; seq <= 10; seq += 1) fixture.row('s', seq)
    fixture.row('t', 1)
    const index = await fixture.index()
    await catchUpArtifactRefIndex({ ledger: fixture.ledger(), index, signal: neverAborted })
    fixture.writer.prepare('DELETE FROM events WHERE session_key = ?').run('s')
    for (let seq = 1; seq <= 12; seq += 1)
      fixture.row('s', seq, { id: `again-${seq}`, data: seq === 4 ? { sha256: hidden } : {} })
    const locked = new DatabaseSync(fixture.file)
    open.push(locked)
    locked.exec('BEGIN IMMEDIATE')
    await expect(
      verifyRootsUnderLedgerLock({ ledger: locked, index, candidates: new Set([hidden]) }),
    ).resolves.toBeUndefined()
    locked.exec('ROLLBACK')
  })

  it('checks every session in a constant number of ledger queries when nothing is new', async () => {
    const fixture = await ledgerFixture()
    fixture.writer.exec('BEGIN')
    for (let session = 0; session < 300; session += 1)
      for (let seq = 1; seq <= 3; seq += 1)
        fixture.row(`s${String(session).padStart(3, '0')}`, seq, { data: { sha256: digest(session % 20) } })
    fixture.writer.exec('COMMIT')
    const index = await fixture.index()
    await catchUpArtifactRefIndex({ ledger: fixture.ledger(), index, signal: neverAborted })
    const counted = (database: DatabaseSync) => {
      const counter = { executions: 0 }
      const proxy = new Proxy(database, {
        get(target, property) {
          if (property !== 'prepare') return Reflect.get(target, property).bind(target)
          return (sql: string) =>
            new Proxy(target.prepare(sql), {
              get(statement, name) {
                const value = Reflect.get(statement, name)
                if (typeof value !== 'function') return value
                return (...args: unknown[]) => {
                  if (name === 'get' || name === 'all' || name === 'iterate') counter.executions += 1
                  return value.apply(statement, args)
                }
              },
            })
        },
      })
      return { proxy, counter }
    }
    const reader = counted(fixture.ledger())
    await catchUpArtifactRefIndex({ ledger: reader.proxy, index, signal: neverAborted })
    expect(reader.counter.executions).toBeLessThanOrEqual(3)
    const locked = new DatabaseSync(fixture.file)
    open.push(locked)
    locked.exec('BEGIN IMMEDIATE')
    const lockedCount = counted(locked)
    const roots = await verifyRootsUnderLedgerLock({
      ledger: lockedCount.proxy,
      index,
      candidates: new Set([digest(1), digest(2)]),
    })
    locked.exec('ROLLBACK')
    expect(roots).toMatchObject({ ledger: new Set([digest(1), digest(2)]), requestMedia: new Set() })
    expect(lockedCount.counter.executions).toBeLessThanOrEqual(3)
  })

  it('rebuilds the index when it was built by a different extraction rule', async () => {
    const fixture = await ledgerFixture()
    for (let seq = 1; seq <= 20; seq += 1) fixture.row('s', seq, { data: { sha256: digest(seq) } })
    const index = await fixture.index()
    await catchUpArtifactRefIndex({ ledger: fixture.ledger(), index, signal: neverAborted })
    expect(index.prepare("SELECT value FROM meta WHERE key = 'extractor_version'").get()).toEqual({
      value: ARTIFACT_REF_EXTRACTOR_VERSION,
    })
    for (const stale of [
      "UPDATE meta SET value = 'stale' WHERE key = 'extractor_version'",
      "DELETE FROM meta WHERE key = 'extractor_version'",
    ]) {
      const current = await fixture.index()
      await catchUpArtifactRefIndex({ ledger: fixture.ledger(), index: current, signal: neverAborted })
      expect(current.prepare('SELECT COUNT(*) AS n FROM session_cursor').get()).toEqual({ n: 1 })
      current.prepare(stale).run()
      current.close()
      const rebuilt = await fixture.index()
      expect(rebuilt.prepare('SELECT COUNT(*) AS n FROM session_cursor').get()).toEqual({ n: 0 })
      expect(rebuilt.prepare('SELECT COUNT(*) AS n FROM artifact_ref').get()).toEqual({ n: 0 })
      rebuilt.close()
    }
  })

  it('fails closed on a corrupt index file without deleting it, and rebuilds on a schema mismatch', async () => {
    const fixture = await ledgerFixture()
    for (let seq = 1; seq <= 50; seq += 1) fixture.row('s', seq, { data: { sha256: digest(seq % 20) } })
    const index = await fixture.index()
    await catchUpArtifactRefIndex({ ledger: fixture.ledger(), index, signal: neverAborted })
    index.prepare("UPDATE meta SET value = '0' WHERE key = 'schema_version'").run()
    index.close()
    const rebuilt = await fixture.index()
    expect(rebuilt.prepare('SELECT COUNT(*) AS n FROM session_cursor').get()).toEqual({ n: 0 })
    await catchUpArtifactRefIndex({ ledger: fixture.ledger(), index: rebuilt, signal: neverAborted })
    rebuilt.close()
    const file = join(fixture.dataDir, 'artifacts', ARTIFACT_REF_INDEX_FILE)
    const size = statSync(file).size
    const handle = new DatabaseSync(file)
    const pageSize = (handle.prepare('PRAGMA page_size').get() as { page_size: number }).page_size
    handle.close()
    const bytes = new Uint8Array(await import('node:fs/promises').then((fs) => fs.readFile(file)))
    bytes.set(randomBytes(Math.min(pageSize, size - pageSize)), pageSize)
    writeFileSync(file, bytes)
    await expect(openArtifactRefIndex(fixture.dataDir)).rejects.toThrow()
    expect(existsSync(file)).toBe(true)
  })

  it.skipIf(process.platform === 'win32')(
    'keeps the index, its directory and its write-ahead log files private',
    async () => {
      const fixture = await ledgerFixture()
      const index = await fixture.index()
      const file = join(fixture.dataDir, 'artifacts', ARTIFACT_REF_INDEX_FILE)
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(statSync(join(fixture.dataDir, 'artifacts')).mode & 0o777).toBe(0o700)
      expect(index.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
      expect(index.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 1 })
      await withIndexTransaction(index, () => {
        index.prepare("INSERT INTO meta VALUES ('probe', 'x')").run()
      })
      for (const sidecar of ['-wal', '-shm']) expect(statSync(`${file}${sidecar}`).mode & 0o777).toBe(0o600)
      expect(existsSync(`${file}-journal`)).toBe(false)
    },
  )
})
