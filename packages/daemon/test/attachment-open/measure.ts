// Opens a built session cold through a real supervisor and worker, the way a client reopening the
// session does, and measures what that cost.

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openRuntimeLog } from '../../src/runtime-log.js'
import { uploadOver } from './build.js'
import { openSupervisor, sampleChildPeaks } from './harness.js'

export type ColdLoadResult = {
  loadMs: number
  /** Peak resident memory of the worker process during the load; `null` where it cannot be sampled. */
  workerPeakMb: number | null
  /** Bytes the supervisor received from the worker while opening and replaying the session. */
  transferBytes: number
  /**
   * The supervisor's `scanResumes` (the `resumes` of `session.load`): scan pages that did not fit one
   * worker frame and were continued in another reply. A resume re-reads nothing; the name is kept.
   */
  splitScans: number
  maxRowBytes: number
  dbBytes: number
  /** How long the background full verification took; `null` until the build runs one. */
  verifyFullMs: number | null
  /** The `session.open`, `session.load` and `session.verify_full` records this load wrote. */
  records: unknown[]
}

type LogRow = { kind: string; detail?: Record<string, unknown> }
const OPEN_KINDS = new Set(['session.open', 'session.load', 'session.verify_full'])

function readRecords(dir: string): LogRow[] {
  const file = join(dir, 'audit', 'runtime.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogRow)
    .filter((row) => OPEN_KINDS.has(row.kind))
}

function ledgerShape(dir: string): { maxRowBytes: number; dbBytes: number } {
  const file = join(dir, 'sessions.db')
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const row = db.prepare('SELECT max(octet_length(data)) AS max FROM events').get() as {
      max: number | null
    }
    const wal = `${file}-wal`
    return {
      maxRowBytes: row.max ?? 0,
      dbBytes: statSync(file).size + (existsSync(wal) ? statSync(wal).size : 0),
    }
  } finally {
    db.close()
  }
}

/** How long a background verification started by this open may take to leave its record. */
const VERIFY_WAIT_MS = 30_000

export async function measureColdLoad(dir: string): Promise<ColdLoadResult> {
  const sessionId = readFileSync(join(dir, 'session-id'), 'utf8')
  const runtimeLog = openRuntimeLog(dir)
  const peaks = sampleChildPeaks()
  const before = readRecords(dir).length
  const session = await openSupervisor(dir, { runtimeLog })
  let loadMs: number
  let workerPeakMb: number | null
  try {
    peaks.reset()
    const startedAt = performance.now()
    const reply = await session.call('session/load', { sessionId, cwd: dir, mcpServers: [] })
    loadMs = performance.now() - startedAt
    if (reply.error)
      throw new Error(
        `session/load failed after ${Math.round(loadMs)} ms: ${JSON.stringify(reply.error).slice(0, 300)}`,
      )
    workerPeakMb = await peaks.peakMb()
    // An open that used a checkpoint verifies the rest of the ledger in the background.
    const opened = () =>
      readRecords(dir)
        .slice(before)
        .find((row) => row.kind === 'session.open')
    if ((opened()?.detail?.checkpoint as { used?: boolean } | undefined)?.used === true) {
      const deadline = Date.now() + VERIFY_WAIT_MS
      while (
        Date.now() < deadline &&
        !readRecords(dir)
          .slice(before)
          .some((row) => row.kind === 'session.verify_full')
      )
        await new Promise((resolve) => setTimeout(resolve, 100))
    }
  } finally {
    peaks.stop()
    await session.close()
    await runtimeLog.close()
  }
  const records = readRecords(dir).slice(before)
  const load = records.find((row) => row.kind === 'session.load')
  if (!load?.detail) throw new Error('the load wrote no session.load record')
  // The worker's own record: without it the worker-to-supervisor path is not wired.
  const opened = records.find((row) => row.kind === 'session.open')
  if (opened?.detail?.outcome !== 'ok' || !(Number(opened.detail.lastSeq) > 0))
    throw new Error('the load wrote no successful session.open record')
  const verify = records.find((row) => row.kind === 'session.verify_full')
  return {
    loadMs,
    workerPeakMb,
    transferBytes: Number(load.detail.transferBytes),
    splitScans: Number(load.detail.resumes ?? 0),
    ...ledgerShape(dir),
    verifyFullMs: typeof verify?.detail?.ms === 'number' ? verify.detail.ms : null,
    records,
  }
}

/** Uploads `mb` MiB end to end over a real supervisor connection and times it, commit included. */
export async function measureUpload(dir: string, mb: number): Promise<{ ms: number; bytes: number }> {
  const session = await openSupervisor(dir)
  try {
    const sessionId = (await session.must('session/new', { cwd: dir, mcpServers: [] })).sessionId as string
    const bytes = randomBytes(mb * 1024 * 1024)
    const startedAt = performance.now()
    const block = await uploadOver(session)(sessionId, bytes, 'upload.bin', 'application/octet-stream')
    const ms = performance.now() - startedAt
    if ((block as { attachment?: { bytes?: number } }).attachment?.bytes !== bytes.length)
      throw new Error('the upload did not store every byte')
    return { ms, bytes: bytes.length }
  } finally {
    await session.close()
  }
}
