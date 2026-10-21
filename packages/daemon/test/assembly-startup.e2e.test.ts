import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_COMPUTER_USE, type ResolvedProfile } from '@agnes/host'
import type { PackageManager } from '@agnes/package-manager'
import { afterEach, expect, it, vi } from 'vitest'
import * as clients from '../src/supervisor/assembly-client-listener.js'
import * as modules from '../src/supervisor/assembly-client-modules.js'
import * as runtime from '../src/supervisor/assembly-runtime.js'
import * as stores from '../src/supervisor/assembly-stores.js'
import * as listener from '../src/supervisor/assembly-worker-listener.js'
import * as workers from '../src/supervisor/assembly-workers.js'
import { DEFAULT_LIMITS } from '../src/supervisor/config.js'
import { acquireOwnerLock } from '../src/supervisor/owner-lock.js'
import { listenUnix } from '../src/supervisor/socket.js'
import { daemonSocketPaths } from '../src/supervisor/socket-paths.js'
import { runAgnesd, startSupervisor } from '../src/supervisor/supervisor.js'
import type { WorkerPool } from '../src/supervisor/worker-pool.js'

const directories = new Set<string>()
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of directories) rmSync(dir, { recursive: true, force: true })
  directories.clear()
})
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'agh-assembly-'))
  directories.add(home)
  const paths = daemonSocketPaths({ dataDir: home, ipc: process.platform === 'win32' ? 'pipe' : 'unix' })
  if (process.platform !== 'win32') directories.add(dirname(paths.socketPath))
  const profile = {
    name: 'local-dev',
    dataDir: home,
    hash: 'assembly-fixture',
    seams: { principals: { provider: 'local' } },
    approvals: { mode: 'manual' },
    adapters: { secrets: { kind: 'env' } },
    packages: [],
    computerUse: DEFAULT_COMPUTER_USE,
    presets: { default: 'standard', allowed: ['standard'] },
  } as unknown as ResolvedProfile
  const processIdentity = async (pid: number) =>
    pid === process.pid
      ? { state: 'alive' as const, startId: 'assembly-fixture' }
      : { state: 'dead' as const }
  const options = {
    config: {
      dataDir: home,
      profileName: profile.name,
      ...paths,
      limits: { ...DEFAULT_LIMITS, workerStartupMs: 20_000 },
    },
    profile,
    profileDir: join(home, 'profiles', profile.name),
    profileFile: join(home, 'profile.json'),
    processIdentity,
    workerExecArgv: ['--import', 'tsx'],
    workerEntry: fileURLToPath(new URL('./fake-worker-entry.ts', import.meta.url)),
  }
  const released = async () => {
    const lock = await acquireOwnerLock(home, { socketPath: paths.socketPath, processIdentity })
    try {
      for (const path of [paths.socketPath, paths.workersSocketPath]) {
        const server = await listenUnix(path, () => undefined)
        await server.close()
      }
    } finally {
      await lock.release()
    }
  }
  return { home, options, released }
}

it.each([
  'owner',
  'stores',
  'pool',
  'worker-listen',
  'runtime',
  'modules',
  'boot-end',
  'client-listen',
] as const)(
  'releases sockets, workers, intervals and lock after abort at %s',
  async (phase) => {
    const f = fixture()
    const fault = new Error(`abort ${phase}`)
    let pool: WorkerPool | undefined
    const openWorkers = workers.openWorkers
    vi.spyOn(workers, 'openWorkers').mockImplementation(async (...args) => {
      const ready = await openWorkers(...args)
      pool = ready.pool
      if (phase === 'pool') throw fault
      return ready
    })
    const after =
      <A extends unknown[], R>(original: (...args: A) => Promise<R>) =>
      async (...args: A) => {
        await original(...args)
        throw fault
      }
    if (phase === 'owner') vi.spyOn(stores, 'openStores').mockRejectedValue(fault)
    if (phase === 'stores') vi.spyOn(stores, 'openStores').mockImplementation(after(stores.openStores))
    if (phase === 'worker-listen')
      vi.spyOn(listener, 'listenWorkers').mockImplementation(after(listener.listenWorkers))
    if (phase === 'runtime')
      vi.spyOn(runtime, 'initializeRuntime').mockImplementation(after(runtime.initializeRuntime))
    if (phase === 'modules')
      vi.spyOn(modules, 'rebuildClientModules').mockImplementation(after(modules.rebuildClientModules))
    if (phase === 'client-listen')
      vi.spyOn(clients, 'listenClients').mockImplementation(after(clients.listenClients))
    const active = new Set<ReturnType<typeof setInterval>>()
    const interval = globalThis.setInterval
    const clear = globalThis.clearInterval
    vi.spyOn(globalThis, 'setInterval').mockImplementation((...args) => {
      const handle = interval(...args)
      active.add(handle)
      return handle
    })
    vi.spyOn(globalThis, 'clearInterval').mockImplementation((handle) => {
      active.delete(handle as ReturnType<typeof setInterval>)
      clear(handle)
    })
    const bootVerification =
      phase === 'boot-end'
        ? {
            end: async () => {
              throw fault
            },
            outside: <T>(run: () => T) => run(),
          }
        : undefined
    await expect(
      startSupervisor({
        ...f.options,
        ...(bootVerification ? { bootVerification: bootVerification as never } : {}),
      }),
    ).rejects.toBe(fault)
    expect(active.size).toBe(0)
    expect(pool?.hasActivity() ?? false).toBe(false)
    await f.released()
  },
  30_000,
)

it('cleans a worker acquired during a partially failed runtime initialization', async () => {
  const f = fixture()
  let pool: WorkerPool | undefined
  const original = workers.openWorkers
  vi.spyOn(workers, 'openWorkers').mockImplementation(async (...args) => {
    const ready = await original(...args)
    pool = ready.pool
    return ready
  })
  const fault = new Error('partial runtime initialize')
  const manager = {
    inventory: async () => {
      await pool?.acquireSharedWorker()
      throw fault
    },
  } as unknown as PackageManager
  await expect(
    startSupervisor({
      ...f.options,
      packageRuntime: {
        manager,
        profileDirectory: async () => f.options.profileDir,
        operations: {} as never,
        stateDirectory: join(f.home, 'activation'),
      },
    }),
  ).rejects.toBe(fault)
  expect(pool?.hasActivity()).toBe(false)
  await f.released()
}, 30_000)

it('closes the same owners once on normal close and after discovery failure', async () => {
  const f = fixture()
  const sup = await startSupervisor(f.options)
  await Promise.all([sup.close(), sup.close()])
  await f.released()
  const fault = new Error('discovery failed')
  await expect(
    runAgnesd(
      { home: join(f.home, 'discovery-home'), workspace: f.home },
      {
        startProduction: async () => await startSupervisor(f.options),
        publishDiscovery: async () => {
          throw fault
        },
      },
    ),
  ).rejects.toBe(fault)
  await f.released()
}, 30_000)
