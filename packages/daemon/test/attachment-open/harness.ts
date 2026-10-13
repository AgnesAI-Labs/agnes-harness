// A real supervisor with a real worker, driven over the daemon socket the way a client drives it:
// the pieces build.ts and measure.ts share.
import { rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { canonicalJson, DEFAULT_COMPUTER_USE, hashInput, type ResolvedProfile, sha256hex } from '@agnes/host'
import { type DaemonConfig, DEFAULT_LIMITS } from '../../src/config.js'
import type { RuntimeLog } from '../../src/runtime-log.js'
import { encodeFrame, JsonlDecoder } from '../../src/supervisor/framing.js'
import { daemonSocketPaths } from '../../src/supervisor/socket-paths.js'
import { startSupervisor } from '../../src/supervisor/supervisor.js'
import { sqliteTables } from '../sqlite-tables.js'

const workerEntry = fileURLToPath(new URL('./worker-entry.ts', import.meta.url))

export type Rpc = { id?: number; method?: string; result?: unknown; error?: unknown }

function buildProfile(dataDir: string): ResolvedProfile {
  const body = {
    name: 'local-dev',
    dataDir,
    seams: { principals: '@agnes/base' },
    computerUse: DEFAULT_COMPUTER_USE,
    presets: { default: 'standard', allowed: ['standard'] },
    provider: {
      routes: [
        {
          route: 'faux',
          api: 'faux',
          baseUrl: 'https://invalid.test',
          models: [{ route: 'faux', id: 'faux-1' }],
        },
      ],
    },
  } as unknown as Omit<ResolvedProfile, 'hash'>
  return { ...body, hash: `sha256-${sha256hex(canonicalJson(hashInput(body)))}` }
}

export type Session = {
  call(method: string, params: unknown): Promise<Rpc>
  /** Like `call`, but a JSON-RPC error becomes an exception naming the method. */
  must(method: string, params: unknown): Promise<Record<string, unknown>>
  close(): Promise<void>
}

/** Starts a supervisor over `dir`, connects a client and initializes it. `close` undoes all of it. */
export async function openSupervisor(dir: string, o: { runtimeLog?: RuntimeLog } = {}): Promise<Session> {
  const profile = buildProfile(dir)
  const profileFile = join(dir, 'profile.json')
  writeFileSync(profileFile, JSON.stringify(profile))
  const tables = sqliteTables(join(dir, 'daemon.sqlite'))
  const ipc = process.platform === 'win32' ? 'pipe' : 'unix' // guards-allow-platform: socket kind, as the daemon's own tests choose it.
  const paths = daemonSocketPaths({ dataDir: dir, ipc })
  const config: DaemonConfig = {
    profileName: 'local-dev',
    dataDir: dir,
    ...paths,
    limits: { ...DEFAULT_LIMITS, workerStartupMs: 120_000, jobsTickMs: 600_000 },
  }
  const supervisor = await startSupervisor({
    config,
    profile,
    profileDir: join(dir, 'profiles', 'local-dev'),
    profileFile,
    workspaceRoot: dir,
    jobTables: tables,
    processIdentity: async (pid: number) =>
      pid === process.pid
        ? ({ state: 'alive', startId: 'attachment-open' } as const)
        : ({ state: 'dead' } as const),
    workerExecPath: process.execPath,
    workerEntry,
    workerExecArgv: ['--import', 'tsx'],
    ...(o.runtimeLog ? { audit: (record: unknown) => o.runtimeLog?.record(record) } : {}),
  })
  const socket = connect(paths.socketPath)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
  })
  const decoder = new JsonlDecoder()
  const pending = new Map<number, (m: Rpc) => void>()
  socket.on('data', (chunk: Buffer) => {
    for (const m of decoder.feed(chunk) as Rpc[]) {
      if (m.id === undefined) continue
      pending.get(m.id)?.(m)
      pending.delete(m.id)
    }
  })
  let nextId = 1
  const call = (method: string, params: unknown): Promise<Rpc> =>
    new Promise((resolve) => {
      const id = nextId++
      pending.set(id, resolve)
      socket.write(encodeFrame({ jsonrpc: '2.0', id, method, params }))
    })
  const must = async (method: string, params: unknown): Promise<Record<string, unknown>> => {
    const reply = await call(method, params)
    if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error).slice(0, 400)}`)
    return (reply.result ?? {}) as Record<string, unknown>
  }
  await must('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  })
  return {
    call,
    must,
    async close() {
      socket.destroy()
      await supervisor.close()
      await tables.close()
      // A long data directory puts the socket in a directory of its own.
      const socketDirectory = dirname(paths.socketPath)
      const ownDirectory = ipc === 'unix' && socketDirectory !== join(dir, 'daemon')
      if (ownDirectory) rmSync(socketDirectory, { recursive: true, force: true })
    },
  }
}

/**
 * Peak resident memory of this process's descendants (the worker), sampled off the main thread with
 * `ps`. Windows has no `ps`: it reports `null` there. `peakMb` waits one sampling interval so
 * samples still queued behind a busy main thread are counted.
 */
export function sampleChildPeaks(): {
  reset(): void
  peakMb(): Promise<number | null>
  stop(): void
} {
  const noPs = process.platform === 'win32' // guards-allow-platform: Windows has no `ps`, so the worker's memory cannot be sampled there.
  if (noPs) return { reset() {}, peakMb: async () => null, stop() {} }
  let peakKb = 0
  const sampler = new Worker(
    `const { parentPort, workerData } = require('node:worker_threads')
     const { execFileSync } = require('node:child_process')
     setInterval(() => {
       try {
         const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=']).toString().trim().split('\\n')
           .map((l) => l.trim().split(/\\s+/).map(Number))
         const kids = new Set([workerData])
         let grew = true
         while (grew) { grew = false; for (const [p, pp] of rows) if (kids.has(pp) && !kids.has(p)) { kids.add(p); grew = true } }
         let total = 0
         for (const [p, , rss] of rows) if (p !== workerData && kids.has(p)) total += rss
         parentPort.postMessage(total)
       } catch {}
     }, 100)`,
    { eval: true, workerData: process.pid },
  )
  sampler.on('message', (kb: number) => {
    peakKb = Math.max(peakKb, kb)
  })
  sampler.unref()
  return {
    reset() {
      peakKb = 0
    },
    async peakMb() {
      await new Promise((resolve) => setTimeout(resolve, 250))
      return Math.round(peakKb / 1024)
    },
    stop() {
      void sampler.terminate()
    },
  }
}
