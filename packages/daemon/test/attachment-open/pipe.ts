// Moves one large scan page from a real worker process to the daemon side of the worker connection
// and times it: the throughput of the named pipe (Windows) or Unix socket the open path depends on,
// with no client, no supervisor methods and no session/load around it.
//
// A single frame may be at most MAX_FRAME_BYTES (144 MiB), so a page larger than that is sent the way
// every scan sends it: as frames that each stay under the cap, the supervisor resuming the same query.
import { realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestHost } from '@agnes/host/testkit'
import { type DaemonConfig, DEFAULT_LIMITS } from '../../src/config.js'
import { RemoteSession } from '../../src/supervisor/remote-session.js'
import { listenUnix } from '../../src/supervisor/socket.js'
import { daemonSocketPaths } from '../../src/supervisor/socket-paths.js'
import { WorkerPool } from '../../src/supervisor/worker-pool.js'
import { workspaceBinding } from '../workspace-authority.js'
import { buildProfile, sampleChildPeaks, workerEntry } from './harness.js'

const MIB = 1024 * 1024
const KEY = 'agnes:local:default:daemon:dm:pipe-bench'
const ROW_TYPE = 'x/agnes/bench/pipe'

export type PipeOptions = {
  /** Total payload of the page: this many MiB of text, spread over rows of `rowMib`. */
  totalMib: number
  /** Text per row, in MiB; a row must fit one frame. */
  rowMib: number
}

export type PipeResult = {
  rows: number
  /** Bytes of row text the page carried. */
  payloadBytes: number
  /** Bytes the daemon side received from the worker while the scan ran (frames included). */
  receivedBytes: number
  /** Frames the page took: one, plus one per resume. */
  frames: number
  ms: number
  mibPerSecond: number
  /** Peak resident memory of the worker during the scan; `null` where it cannot be sampled. */
  workerPeakMb: number | null
}

/** Writes the rows before any worker owns the ledger. Returns the range they occupy. */
async function seed(dir: string, o: PipeOptions): Promise<{ fromSeq: number; toSeq: number; rows: number }> {
  const { host } = await createTestHost({ dataDir: dir, script: [] })
  try {
    const session = await host.createSession({ key: KEY, cwd: dir })
    const rows = Math.ceil(o.totalMib / o.rowMib)
    const fromSeq = session.lastSeq + 1
    for (let i = 0; i < rows; i++) {
      const chars = Math.min(o.rowMib, o.totalMib - i * o.rowMib) * MIB
      // Distinct text per row, so nothing on the way can share one string between rows.
      const text = `${i}:`.padEnd(chars, 'abcdefghijklmnopqrstuvwxyz0123456789')
      await session.append([session.ev(ROW_TYPE, { text }, { ignorable: true })])
    }
    const toSeq = session.lastSeq
    await session.close()
    return { fromSeq, toSeq, rows }
  } finally {
    await host.close()
  }
}

export async function measurePipe(dirIn: string, o: PipeOptions): Promise<PipeResult> {
  if (!(o.rowMib > 0) || !(o.totalMib >= o.rowMib)) throw new Error('need 0 < rowMib <= totalMib')
  // The test workspace authority takes the root as given: hand it the native spelling.
  const dir = realpathSync.native(dirIn)
  const { fromSeq, toSeq, rows } = await seed(dir, o)
  const profile = buildProfile(dir)
  const profileFile = join(dir, 'profile.json')
  writeFileSync(profileFile, JSON.stringify(profile))
  const ipc = process.platform === 'win32' ? 'pipe' : 'unix' // guards-allow-platform: socket kind, as the daemon's own tests choose it.
  const paths = daemonSocketPaths({ dataDir: dir, ipc })
  const config: DaemonConfig = {
    profileName: 'local-dev',
    dataDir: dir,
    ...paths,
    limits: { ...DEFAULT_LIMITS, workerStartupMs: 120_000 },
  }
  const pool = new WorkerPool({
    config,
    profile,
    profileFile,
    execPath: process.execPath,
    workerEntry,
    execArgv: ['--import', 'tsx'],
    clock: () => Date.now(),
    onEvent: () => undefined,
    onRequest: async () => undefined,
    notices: { emit() {} },
  })
  const server = await listenUnix(config.workersSocketPath, (socket) => pool.adopt(socket))
  const peaks = sampleChildPeaks()
  try {
    // Opening verifies the whole ledger in the worker; that is not part of the measurement.
    const link = await pool.acquire(KEY, {
      resume: true,
      cwd: dir,
      binding: await workspaceBinding(KEY, dir),
    })
    const hello = await link.hello
    const remote = new RemoteSession(KEY, hello.writerRunId, hello.generation, link, dir)
    peaks.reset()
    const receivedAtStart = link.receivedBytes()
    const resumesAtStart = remote.scanResumes
    const startedAt = performance.now()
    const page = (await remote.scan({ fromSeq, toSeq, limit: rows })) as Array<{
      seq: number
      data: { text: string }
    }>
    const ms = performance.now() - startedAt
    const receivedBytes = link.receivedBytes() - receivedAtStart
    const workerPeakMb = await peaks.peakMb()
    if (page.length !== rows || page[0]?.seq !== fromSeq || page.at(-1)?.seq !== toSeq)
      throw new Error(`the scan returned ${page.length} of ${rows} rows`)
    const payloadBytes = page.reduce((sum, row) => sum + row.data.text.length, 0)
    return {
      rows,
      payloadBytes,
      receivedBytes,
      frames: 1 + remote.scanResumes - resumesAtStart,
      ms,
      mibPerSecond: receivedBytes / MIB / (ms / 1000),
      workerPeakMb,
    }
  } finally {
    peaks.stop()
    await pool.closeAll(5_000)
    await server.close()
  }
}
