// The real daemon pieces for batch tests: startSupervisor, the worker pool spawning a real worker
// (fixtures/batch-worker-entry.ts) whose Host loads the real @agnes/base extensions, the real job
// scheduler and the batch engine, over one SQLite file. Only the model is scripted.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, DEFAULT_COMPUTER_USE, hashInput, type ResolvedProfile, sha256hex } from '@agnes/host'
import { type DaemonConfig, type DaemonLimits, DEFAULT_LIMITS } from '../src/config.js'
import type { Tables } from '../src/storage/table.js'
import { encodeFrame, JsonlDecoder } from '../src/supervisor/framing.js'
import { daemonSocketPaths } from '../src/supervisor/socket-paths.js'
import { startSupervisor } from '../src/supervisor/supervisor.js'

export const batchWorkerEntry = fileURLToPath(new URL('./fixtures/batch-worker-entry.ts', import.meta.url))

export function batchProfile(dataDir: string): ResolvedProfile {
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

export function batchConfig(dir: string, limits: Partial<DaemonLimits> = {}): DaemonConfig {
  return {
    profileName: 'local-dev',
    dataDir: dir,
    ...daemonSocketPaths({ dataDir: dir, ipc: 'unix' }),
    limits: { ...DEFAULT_LIMITS, workerStartupMs: 30_000, jobsTickMs: 200, ...limits },
  }
}

/** A workspace with `items/<name>` text files; returns its canonical root. */
export function batchWorkspace(dir: string, names: readonly string[]): string {
  const root = realpathSync.native(dir)
  mkdirSync(join(root, 'items'), { recursive: true })
  for (const name of names) writeFileSync(join(root, 'items', name), `content of ${name}\n`)
  return root
}

export function startBatchDaemon(o: {
  dir: string
  tables: Pick<Tables, 'table'>
  limits?: Partial<DaemonLimits>
  /** Another worker entry, such as one that never starts. */
  workerEntry?: string
}): ReturnType<typeof startSupervisor> {
  const profile = batchProfile(o.dir)
  const profileFile = join(o.dir, 'profile.json')
  writeFileSync(profileFile, JSON.stringify(profile))
  return startSupervisor({
    config: batchConfig(o.dir, o.limits),
    profile,
    profileDir: join(o.dir, 'profiles', 'local-dev'),
    profileFile,
    workspaceRoot: o.dir,
    jobTables: o.tables,
    processIdentity: async (pid: number) =>
      pid === process.pid
        ? ({ state: 'alive', startId: 'batch-e2e' } as const)
        : ({ state: 'dead' } as const),
    workerExecPath: process.execPath,
    workerEntry: o.workerEntry ?? batchWorkerEntry,
    workerExecArgv: ['--import', 'tsx'],
  })
}

export type Rpc = { id?: number; method?: string; result?: unknown; error?: { code: number; data?: unknown } }

/** A raw JSON-RPC client on the daemon's local socket, already initialized as the local owner. */
export async function batchClient(path: string): Promise<{
  call(method: string, params: unknown): Promise<Rpc>
  seen: Rpc[]
  close(): void
}> {
  const socket = connect(path)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
  })
  const decoder = new JsonlDecoder()
  const waiting = new Map<number, (message: Rpc) => void>()
  const seen: Rpc[] = []
  socket.on('data', (chunk: Buffer) => {
    for (const message of decoder.feed(chunk) as Rpc[]) {
      seen.push(message)
      if (message.id !== undefined) waiting.get(message.id)?.(message)
    }
  })
  let next = 1
  const call = (method: string, params: unknown): Promise<Rpc> => {
    const id = next++
    return new Promise((resolve) => {
      waiting.set(id, resolve)
      socket.write(encodeFrame({ jsonrpc: '2.0', id, method, params }))
    })
  }
  await call('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    _meta: { 'ai.agnes.harness': { clientId: 'batch-e2e' } },
  })
  return { call, seen, close: () => socket.end() }
}

/** The worker's model trace, one event per line. */
export function traceOf(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

export function setControl(file: string, control: { block?: boolean; escape?: boolean }): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(control))
}
