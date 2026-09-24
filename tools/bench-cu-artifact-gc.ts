import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { DDL } from '../packages/host/src/adapters/ddl.js'
import { createPlatform } from '../packages/host/src/adapters/platform.js'
import { scanComputerUseArtifactCandidates } from '../packages/host/src/artifact-gc-candidate-scanner.js'
import { extractArtifactRefs } from '../packages/host/src/artifact-ledger-refs.js'
import {
  ARTIFACT_REF_INDEX_FILE,
  catchUpArtifactRefIndex,
  openArtifactRefIndex,
  readIndexedActivity,
  readIndexedRoots,
  verifyRootsUnderLedgerLock,
} from '../packages/host/src/artifact-ref-index.js'
import { planRetentionProtection } from '../packages/host/src/artifact-retention-protection.js'
import { createComputerUseArtifactGcRuntime } from '../packages/host/src/computer-use-artifact-gc.js'
import {
  createPrivateArtifactStore,
  withComputerUseArtifactMutation,
  writeComputerUseTombstoneLocked,
} from '../packages/host/src/private-artifact-store.js'

// Computer Use artifact GC evidence. Every dataset lives in a fresh temporary data directory that is
// removed afterwards. Usage: tsx tools/bench-cu-artifact-gc.ts [--mib 1024] [--sessions 200]
// [--wide-sessions 10000] [--screenshots 64] [--runs 20] [--only referenced]
const readNumber = (flag: string, fallback: number): number => {
  const index = process.argv.indexOf(flag)
  const value = index < 0 ? fallback : Number(process.argv[index + 1])
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${flag} must be a positive integer`)
  return value
}
const ledgerMiB = readNumber('--mib', 1024)
const sessionCount = readNumber('--sessions', 200)
const wideSessions = readNumber('--wide-sessions', 10_000)
const screenshots = readNumber('--screenshots', 64)
const runs = readNumber('--runs', 20)

const digest = (n: number) => createHash('sha256').update(`shot-${n}`).digest('hex')
const percentile = (values: readonly number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0
}
const round = (value: number) => Math.round(value * 10) / 10

function createLedger(dataDir: string) {
  const database = new DatabaseSync(join(dataDir, 'sessions.db'))
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA synchronous = NORMAL')
  for (const ddl of DDL) database.exec(ddl)
  const insert = database.prepare(
    `INSERT INTO events (session_key, seq, ts, id, type, actor, origin, trust, data, integrity_digest)
     VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)`,
  )
  const padding = 'x'.repeat(900)
  const row = (key: string, seq: number, shot: number) => {
    const ts = new Date(Date.UTC(2026, 8, 24) + seq * 1000).toISOString()
    const id = `${key}-${seq}`
    const integrity = createHash('sha1').update(id).digest('hex')
    if (seq % 10 === 0)
      return insert.run(
        key,
        seq,
        ts,
        id,
        'tool/result',
        'tool:computer_use',
        'untrusted',
        JSON.stringify({
          isError: false,
          content: [
            { type: 'text', text: padding },
            {
              type: 'resource_link',
              uri: `artifact://${digest(shot)}`,
              mimeType: 'image/png',
              name: 'image',
            },
          ],
        }),
        integrity,
      )
    if (seq % 10 === 5)
      return insert.run(
        key,
        seq,
        ts,
        id,
        'request/header',
        'system',
        'trusted',
        JSON.stringify({
          media: {
            manifest: Array.from({ length: 3 }, (_, n) => ({
              sha256: digest(shot - n),
              artifactUri: `artifact://${digest(shot - n)}`,
            })),
          },
          padding,
        }),
        integrity,
      )
    return insert.run(
      key,
      seq,
      ts,
      id,
      'assistant/message',
      'model',
      'untrusted',
      JSON.stringify({ text: padding }),
      integrity,
    )
  }
  return { database, row }
}

// Another process committing one ledger row every few milliseconds. With a busy timeout it is
// configured like the storage adapter's connection; without one it fails as soon as it meets a lock.
const COMMITTER = `
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(process.argv[1])
  const busyTimeoutMs = Number(process.argv[2])
  if (busyTimeoutMs > 0) db.exec('PRAGMA busy_timeout = ' + busyTimeoutMs)
  const insert = db.prepare("INSERT INTO events (session_key, seq, ts, id, type, actor, origin, trust, data) VALUES (?, ?, '2026-09-24T00:00:00.000Z', ?, 'user/message', '{}', 'user', 'trusted', '{}')")
  let seq = 0, commits = 0, failures = 0, maxCommitMs = 0, stopped = false
  process.stdin.on('end', () => { stopped = true })
  process.stdin.resume()
  const step = () => {
    if (stopped) {
      db.close()
      process.stdout.write(JSON.stringify({ commits, failures, maxCommitMs }))
      return
    }
    const started = performance.now()
    try {
      db.exec('BEGIN IMMEDIATE')
      seq += 1
      insert.run(process.argv[3], seq, process.argv[3] + '-' + seq)
      db.exec('COMMIT')
      commits += 1
      maxCommitMs = Math.max(maxCommitMs, performance.now() - started)
    } catch (error) {
      if (error.errcode !== 5) throw error
      if (db.isTransaction) db.exec('ROLLBACK')
      failures += 1
    }
    setTimeout(step, 2)
  }
  step()
`

/**
 * Ledger write-lock hold of the locked verification while another process commits, and how many of
 * that process's commits fail.
 */
async function contendedLockedRounds(
  file: string,
  index: DatabaseSync,
  candidates: ReadonlySet<string>,
  busyTimeoutMs: number,
) {
  const committer = spawn(process.execPath, [
    '-e',
    COMMITTER,
    file,
    String(busyTimeoutMs),
    `committer-${busyTimeoutMs}`,
  ])
  let output = ''
  let errors = ''
  committer.stdout.on('data', (chunk) => {
    output += String(chunk)
  })
  committer.stderr.on('data', (chunk) => {
    errors += String(chunk)
  })
  const exited = once(committer, 'exit')
  const reader = new DatabaseSync(file, { readOnly: true })
  const holdMs: number[] = []
  try {
    await delay(50)
    for (let run = 0; run < runs; run += 1) {
      await catchUpArtifactRefIndex({ ledger: reader, index, signal: new AbortController().signal })
      const locked = new DatabaseSync(file)
      locked.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE')
      const held = performance.now()
      const proven = await verifyRootsUnderLedgerLock({ ledger: locked, index, candidates })
      locked.exec('ROLLBACK')
      holdMs.push(performance.now() - held)
      locked.close()
      if (!proven) throw new Error('locked verification unexpectedly declined')
      await delay(20)
    }
  } finally {
    reader.close()
    committer.stdin.end()
  }
  const [code] = (await exited) as [number | null]
  if (code !== 0) throw new Error(`ledger committer exited with ${code}: ${errors}`)
  const result = JSON.parse(output) as { commits: number; failures: number; maxCommitMs: number }
  return {
    lockHoldP50Ms: round(percentile(holdMs, 0.5)),
    lockHoldP99Ms: round(percentile(holdMs, 0.99)),
    commits: result.commits,
    failedCommits: result.failures,
    maxCommitMs: round(result.maxCommitMs),
  }
}

/** Old algorithm, kept only here as the baseline: one full-table pass with the shared extractor. */
function fullScan(file: string): number {
  const database = new DatabaseSync(file, { readOnly: true })
  const started = performance.now()
  try {
    const found = new Set<string>()
    for (const raw of database
      .prepare('SELECT type, data FROM events ORDER BY session_key, seq')
      .iterate() as Iterable<{
      type: string
      data: string
    }>)
      for (const sha of extractArtifactRefs(raw).ledger) found.add(sha)
    return performance.now() - started
  } finally {
    database.close()
  }
}

async function ledgerDataset(label: string, sessions: number, rowsPerSession: number) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-cu-gc-bench-'))
  try {
    const ledger = createLedger(dataDir)
    const seeded = performance.now()
    let shot = 0
    ledger.database.exec('BEGIN')
    for (let session = 0; session < sessions; session += 1)
      for (let seq = 1; seq <= rowsPerSession; seq += 1) {
        if (seq % 10 === 0) shot += 1
        ledger.row(`session-${String(session).padStart(6, '0')}`, seq, shot)
      }
    ledger.database.exec('COMMIT')
    ledger.database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const file = join(dataDir, 'sessions.db')
    const ledgerBytes = statSync(file).size
    const seedMs = performance.now() - seeded
    const baselineFullScanMs = fullScan(file)

    // Unlocked backfill with a publisher taking the screenshot lock every 50 ms.
    const index = await openArtifactRefIndex(dataDir)
    const reader = new DatabaseSync(file, { readOnly: true })
    const loop = monitorEventLoopDelay({ resolution: 5 })
    const publishWaits: number[] = []
    let backfilling = true
    const publisher = (async () => {
      while (backfilling) {
        const started = performance.now()
        await withComputerUseArtifactMutation(dataDir, async () => undefined)
        publishWaits.push(performance.now() - started)
        await delay(50)
      }
    })()
    loop.enable()
    const started = performance.now()
    await catchUpArtifactRefIndex({ ledger: reader, index, signal: new AbortController().signal })
    const backfillMs = performance.now() - started
    loop.disable()
    backfilling = false
    await publisher

    // Steady state: one simulated hour of new rows, then the reference collection segment.
    const candidates = new Set(Array.from({ length: Math.min(shot, 5000) }, (_, n) => digest(shot - n)))
    const collectMs: number[] = []
    const lockedMs: number[] = []
    let next = rowsPerSession
    for (let run = 0; run < runs; run += 1) {
      ledger.database.exec('BEGIN')
      for (let n = 0; n < 100; n += 1)
        ledger.row(
          `session-${String(n % sessions).padStart(6, '0')}`,
          next + 1 + Math.floor(n / sessions),
          shot,
        )
      ledger.database.exec('COMMIT')
      next += Math.ceil(100 / sessions)
      const collect = performance.now()
      await catchUpArtifactRefIndex({ ledger: reader, index, signal: new AbortController().signal })
      await readIndexedRoots(index, candidates)
      collectMs.push(performance.now() - collect)
      // Rows that land between planning and the lock are extracted under it.
      ledger.database.exec('BEGIN')
      for (let n = 0; n < 20; n += 1)
        ledger.row(
          `session-${String(n % sessions).padStart(6, '0')}`,
          next + 1 + Math.floor(n / sessions),
          shot,
        )
      ledger.database.exec('COMMIT')
      next += Math.ceil(20 / sessions)
      const locked = new DatabaseSync(file)
      locked.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE')
      const verify = performance.now()
      const proven = await verifyRootsUnderLedgerLock({ ledger: locked, index, candidates })
      lockedMs.push(performance.now() - verify)
      locked.exec('ROLLBACK')
      locked.close()
      if (!proven) throw new Error('locked verification unexpectedly declined')
    }
    // Idle rounds: nothing new since the last catch-up, so both paths only confirm the cursors.
    await catchUpArtifactRefIndex({ ledger: reader, index, signal: new AbortController().signal })
    const idleCatchUpMs: number[] = []
    const idleLockedMs: number[] = []
    for (let run = 0; run < runs; run += 1) {
      const idle = performance.now()
      await catchUpArtifactRefIndex({ ledger: reader, index, signal: new AbortController().signal })
      idleCatchUpMs.push(performance.now() - idle)
      const locked = new DatabaseSync(file)
      locked.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE')
      const verify = performance.now()
      await verifyRootsUnderLedgerLock({ ledger: locked, index, candidates })
      idleLockedMs.push(performance.now() - verify)
      locked.exec('ROLLBACK')
      locked.close()
    }
    reader.close()
    const contendedWithoutBusyTimeout = await contendedLockedRounds(file, index, candidates, 0)
    const contendedWithBusyTimeout = await contendedLockedRounds(file, index, candidates, 5000)
    index.close()
    return {
      dataset: label,
      sessions,
      rows: sessions * rowsPerSession,
      ledgerMiB: round(ledgerBytes / 1024 / 1024),
      seedMs: round(seedMs),
      baselineFullScanMs: round(baselineFullScanMs),
      backfillMs: round(backfillMs),
      backfillMaxLoopStallMs: round(loop.max / 1e6),
      backfillPublishWaitMaxMs: round(Math.max(0, ...publishWaits)),
      backfillPublications: publishWaits.length,
      steadyCollectP50Ms: round(percentile(collectMs, 0.5)),
      steadyCollectP99Ms: round(percentile(collectMs, 0.99)),
      lockedVerifyP50Ms: round(percentile(lockedMs, 0.5)),
      lockedVerifyP99Ms: round(percentile(lockedMs, 0.99)),
      idleCatchUpP50Ms: round(percentile(idleCatchUpMs, 0.5)),
      idleCatchUpP99Ms: round(percentile(idleCatchUpMs, 0.99)),
      idleLockedVerifyP50Ms: round(percentile(idleLockedMs, 0.5)),
      idleLockedVerifyP99Ms: round(percentile(idleLockedMs, 0.99)),
      indexMiB: round(statSync(join(dataDir, 'artifacts', ARTIFACT_REF_INDEX_FILE)).size / 1024 / 1024),
      contendedWithoutBusyTimeout,
      contendedWithBusyTimeout,
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
}

/** Candidate scan and one physical deletion batch for expired orphan screenshots. */
async function deletionDataset() {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-cu-gc-delete-'))
  try {
    const os = createPlatform().os
    if (os !== 'win32' && os !== 'darwin' && os !== 'linux') throw new Error(`unsupported platform ${os}`)
    const store = createPrivateArtifactStore(dataDir, os)
    const size = 512 * 1024
    for (let n = 0; n < screenshots; n += 1) {
      const bytes = randomBytes(size)
      const sha = createHash('sha256').update(bytes).digest('hex')
      await store.put(sha, bytes)
      await store.putComputerUseMetadata(
        sha,
        new TextEncoder().encode(
          `${JSON.stringify({ schemaVersion: 1, sha256: sha, size, createdAtMs: 0 }, null, 2)}\n`,
        ),
      )
    }
    createLedger(dataDir).database.close()
    const scan = performance.now()
    await scanComputerUseArtifactCandidates(dataDir)
    const candidateScanMs = performance.now() - scan
    const runtime = createComputerUseArtifactGcRuntime({
      dataDir,
      retention: {
        maxRecentPerSession: 100,
        ttlMs: 60_000,
        gcIntervalMs: 3_600_000,
        maxExtendedTtlMs: 604_800_000,
        globalMaxBytes: 1024 * 1024 * 1024,
      },
      clock: () => 120_000,
    })
    const started = performance.now()
    const result = await runtime.trigger()
    const roundMs = performance.now() - started
    await runtime.close()
    return {
      dataset: `${screenshots} x 512 KiB expired orphans`,
      candidateScanMs: round(candidateScanMs),
      gcRoundMs: round(roundMs),
      deleted: result.deleted,
      batches: result.batches,
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
}

const T0 = Date.UTC(2026, 8, 24)
const NOW = T0 + 86_400_000

/** One Computer Use screenshot row per call, at `tsMs`, in a session's own seq space. */
function shotRows(database: DatabaseSync) {
  const insert = database.prepare(
    `INSERT INTO events (session_key, seq, ts, id, type, actor, origin, trust, data, integrity_digest)
     VALUES (?, ?, ?, ?, 'tool/result', '{}', 'tool:computer_use', 'untrusted', ?, ?)`,
  )
  const filler = database.prepare(
    `INSERT INTO events (session_key, seq, ts, id, type, actor, origin, trust, data, integrity_digest)
     VALUES (?, ?, ?, ?, 'assistant/message', '{}', 'model', 'untrusted', ?, ?)`,
  )
  const padding = 'x'.repeat(900)
  return {
    shot: (key: string, seq: number, sha: string, tsMs: number) =>
      insert.run(
        key,
        seq,
        new Date(tsMs).toISOString(),
        `${key}-${seq}`,
        JSON.stringify({
          isError: false,
          content: [
            { type: 'resource_link', uri: `artifact://${sha}`, mimeType: 'image/png', name: 'image' },
          ],
        }),
        `d-${key}-${seq}`,
      ),
    filler: (key: string, seq: number, tsMs: number) =>
      filler.run(
        key,
        seq,
        new Date(tsMs).toISOString(),
        `${key}-${seq}`,
        JSON.stringify({ text: padding }),
        `d-${key}-${seq}`,
      ),
  }
}

/**
 * Referenced eviction: tombstone writes, ledger-lock hold per batch (index wait, delta, protection
 * recompute, boundary checks and the deletions), the bounded ancestor read, and the active-set read.
 */
async function referencedDataset() {
  const os = createPlatform().os
  if (os !== 'win32' && os !== 'darwin' && os !== 'linux') throw new Error(`unsupported platform ${os}`)

  // 1. Tombstone writes for one full batch, under the screenshot lock, outside the ledger lock.
  const tombDir = mkdtempSync(join(tmpdir(), 'agnes-cu-gc-tomb-'))
  let tombstoneMs = 0
  try {
    const shas = Array.from({ length: 64 }, (_, n) => digest(1_000_000 + n))
    const started = performance.now()
    await withComputerUseArtifactMutation(tombDir, async () => {
      for (const sha of shas)
        await writeComputerUseTombstoneLocked(tombDir, os, {
          sha256: sha,
          size: 65_536,
          createdAtMs: 0,
          collectedAtMs: NOW,
        })
    })
    tombstoneMs = performance.now() - started
  } finally {
    rmSync(tombDir, { recursive: true, force: true })
  }

  // 2. Whole runtime rounds over a referenced store above its cap; each batch is one lock hold.
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-cu-gc-referenced-'))
  const holds: number[] = []
  let gcRound:
    | Awaited<ReturnType<ReturnType<typeof createComputerUseArtifactGcRuntime>['trigger']>>
    | undefined
  try {
    const store = createPrivateArtifactStore(dataDir, os)
    const size = 64 * 1024
    const ledger = createLedger(dataDir)
    const rows = shotRows(ledger.database)
    const stored = screenshots * 20
    const shaOf = new Map<number, string>()
    for (let n = 0; n < stored; n += 1) {
      const bytes = randomBytes(size)
      const sha = createHash('sha256').update(bytes).digest('hex')
      shaOf.set(n, sha)
      await store.put(sha, bytes)
      await store.putComputerUseMetadata(
        sha,
        new TextEncoder().encode(
          `${JSON.stringify({ schemaVersion: 1, sha256: sha, size, createdAtMs: 0 }, null, 2)}\n`,
        ),
      )
    }
    // 200 sessions of 50 rows, one screenshot every 5 rows; the last 20 sessions are recent (active).
    ledger.database.exec('BEGIN')
    let next = 0
    for (let session = 0; session < 200; session += 1) {
      const key = `s-${String(session).padStart(4, '0')}`
      const base = session >= 180 ? NOW - 30_000 : T0
      for (let seq = 1; seq <= 50; seq += 1)
        if (seq % 5 === 0 && next < stored) rows.shot(key, seq, shaOf.get(next++) ?? '', base + seq)
        else rows.filler(key, seq, base + seq)
    }
    ledger.database.exec('COMMIT')
    ledger.database.close()
    const exec = DatabaseSync.prototype.exec
    const lockedAt = new WeakMap<DatabaseSync, number>()
    DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
      const result = exec.call(this, sql)
      if (sql.includes('busy_timeout') && sql.includes('BEGIN IMMEDIATE'))
        lockedAt.set(this, performance.now())
      else if ((sql === 'COMMIT' || sql === 'ROLLBACK') && lockedAt.has(this)) {
        holds.push(performance.now() - (lockedAt.get(this) ?? 0))
        lockedAt.delete(this)
      }
      return result
    }
    try {
      const runtime = createComputerUseArtifactGcRuntime({
        dataDir,
        retention: {
          maxRecentPerSession: 20,
          ttlMs: 60_000,
          gcIntervalMs: 3_600_000,
          maxExtendedTtlMs: 604_800_000,
          globalMaxBytes: (stored * size) / 4,
        },
        clock: () => NOW,
      })
      gcRound = await runtime.trigger()
      await runtime.close()
    } finally {
      DatabaseSync.prototype.exec = exec
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }

  // 3 and 4. Protection planning: forked children over long parents, then S sessions all active.
  const planDir = mkdtempSync(join(tmpdir(), 'agnes-cu-gc-protect-'))
  try {
    const ledger = createLedger(planDir)
    const rows = shotRows(ledger.database)
    ledger.database.exec('BEGIN')
    const forks = ledger.database.prepare(
      "INSERT INTO sessions (session_key, parent_key, boundary_seq, created_at) VALUES (?, ?, ?, '')",
    )
    for (let parent = 0; parent < 20; parent += 1) {
      const key = `p-${parent}`
      // 5000 parent rows with a screenshot only every 500: the child's backward read hits its budget.
      for (let seq = 1; seq <= 5000; seq += 1)
        if (seq % 500 === 0) rows.shot(key, seq, digest(parent * 100 + seq / 500), T0 + seq)
        else rows.filler(key, seq, T0 + seq)
      forks.run(`c-${parent}`, key, 5000)
      rows.filler(`c-${parent}`, 5001, NOW - 1000)
    }
    ledger.database.exec('COMMIT')
    const candidates = new Set(Array.from({ length: 2000 }, (_, n) => digest(n)))
    const index = await openArtifactRefIndex(planDir)
    const reader = new DatabaseSync(join(planDir, 'sessions.db'), { readOnly: true })
    await catchUpArtifactRefIndex({ ledger: reader, index, signal: new AbortController().signal })
    const settings = { nowMs: NOW, ttlMs: 60_000, maxRecent: 20 }
    const ancestorMs: number[] = []
    for (let run = 0; run < runs; run += 1) {
      const started = performance.now()
      await planRetentionProtection({
        ledger: reader,
        index,
        activity: await readIndexedActivity(index),
        candidates,
        settings,
      })
      ancestorMs.push(performance.now() - started)
    }
    // S sessions, each with an open op under a live lease and a screenshot of its own.
    ledger.database.exec('BEGIN')
    const register = ledger.database.prepare(
      "INSERT INTO registers (session_key, register, key, seq, data) VALUES (?, 'op.state', ?, 1, '{}')",
    )
    const claim = ledger.database.prepare(
      "INSERT INTO writer_claims (session_key, run_id, until, ttl_ms) VALUES (?, 'run', ?, 30000)",
    )
    for (let session = 0; session < wideSessions; session += 1) {
      const key = `w-${String(session).padStart(6, '0')}`
      rows.shot(key, 1, digest(10_000 + session), T0 + 1)
      register.run(key, new TextEncoder().encode('main'))
      claim.run(key, NOW + 60_000)
    }
    ledger.database.exec('COMMIT')
    await catchUpArtifactRefIndex({ ledger: reader, index, signal: new AbortController().signal })
    const wideCandidates = new Set(Array.from({ length: 5000 }, (_, n) => digest(10_000 + n)))
    const activeMs: number[] = []
    let protectedCount = 0
    for (let run = 0; run < runs; run += 1) {
      const started = performance.now()
      const protection = await planRetentionProtection({
        ledger: reader,
        index,
        activity: await readIndexedActivity(index),
        candidates: wideCandidates,
        settings,
      })
      activeMs.push(performance.now() - started)
      protectedCount = protection.digests.size
    }
    reader.close()
    index.close()
    ledger.database.close()
    return {
      dataset: `referenced eviction (${screenshots * 20} x 64 KiB referenced, cap 1/4)`,
      tombstoneWrite64Ms: round(tombstoneMs),
      gcRound,
      lockHolds: holds.length,
      lockHoldP50Ms: round(percentile(holds, 0.5)),
      lockHoldP99Ms: round(percentile(holds, 0.99)),
      lockHoldMaxMs: round(Math.max(0, ...holds)),
      ancestorPlan20ForksP50Ms: round(percentile(ancestorMs, 0.5)),
      ancestorPlan20ForksP99Ms: round(percentile(ancestorMs, 0.99)),
      activeSetPlanSessions: wideSessions,
      activeSetPlanP50Ms: round(percentile(activeMs, 0.5)),
      activeSetPlanP99Ms: round(percentile(activeMs, 0.99)),
      activeSetProtected: protectedCount,
    }
  } finally {
    rmSync(planDir, { recursive: true, force: true })
  }
}

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined
const rowsPerSession = Math.max(10, Math.round((ledgerMiB * 1024 * 1024) / 1100 / sessionCount))
const results =
  only === 'referenced'
    ? [await referencedDataset()]
    : [
        await ledgerDataset(`${ledgerMiB} MiB`, sessionCount, rowsPerSession),
        await ledgerDataset(`S=${wideSessions}`, wideSessions, 20),
        await deletionDataset(),
        await referencedDataset(),
      ]
process.stdout.write(
  `${JSON.stringify({ node: process.version, platform: createPlatform().os, results }, null, 2)}\n`,
)
