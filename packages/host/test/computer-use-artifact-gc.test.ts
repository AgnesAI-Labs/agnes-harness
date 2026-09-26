import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { deletePrivateArtifactSync, privateArtifactDeleteAvailable } from '@agnes/system-node'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DDL } from '../src/adapters/ddl.js'
import { ARTIFACT_RECLAIMED_FAILURE, createLocalArtifactReadStore } from '../src/artifact-read-store.js'
import {
  ARTIFACT_REF_INDEX_FILE,
  catchUpArtifactRefIndexWithinBudget,
  verifyRootsUnderLedgerLock,
} from '../src/artifact-ref-index.js'
import { planRetentionProtection } from '../src/artifact-retention-protection.js'
import { createComputerUseArtifactGcRuntime } from '../src/computer-use-artifact-gc.js'
import { computerUseMarkerPath } from '../src/computer-use-marker.js'
import { createPrivateArtifactStore, withComputerUseArtifactMutation } from '../src/private-artifact-store.js'
import { fullScanRefIndex, indexTables } from './support/full-scan-roots-oracle.js'

vi.mock('../src/artifact-ref-index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/artifact-ref-index.js')>()
  return {
    ...actual,
    catchUpArtifactRefIndexWithinBudget: vi.fn(actual.catchUpArtifactRefIndexWithinBudget),
    verifyRootsUnderLedgerLock: vi.fn(actual.verifyRootsUnderLedgerLock),
  }
})
vi.mock('../src/artifact-retention-protection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/artifact-retention-protection.js')>()
  return { ...actual, planRetentionProtection: vi.fn(actual.planRetentionProtection) }
})
vi.mock('@agnes/system-node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agnes/system-node')>()
  return { ...actual, deletePrivateArtifactSync: vi.fn(actual.deletePrivateArtifactSync) }
})

const temporary: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function screenshotFixture() {
  const dataDir = resolve(await mkdtemp(join(tmpdir(), 'agnes-cu-runtime-gc-')))
  temporary.push(dataDir)
  const bytes = new TextEncoder().encode('expired screenshot')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const artifactDirectory = join(dataDir, 'artifacts', 'sha256', sha256.slice(0, 2))
  const artifact = join(artifactDirectory, sha256)
  const store = createPrivateArtifactStore(dataDir, process.platform === 'win32' ? 'win32' : 'darwin')
  await store.put(sha256, bytes)
  await store.putComputerUseMetadata(
    sha256,
    new TextEncoder().encode(
      `${JSON.stringify({ schemaVersion: 1, sha256, size: bytes.byteLength, createdAtMs: 0 }, null, 2)}\n`,
    ),
  )
  return { dataDir, sha256, artifact, bytes, store }
}

const retention = Object.freeze({
  maxRecentPerSession: 20,
  ttlMs: 60_000,
  gcIntervalMs: 3_600_000,
  maxExtendedTtlMs: 604_800_000,
  globalMaxBytes: 1024 * 1024 * 1024,
})

function createEmptyLedger(dataDir: string): void {
  ledgerRows(dataDir).database.close()
}

function ledgerRows(dataDir: string) {
  const database = new DatabaseSync(join(dataDir, 'sessions.db'))
  database.exec('PRAGMA journal_mode = WAL')
  // A fixture writer: skipping the per-row fsync keeps thousands of single-row commits fast on
  // Windows, where each flush costs milliseconds. Readers see the same rows either way.
  database.exec('PRAGMA synchronous = OFF')
  for (const ddl of DDL) database.exec(ddl)
  const insert = database.prepare(
    "INSERT INTO events (session_key, seq, ts, id, type, actor, origin, trust, data) VALUES (?, ?, '2026-09-24T00:00:00.000Z', ?, 'user/message', '{}', 'user', 'trusted', ?)",
  )
  const row = (key: string, seq: number, data: unknown = {}, raw?: string) =>
    insert.run(key, seq, `${key}-${seq}`, raw ?? JSON.stringify(data))
  const bulk = (sessions: number, rows: number) => {
    database.exec('BEGIN')
    for (let session = 0; session < sessions; session += 1)
      for (let seq = 1; seq <= rows; seq += 1) row(`bulk-${session}`, seq, { text: 'x'.repeat(120), seq })
    database.exec('COMMIT')
    return sessions * rows
  }
  return { database, row, bulk }
}

/** Sum of indexed cursors, read without disturbing the collector (0 while the index is busy). */
function indexedRows(dataDir: string): number {
  try {
    const index = new DatabaseSync(join(dataDir, 'artifacts', ARTIFACT_REF_INDEX_FILE), { readOnly: true })
    try {
      return (
        index.prepare('SELECT COALESCE(SUM(last_seq), 0) AS n FROM session_cursor').get() as { n: number }
      ).n
    } finally {
      index.close()
    }
  } catch {
    return 0
  }
}

async function untilIndexing(dataDir: string): Promise<void> {
  while (indexedRows(dataDir) === 0) await delay(2)
}

/** Another process taking and releasing the cross-process screenshot mutation lock. */
async function foreignLockWaitMs(dataDir: string): Promise<number> {
  const script = `
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(process.argv[1])
    const started = performance.now()
    for (;;) {
      try { db.exec('BEGIN IMMEDIATE'); break } catch (error) {
        if (performance.now() - started > 30000) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
      }
    }
    const waited = performance.now() - started
    db.exec('COMMIT')
    db.close()
    process.stdout.write(String(waited))
  `
  const child = spawn(process.execPath, [
    '-e',
    script,
    join(dataDir, 'artifacts', 'computer-use-artifact-mutation-lock.db'),
  ])
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += String(chunk)
  })
  const [code] = (await once(child, 'exit')) as [number]
  expect(code).toBe(0)
  return Number(output)
}

describe.skipIf(!privateArtifactDeleteAvailable())('Computer Use artifact GC production runtime', () => {
  it('coalesces the boot/manual trigger and physically deletes an expired orphan', async () => {
    const fixture = await screenshotFixture()
    const database = new DatabaseSync(join(fixture.dataDir, 'sessions.db'))
    for (const ddl of DDL) database.exec(ddl)
    database.close()
    const runtime = createComputerUseArtifactGcRuntime({
      dataDir: fixture.dataDir,
      retention,
      clock: () => 120_000,
    })
    try {
      const [first, second] = await Promise.all([runtime.trigger(), runtime.trigger()])
      expect(first).toEqual(second)
      expect(first.deleted).toBe(1)
      expect(existsSync(fixture.artifact)).toBe(false)
    } finally {
      await runtime.close()
    }
  })

  it('keeps an expired screenshot referenced by the durable ledger', async () => {
    const fixture = await screenshotFixture()
    const database = new DatabaseSync(join(fixture.dataDir, 'sessions.db'))
    for (const ddl of DDL) database.exec(ddl)
    database
      .prepare(
        "INSERT INTO events (session_key, seq, ts, id, type, actor, origin, trust, data) VALUES (?, ?, '2026-09-24T00:00:00.000Z', ?, ?, '{}', 'user', 'trusted', ?)",
      )
      .run('one', 1, 'one-1', 'tool/result', JSON.stringify({ uri: `artifact://${fixture.sha256}` }))
    database.close()
    const runtime = createComputerUseArtifactGcRuntime({
      dataDir: fixture.dataDir,
      retention,
      clock: () => 120_000,
    })
    try {
      const result = await runtime.trigger()
      expect(result.deleted).toBe(0)
      expect(existsSync(fixture.artifact)).toBe(true)
    } finally {
      await runtime.close()
    }
  })

  it('keeps a reused digest while its refreshed capture age is inside the retention window', async () => {
    vi.useFakeTimers().setSystemTime(120_000)
    const fixture = await screenshotFixture()
    createEmptyLedger(fixture.dataDir)
    await fixture.store.putComputerUseMetadata(
      fixture.sha256,
      new TextEncoder().encode(
        `${JSON.stringify(
          {
            schemaVersion: 1,
            sha256: fixture.sha256,
            size: fixture.bytes.byteLength,
            createdAtMs: 120_000,
          },
          null,
          2,
        )}\n`,
      ),
    )
    await fixture.store.put(fixture.sha256, fixture.bytes)
    const runtime = createComputerUseArtifactGcRuntime({
      dataDir: fixture.dataDir,
      retention,
      clock: () => 120_000,
    })
    try {
      const result = await runtime.trigger()
      expect(result.deleted).toBe(0)
      expect(existsSync(fixture.artifact)).toBe(true)
    } finally {
      await runtime.close()
    }
  })

  it('does not scan or delete while a screenshot publication owns the data-directory gate', async () => {
    const fixture = await screenshotFixture()
    createEmptyLedger(fixture.dataDir)
    let release: () => void = () => undefined
    const wait = new Promise<void>((done) => {
      release = done
    })
    let entered: () => void = () => undefined
    const active = new Promise<void>((done) => {
      entered = done
    })
    const publication = withComputerUseArtifactMutation(fixture.dataDir, async () => {
      entered()
      await wait
    })
    await active
    const runtime = createComputerUseArtifactGcRuntime({
      dataDir: fixture.dataDir,
      retention,
      clock: () => 120_000,
    })
    let settled = false
    const collection = runtime.trigger().finally(() => {
      settled = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(existsSync(fixture.artifact)).toBe(true)
    release()
    await publication
    try {
      await expect(collection).resolves.toMatchObject({ deleted: 1 })
      expect(existsSync(fixture.artifact)).toBe(false)
    } finally {
      await runtime.close()
    }
  })

  it('closes idempotently and refuses a new collection after shutdown', async () => {
    const fixture = await screenshotFixture()
    const database = new DatabaseSync(join(fixture.dataDir, 'sessions.db'))
    for (const ddl of DDL) database.exec(ddl)
    database.close()
    const runtime = createComputerUseArtifactGcRuntime({
      dataDir: fixture.dataDir,
      retention,
      clock: () => 120_000,
    })

    await Promise.all([runtime.close(), runtime.close()])
    await expect(runtime.trigger()).rejects.toThrow('runtime is closed')
  })
  it('aborts the batch when a referencing row lands between planning and the ledger lock', async () => {
    const fixture = await screenshotFixture()
    const ledger = ledgerRows(fixture.dataDir)
    ledger.row('one', 1)
    const exec = DatabaseSync.prototype.exec
    let injected = false
    const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      if (!injected && sql.includes('busy_timeout') && sql.includes('BEGIN IMMEDIATE')) {
        injected = true
        ledger.row('one', 2, { uri: `artifact://${fixture.sha256}` })
      }
      return exec.call(this, sql)
    })
    const runtime = createComputerUseArtifactGcRuntime({
      dataDir: fixture.dataDir,
      retention,
      clock: () => 120_000,
    })
    try {
      await expect(runtime.trigger()).rejects.toThrow('reachability snapshot changed')
      expect(injected).toBe(true)
      expect(existsSync(fixture.artifact)).toBe(true)
    } finally {
      spy.mockRestore()
      await runtime.close()
      ledger.database.close()
    }
  })

  it('declines the batch when the rows written before the ledger lock exceed the locked budget', async () => {
    const fixture = await screenshotFixture()
    const ledger = ledgerRows(fixture.dataDir)
    ledger.row('one', 1)
    const exec = DatabaseSync.prototype.exec
    let injected = false
    const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      if (!injected && sql.includes('busy_timeout') && sql.includes('BEGIN IMMEDIATE')) {
        injected = true
        for (let seq = 2; seq <= 2002; seq += 1) ledger.row('one', seq)
      }
      return exec.call(this, sql)
    })
    const runtime = createComputerUseArtifactGcRuntime({
      dataDir: fixture.dataDir,
      retention,
      clock: () => 120_000,
    })
    try {
      await expect(runtime.trigger()).rejects.toThrow('proof under lock was declined')
      expect(existsSync(fixture.artifact)).toBe(true)
    } finally {
      spy.mockRestore()
      await runtime.close()
      ledger.database.close()
    }
  })

  it('gives the ledger lock back within a second when the reference index stays busy', async () => {
    const fixture = await screenshotFixture()
    const ledger = ledgerRows(fixture.dataDir)
    ledger.row('one', 1)
    const exec = DatabaseSync.prototype.exec
    let holder: DatabaseSync | undefined
    let lockedAt = 0
    const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      if (!lockedAt && sql.includes('busy_timeout') && sql.includes('BEGIN IMMEDIATE')) {
        lockedAt = performance.now()
        holder = new DatabaseSync(join(fixture.dataDir, 'artifacts', ARTIFACT_REF_INDEX_FILE))
        exec.call(holder, 'BEGIN IMMEDIATE')
      }
      return exec.call(this, sql)
    })
    const runtime = createComputerUseArtifactGcRuntime({
      dataDir: fixture.dataDir,
      retention,
      clock: () => 120_000,
    })
    try {
      const outcome = await Promise.race([
        runtime.trigger().then(
          () => 'completed',
          (error: Error) => error.message,
        ),
        delay(5_000).then(() => 'still holding the ledger lock'),
      ])
      expect(outcome).toBe('Computer Use artifact reference index is busy')
      expect(performance.now() - lockedAt).toBeLessThan(2_500)
      expect(existsSync(fixture.artifact)).toBe(true)
      const writer = new DatabaseSync(join(fixture.dataDir, 'sessions.db'))
      exec.call(writer, 'PRAGMA busy_timeout = 0; BEGIN IMMEDIATE')
      exec.call(writer, 'ROLLBACK')
      writer.close()
    } finally {
      spy.mockRestore()
      if (holder?.isTransaction) holder.exec('ROLLBACK')
      holder?.close()
      await runtime.close()
      ledger.database.close()
    }
  }, 15_000)

  it('fails closed on a malformed ledger row without deleting', async () => {
    const fixture = await screenshotFixture()
    const ledger = ledgerRows(fixture.dataDir)
    ledger.row('one', 1, undefined, '{')
    ledger.database.close()
    const runtime = createComputerUseArtifactGcRuntime({
      dataDir: fixture.dataDir,
      retention,
      clock: () => 120_000,
    })
    try {
      await expect(runtime.trigger()).rejects.toThrow()
      expect(existsSync(fixture.artifact)).toBe(true)
    } finally {
      await runtime.close()
    }
  })

  it('stops an unfinished backfill at close() within 500 ms and resumes it to the same result', async () => {
    const fixture = await screenshotFixture()
    const ledger = ledgerRows(fixture.dataDir)
    const total = ledger.bulk(40, 5_000)
    ledger.database.close()
    const runtime = createComputerUseArtifactGcRuntime({
      dataDir: fixture.dataDir,
      retention,
      clock: () => 120_000,
    })
    const round = runtime.trigger()
    await untilIndexing(fixture.dataDir)
    const started = performance.now()
    await runtime.close()
    expect(performance.now() - started).toBeLessThan(500)
    await expect(round).resolves.toMatchObject({ deleted: 0 })
    expect(existsSync(fixture.artifact)).toBe(true)
    expect(indexedRows(fixture.dataDir)).toBeLessThan(total)

    const resumed = createComputerUseArtifactGcRuntime({
      dataDir: fixture.dataDir,
      retention,
      clock: () => 120_000,
    })
    try {
      await expect(resumed.trigger()).resolves.toMatchObject({ deleted: 1 })
    } finally {
      await resumed.close()
    }
    const index = new DatabaseSync(join(fixture.dataDir, 'artifacts', ARTIFACT_REF_INDEX_FILE), {
      readOnly: true,
    })
    try {
      const oracle = fullScanRefIndex(join(fixture.dataDir, 'sessions.db'))
      expect(indexTables(index)).toEqual({ refs: oracle.refs, cursors: oracle.cursors })
    } finally {
      index.close()
    }
  }, 60_000)

  it('lets screenshot publication in this and another process proceed during a backfill', async () => {
    const fixture = await screenshotFixture()
    const ledger = ledgerRows(fixture.dataDir)
    const total = ledger.bulk(40, 5_000)
    ledger.database.close()
    const runtime = createComputerUseArtifactGcRuntime({
      dataDir: fixture.dataDir,
      retention,
      clock: () => 120_000,
    })
    const round = runtime.trigger()
    try {
      await untilIndexing(fixture.dataDir)
      const published = new TextEncoder().encode('fresh screenshot')
      const digest = createHash('sha256').update(published).digest('hex')
      const started = performance.now()
      await fixture.store.put(digest, published)
      const inProcessMs = performance.now() - started
      const foreignMs = await foreignLockWaitMs(fixture.dataDir)
      // Both publications finished while the backfill was still running.
      expect(indexedRows(fixture.dataDir)).toBeLessThan(total)
      expect(inProcessMs).toBeLessThan(5_000)
      expect(foreignMs).toBeLessThan(5_000)
    } finally {
      await runtime.close()
      await round.catch(() => undefined)
    }
  }, 60_000)

  it('reports storage pressure once per round when referenced bytes keep the store above its cap', async () => {
    const fixture = await screenshotFixture()
    const ledger = ledgerRows(fixture.dataDir)
    ledger.row('one', 1, { uri: `artifact://${fixture.sha256}` })
    ledger.database.close()
    const onPressure = vi.fn()
    const runtime = createComputerUseArtifactGcRuntime({
      dataDir: fixture.dataDir,
      retention: { ...retention, globalMaxBytes: 1 },
      clock: () => 120_000,
      onPressure,
    })
    try {
      await runtime.trigger()
      expect(onPressure).toHaveBeenCalledTimes(1)
      await runtime.trigger()
      expect(onPressure).toHaveBeenCalledTimes(2)
      expect(onPressure).toHaveBeenLastCalledWith({
        remainingBytes: fixture.bytes.byteLength,
        unresolvedPressureBytes: fixture.bytes.byteLength - 1,
      })
      expect(existsSync(fixture.artifact)).toBe(true)
    } finally {
      await runtime.close()
    }
  })

  it('reports pressure when the locked catch-up defers a round while the store is over its cap', async () => {
    const fixture = await screenshotFixture()
    const ledger = ledgerRows(fixture.dataDir)
    ledger.row('one', 1, { uri: `artifact://${fixture.sha256}` })
    ledger.database.close()
    vi.mocked(catchUpArtifactRefIndexWithinBudget).mockResolvedValueOnce(false)
    const onPressure = vi.fn()
    const runtime = createComputerUseArtifactGcRuntime({
      dataDir: fixture.dataDir,
      retention: { ...retention, globalMaxBytes: 1 },
      clock: () => 120_000,
      onPressure,
    })
    try {
      await expect(runtime.trigger()).resolves.toMatchObject({ deleted: 0 })
      expect(onPressure).toHaveBeenCalledTimes(1)
      expect(onPressure).toHaveBeenLastCalledWith({
        remainingBytes: fixture.bytes.byteLength,
        unresolvedPressureBytes: fixture.bytes.byteLength - 1,
      })
    } finally {
      await runtime.close()
    }
  })

  it('does not report pressure for a round that close() stopped after a deleting batch', async () => {
    const fixture = await screenshotFixture()
    const kept = new TextEncoder().encode('referenced screenshot kept above the cap')
    const keptSha = createHash('sha256').update(kept).digest('hex')
    await fixture.store.put(keptSha, kept)
    await fixture.store.putComputerUseMetadata(
      keptSha,
      new TextEncoder().encode(
        `${JSON.stringify({ schemaVersion: 1, sha256: keptSha, size: kept.byteLength, createdAtMs: 0 }, null, 2)}\n`,
      ),
    )
    const ledger = ledgerRows(fixture.dataDir)
    ledger.row('one', 1, { uri: `artifact://${keptSha}` })
    ledger.database.close()
    const onPressure = vi.fn()
    const runtime = createComputerUseArtifactGcRuntime({
      dataDir: fixture.dataDir,
      retention: { ...retention, globalMaxBytes: 1 },
      clock: () => 120_000,
      onPressure,
    })
    const exec = DatabaseSync.prototype.exec
    let closing: Promise<void> | undefined
    const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      if (!closing && sql.includes('busy_timeout') && sql.includes('BEGIN IMMEDIATE'))
        closing = runtime.close()
      return exec.call(this, sql)
    })
    try {
      await expect(runtime.trigger()).resolves.toMatchObject({ deleted: 1 })
      expect(existsSync(fixture.artifact)).toBe(false)
      expect(onPressure).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
      await closing
      await runtime.close()
    }
  })

  it('checks the index integrity once per open, not on every round', async () => {
    const fixture = await screenshotFixture()
    createEmptyLedger(fixture.dataDir)
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare')
    const runtime = createComputerUseArtifactGcRuntime({
      dataDir: fixture.dataDir,
      retention,
      clock: () => 0,
    })
    try {
      await runtime.trigger()
      await runtime.trigger()
      await runtime.trigger()
      expect(prepare.mock.calls.filter(([sql]) => sql === 'PRAGMA quick_check')).toHaveLength(1)
    } finally {
      prepare.mockRestore()
      await runtime.close()
    }
  })
})

const T0 = Date.UTC(2026, 8, 24)
const NOW = T0 + 86_400_000

/** Classified screenshots plus a ledger that references them from Computer Use tool results. */
async function referencedFixture(names: readonly string[]) {
  const dataDir = resolve(await mkdtemp(join(tmpdir(), 'agnes-cu-referenced-gc-')))
  temporary.push(dataDir)
  const store = createPrivateArtifactStore(dataDir, process.platform === 'win32' ? 'win32' : 'darwin')
  const shots = new Map<string, Readonly<{ sha256: string; bytes: Uint8Array; artifact: string }>>()
  let total = 0
  for (const name of names) {
    const bytes = new TextEncoder().encode(`screenshot ${name}`)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    await store.put(sha256, bytes)
    await store.putComputerUseMetadata(
      sha256,
      new TextEncoder().encode(
        `${JSON.stringify({ schemaVersion: 1, sha256, size: bytes.byteLength, createdAtMs: 0 }, null, 2)}\n`,
      ),
    )
    shots.set(name, {
      sha256,
      bytes,
      artifact: join(dataDir, 'artifacts', 'sha256', sha256.slice(0, 2), sha256),
    })
    total += bytes.byteLength
  }
  const database = new DatabaseSync(join(dataDir, 'sessions.db'))
  database.exec('PRAGMA journal_mode = WAL')
  for (const ddl of DDL) database.exec(ddl)
  const insert = database.prepare(
    `INSERT INTO events (session_key, seq, ts, id, type, actor, origin, trust, data)
     VALUES (?, ?, ?, ?, 'tool/result', '{}', 'tool:computer_use', 'untrusted', ?)`,
  )
  const shot = (key: string, seq: number, name: string, tsMs: number) =>
    insert.run(
      key,
      seq,
      new Date(tsMs).toISOString(),
      `${key}-${seq}`,
      JSON.stringify({
        isError: false,
        content: [
          { type: 'resource_link', uri: `artifact://${shots.get(name)?.sha256}`, mimeType: 'image/png' },
        ],
      }),
    )
  const openOp = (key: string, until: number) => {
    database
      .prepare(
        "INSERT INTO registers (session_key, register, key, seq, data) VALUES (?, 'op.state', ?, 1, '{}')",
      )
      .run(key, new TextEncoder().encode('main'))
    database
      .prepare("INSERT INTO writer_claims (session_key, run_id, until, ttl_ms) VALUES (?, 'run', ?, 30000)")
      .run(key, until)
  }
  const marker = (name: string) =>
    JSON.parse(readFileSync(computerUseMarkerPath(dataDir, shots.get(name)?.sha256 ?? ''), 'utf8')) as {
      schemaVersion: number
      collectedAtMs?: number
      size: number
    }
  const runtime = (
    overrides: Partial<Record<keyof typeof retention, number>> = {},
    onPressure?: () => void,
  ) =>
    createComputerUseArtifactGcRuntime({
      dataDir,
      retention: { ...retention, globalMaxBytes: total - 1, ...overrides },
      clock: () => NOW,
      ...(onPressure ? { onPressure } : {}),
    })
  const get = (name: string) => {
    const found = shots.get(name)
    if (!found) throw new Error(name)
    return createLocalArtifactReadStore({ dataDir, maxArtifactBytes: 1024 }).get(
      { sha256: found.sha256, size: found.bytes.byteLength, mime: 'image/png' },
      new AbortController().signal,
    )
  }
  /** Runs `after` once, right after the collector plans its protected set. */
  const afterPlanning = (after: () => void) => {
    const actual = vi.mocked(planRetentionProtection).getMockImplementation()
    vi.mocked(planRetentionProtection).mockImplementationOnce(async (input) => {
      const planned = await (actual ?? planRetentionProtection)(input)
      after()
      return planned
    })
  }
  return { dataDir, shots, total, database, shot, openOp, marker, runtime, get, afterPlanning }
}

describe.skipIf(!privateArtifactDeleteAvailable())('Computer Use artifact GC referenced eviction', () => {
  it('reclaims the least recently referenced screenshot above the cap, tombstone first', async () => {
    const fixture = await referencedFixture(['a1', 'a2', 'a3'])
    for (const [seq, name] of ['a1', 'a2', 'a3'].entries()) fixture.shot('a', seq + 1, name, T0 + seq * 1000)
    const runtime = fixture.runtime()
    try {
      await expect(runtime.trigger()).resolves.toMatchObject({ deleted: 1, unresolvedPressureBytes: 0 })
      expect(existsSync(fixture.shots.get('a1')?.artifact ?? '')).toBe(false)
      expect(fixture.marker('a1')).toEqual({
        schemaVersion: 2,
        sha256: fixture.shots.get('a1')?.sha256,
        size: fixture.shots.get('a1')?.bytes.byteLength,
        createdAtMs: 0,
        collectedAtMs: NOW,
      })
      expect(fixture.marker('a2').schemaVersion).toBe(1)
      await expect(fixture.get('a1')).rejects.toBe(ARTIFACT_RECLAIMED_FAILURE)
      await expect(fixture.get('a2')).resolves.toEqual(fixture.shots.get('a2')?.bytes)
    } finally {
      await runtime.close()
      fixture.database.close()
    }
  })

  it("keeps an active session's recent screenshots and reports the pressure instead", async () => {
    const fixture = await referencedFixture(['a1', 'a2'])
    fixture.shot('a', 1, 'a1', T0)
    fixture.shot('a', 2, 'a2', T0 + 1000)
    fixture.openOp('a', NOW + 60_000)
    const onPressure = vi.fn()
    const runtime = fixture.runtime({}, onPressure)
    try {
      await expect(runtime.trigger()).resolves.toMatchObject({ deleted: 0, unresolvedPressureBytes: 1 })
      expect(onPressure).toHaveBeenCalledTimes(1)
      expect(fixture.marker('a1').schemaVersion).toBe(1)
    } finally {
      await runtime.close()
      fixture.database.close()
    }
  })

  it('deletes nothing when a session turns active between planning and the lock and its image is due', async () => {
    const fixture = await referencedFixture(['a1', 'a2'])
    fixture.shot('a', 1, 'a1', T0)
    fixture.shot('a', 2, 'a2', T0 + 1000)
    fixture.afterPlanning(() => fixture.openOp('a', NOW + 60_000))
    const runtime = fixture.runtime()
    try {
      await expect(runtime.trigger()).rejects.toThrow('reachability snapshot changed')
      expect(existsSync(fixture.shots.get('a1')?.artifact ?? '')).toBe(true)
      // The tombstone was written before the lock; with the bytes still there, readers use them.
      expect(fixture.marker('a1').schemaVersion).toBe(2)
      await expect(fixture.get('a1')).resolves.toEqual(fixture.shots.get('a1')?.bytes)
    } finally {
      await runtime.close()
      fixture.database.close()
    }
  })

  it('goes on when protection moved only outside the planned deletions', async () => {
    const names = ['a1', 'b1', 'b2', 'b3', 'b4', 'b5']
    const fixture = await referencedFixture(names)
    fixture.shot('a', 1, 'a1', T0)
    for (let seq = 1; seq <= 5; seq += 1) fixture.shot('b', seq, `b${seq}`, NOW - 10_000 + seq)
    // A newer row showing b1 again pushes b3 out of b's newest three; neither is being deleted.
    fixture.afterPlanning(() => fixture.shot('b', 6, 'b1', NOW - 5_000))
    const runtime = fixture.runtime({ maxRecentPerSession: 1 })
    try {
      await expect(runtime.trigger()).resolves.toMatchObject({ deleted: 1 })
      expect(existsSync(fixture.shots.get('a1')?.artifact ?? '')).toBe(false)
      for (const name of names.slice(1))
        expect(existsSync(fixture.shots.get(name)?.artifact ?? '')).toBe(true)
    } finally {
      await runtime.close()
      fixture.database.close()
    }
  })

  it('deletes nothing once the proof under the ledger lock has taken more than two seconds', async () => {
    const fixture = await referencedFixture(['a1', 'a2'])
    fixture.shot('a', 1, 'a1', T0)
    fixture.shot('a', 2, 'a2', T0 + 1000)
    const actual = vi.mocked(verifyRootsUnderLedgerLock).getMockImplementation()
    vi.mocked(verifyRootsUnderLedgerLock).mockImplementationOnce(async (input) => {
      const result = await (actual ?? verifyRootsUnderLedgerLock)(input)
      const now = performance.now.bind(performance)
      const skew = now()
      vi.spyOn(performance, 'now').mockImplementation(() => now() + (now() >= skew ? 2_001 : 0))
      return result
    })
    const runtime = fixture.runtime()
    try {
      await expect(runtime.trigger()).rejects.toThrow('took too long')
      expect(existsSync(fixture.shots.get('a1')?.artifact ?? '')).toBe(true)
    } finally {
      await runtime.close()
      fixture.database.close()
    }
  })

  it('gives every index wait under the ledger lock one shared one-second deadline', async () => {
    const fixture = await referencedFixture(['a1', 'a2'])
    fixture.shot('a', 1, 'a1', T0)
    fixture.shot('a', 2, 'a2', T0 + 1000)
    const indexFile = join(fixture.dataDir, 'artifacts', ARTIFACT_REF_INDEX_FILE)
    const exec = DatabaseSync.prototype.exec
    const holders: DatabaseSync[] = []
    const hold = (releaseAfterMs: number) => {
      const holder = new DatabaseSync(indexFile)
      holders.push(holder)
      exec.call(holder, 'BEGIN IMMEDIATE')
      setTimeout(() => {
        if (holder.isTransaction) exec.call(holder, 'ROLLBACK')
      }, releaseAfterMs)
    }
    let lockedAt = 0
    let releasedAt = 0
    const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      const result = exec.call(this, sql)
      if (!lockedAt && sql.includes('busy_timeout') && sql.includes('BEGIN IMMEDIATE')) {
        lockedAt = performance.now()
        // Busy for most of the budget, free just long enough for the root proof, then busy again.
        hold(800)
      } else if (lockedAt && !releasedAt && sql === 'ROLLBACK') releasedAt = performance.now()
      return result
    })
    const actual = vi.mocked(verifyRootsUnderLedgerLock).getMockImplementation()
    vi.mocked(verifyRootsUnderLedgerLock).mockImplementationOnce(async (input) => {
      const result = await (actual ?? verifyRootsUnderLedgerLock)(input)
      hold(3_000)
      return result
    })
    const runtime = fixture.runtime()
    try {
      await expect(runtime.trigger()).rejects.toThrow('reference index is busy')
      expect(releasedAt - lockedAt).toBeLessThan(1_400)
      expect(existsSync(fixture.shots.get('a1')?.artifact ?? '')).toBe(true)
    } finally {
      spy.mockRestore()
      for (const holder of holders) {
        if (holder.isTransaction) holder.exec('ROLLBACK')
        holder.close()
      }
      await runtime.close()
      fixture.database.close()
    }
  }, 15_000)

  it('leaves tombstone plus bytes for the part of a batch that was not deleted', async () => {
    const fixture = await referencedFixture(['a1', 'a2', 'a3'])
    for (const [seq, name] of ['a1', 'a2', 'a3'].entries()) fixture.shot('a', seq + 1, name, T0 + seq * 1000)
    const actual = vi.mocked(deletePrivateArtifactSync).getMockImplementation()
    let calls = 0
    vi.mocked(deletePrivateArtifactSync).mockImplementation((...args) => {
      calls += 1
      if (calls === 2) throw new Error('injected delete failure')
      return (actual ?? deletePrivateArtifactSync)(...args)
    })
    const a3 = fixture.shots.get('a3')?.bytes.byteLength ?? 0
    const runtime = fixture.runtime({ globalMaxBytes: a3 })
    try {
      await expect(runtime.trigger()).rejects.toThrow('injected delete failure')
      const gone = ['a1', 'a2'].filter((name) => !existsSync(fixture.shots.get(name)?.artifact ?? ''))
      expect(gone).toHaveLength(1)
      for (const name of ['a1', 'a2']) expect(fixture.marker(name).schemaVersion).toBe(2)
      const kept = gone[0] === 'a1' ? 'a2' : 'a1'
      await expect(fixture.get(kept)).resolves.toEqual(fixture.shots.get(kept)?.bytes)
      await expect(fixture.get(gone[0] ?? '')).rejects.toBe(ARTIFACT_RECLAIMED_FAILURE)
    } finally {
      vi.mocked(deletePrivateArtifactSync).mockImplementation(actual ?? deletePrivateArtifactSync)
      await runtime.close()
      fixture.database.close()
    }
  })

  it('writes no tombstone for an unreferenced screenshot', async () => {
    const fixture = await referencedFixture(['orphan'])
    const runtime = fixture.runtime({ globalMaxBytes: 1024 * 1024 })
    try {
      await expect(runtime.trigger()).resolves.toMatchObject({ deleted: 1 })
      expect(fixture.marker('orphan').schemaVersion).toBe(1)
      await expect(fixture.get('orphan')).rejects.not.toBe(ARTIFACT_RECLAIMED_FAILURE)
    } finally {
      await runtime.close()
      fixture.database.close()
    }
  })
})
