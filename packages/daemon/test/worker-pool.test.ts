import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { duplexPair } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { buildRuntimeTarget, createPluginRow, encodeRuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import { windowsProcessStartTimeSync } from '@agnes/system-node'
import { describe, expect, it, vi } from 'vitest'
import { CompositeRuntimeDelivery } from '../src/composite-runtime-delivery.js'
import { type DaemonConfig, DEFAULT_LIMITS } from '../src/config.js'
import { CompositeTargetStore } from '../src/storage/composite-target-store.js'
import { encodeFrame } from '../src/supervisor/framing.js'
import { listenUnix } from '../src/supervisor/socket.js'
import { WorkerPool } from '../src/supervisor/worker-pool.js'
import { sqliteTables } from './sqlite-tables.js'
import { workspaceBinding } from './workspace-authority.js'

async function acquire(
  pool: WorkerPool,
  sessionKey: string,
  options: { cwd?: string; resume?: boolean; kind?: 'session'; resourceControl?: false } = {},
) {
  return pool.acquire(sessionKey, {
    ...options,
    binding: await workspaceBinding(sessionKey, options.cwd ?? '/workspace'),
  })
}

const fakeWorker = fileURLToPath(new URL('./fake-worker.ts', import.meta.url))

// A tsx-started fake worker says hello in under a second alone, but on a loaded macOS runner it has
// taken more than ten. The hello deadline only guards these tests against a hang, so they use the
// daemon's own default (30 s), and each test allows 60 s to leave room for it.
const REAL_WORKER_STARTUP_MS = DEFAULT_LIMITS.workerStartupMs
const exitingWorker = fileURLToPath(new URL('./fixtures/exiting-worker.mjs', import.meta.url))

const workerSocket = (dir: string): string =>
  process.platform === 'win32' ? `\\\\.\\pipe\\${basename(dir)}-workers` : join(dir, 'w.sock')

type FakeChild = ChildProcess & { killCalls: number }

function erroredChild(): FakeChild {
  const child = new EventEmitter() as unknown as FakeChild
  const state = child as unknown as { signalCode: NodeJS.Signals | null }
  child.killCalls = 0
  Object.assign(child, {
    exitCode: null,
    signalCode: null,
    stdio: [null, null, null, null],
  })
  child.kill = (() => {
    child.killCalls++
    state.signalCode = 'SIGKILL'
    return true
  }) as FakeChild['kill']
  return child
}

describe('WorkerPool', () => {
  it('accepts a preview only from the link that carries the session channel', () => {
    const pool = new WorkerPool({
      config: {
        profileName: 'p',
        dataDir: '/unused',
        socketPath: '/unused/client.sock',
        workersSocketPath: '/unused/worker.sock',
        limits: DEFAULT_LIMITS,
      },
      profile: { name: 'p', hash: 'h1' } as never,
      profileFile: '/unused/profile.json',
      clock: () => 0,
      onEvent: () => undefined,
      onRequest: async () => undefined,
      notices: { emit() {} },
    })
    const hosting = { alive: true }
    const stale = { alive: true }
    const slots = (pool as unknown as { slots: Map<string, unknown> }).slots
    slots.set('@shared', { link: hosting, channels: new Map([['s', {}]]), resourceControl: false })
    const hosts = (link: unknown, key: string) =>
      (pool as unknown as { hosts(link: unknown, key: string): boolean }).hosts(link, key)
    expect(hosts(hosting, 's')).toBe(true)
    expect(hosts(stale, 's')).toBe(false)
    expect(hosts(hosting, 'other')).toBe(false)
  })

  it('passes on a preview from the adopted link that hosts the session, never from another', async () => {
    const previews: Array<{ key: string; delta: string }> = []
    const pool = new WorkerPool({
      config: {
        profileName: 'p',
        dataDir: '/unused',
        socketPath: '/unused/client.sock',
        workersSocketPath: '/unused/worker.sock',
        limits: DEFAULT_LIMITS,
      },
      profile: { name: 'p', hash: 'h1' } as never,
      profileFile: '/unused/profile.json',
      clock: () => 0,
      onEvent: () => undefined,
      onPreview: (key, update) => previews.push({ key, delta: update.delta }),
      onRequest: async () => undefined,
      notices: { emit() {} },
    })
    const internals = pool as unknown as {
      slots: Map<string, unknown>
      pendingByToken: Map<string, (link: unknown) => void>
    }
    const claimed = (token: string, slotKey: string, channels: string[]) =>
      new Promise<void>((resolve) => {
        internals.pendingByToken.set(token, (link) => {
          internals.slots.set(slotKey, {
            link,
            channels: new Map(channels.map((c) => [c, {}])),
            resourceControl: slotKey !== '@shared',
          })
          resolve()
        })
      })
    const [poolA, workerA] = duplexPair()
    const [poolB, workerB] = duplexPair()
    const adoptedA = claimed('token-a', '@shared', ['s'])
    const adoptedB = claimed('token-b', 'service', [])
    pool.adopt(poolA)
    pool.adopt(poolB)
    const hello = (token: string, workerGeneration: number, workerKind: 'session' | 'service') =>
      encodeFrame({
        kind: 'hello',
        token,
        workerKey: workerKind === 'session' ? '@shared' : 'service',
        workerKind,
        workerGeneration,
        profileHash: 'h1',
      })
    workerA.write(hello('token-a', 1, 'session'))
    workerB.write(hello('token-b', 2, 'service'))
    await Promise.all([adoptedA, adoptedB])
    const preview = (delta: string) =>
      encodeFrame({
        kind: 'preview',
        sessionKey: 's',
        lane: 'main',
        effectId: 'e1',
        stream: 'text',
        offset: 0,
        delta,
      })
    workerB.write(preview('from b'))
    workerA.write(preview('from a'))
    await vi.waitFor(() => expect(previews).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 10))
    expect(previews).toEqual([{ key: 's', delta: 'from a' }])
    for (const end of [poolA, poolB, workerA, workerB]) end.destroy()
  })

  it('reserves @shared for the Host worker and refuses a mismatched live slot', async () => {
    const pool = new WorkerPool({
      config: {
        profileName: 'p',
        dataDir: '/unused',
        socketPath: '/unused/client.sock',
        workersSocketPath: '/unused/worker.sock',
        limits: DEFAULT_LIMITS,
      },
      profile: { name: 'p', hash: 'h1' } as never,
      profileFile: '/unused/profile.json',
      clock: () => 0,
      onEvent: () => undefined,
      onRequest: async () => undefined,
      notices: { emit() {} },
    })

    await expect(pool.acquire('@shared', { kind: 'service', resourceControl: true })).rejects.toThrow(
      'resource-control helpers cannot use the shared business worker key',
    )

    const slots = (pool as unknown as { slots: Map<string, unknown> }).slots
    slots.set('@shared', { link: { alive: true }, resourceControl: true })
    await expect(acquire(pool, 'ordinary-session')).rejects.toThrow(
      'worker @shared already exists with a different worker kind',
    )
    expect(pool.businessWorker()).toBeUndefined()
    expect(pool.activationLinks()).toEqual([])
    slots.clear()
  })

  it('overrides inherited supervisor identity with the actual spawning process', async () => {
    const windows = process.platform === 'win32' // guards-allow-platform: native worker identity environment.
    let captured: NodeJS.ProcessEnv | undefined
    let hidden: boolean | undefined
    vi.stubEnv('AGNES_SUPERVISOR_PID', '999999')
    vi.stubEnv('AGNES_SUPERVISOR_START_ID', '1')
    vi.stubEnv('AGNES_WORKER_ROOT', '/inherited-first-workspace')
    const pool = new WorkerPool({
      config: {
        profileName: 'p',
        dataDir: '/unused',
        socketPath: '/unused/client.sock',
        workersSocketPath: windows ? '\\\\.\\pipe\\identity-environment-test' : '/unused/worker.sock',
        limits: DEFAULT_LIMITS,
      },
      profile: { name: 'p', hash: 'h1' } as never,
      profileFile: '/unused/profile.json',
      spawn: ((
        _command: string,
        _args: readonly string[],
        options: { env?: NodeJS.ProcessEnv; windowsHide?: boolean },
      ) => {
        captured = options.env
        hidden = options.windowsHide
        const child = erroredChild()
        queueMicrotask(() => child.emit('error', new Error('identity captured')))
        return child
      }) as unknown as typeof import('node:child_process').spawn,
      clock: () => 0,
      onEvent: () => undefined,
      onRequest: async () => undefined,
      notices: { emit() {} },
    })
    try {
      await expect(
        acquire(pool, 'agnes:t:a:x:dm:identity', { cwd: '/requested-first-workspace' }),
      ).rejects.toThrow('identity captured')
      expect(hidden).toBe(true)
      expect(captured?.AGNES_WORKER_ROOT).toBeUndefined()
      expect(captured?.AGNES_SUPERVISOR_PID).toBe(windows ? String(process.pid) : undefined)
      expect(captured?.AGNES_SUPERVISOR_START_ID).toBe(
        windows ? windowsProcessStartTimeSync(process.pid) : undefined,
      )
    } finally {
      pool.killAll()
      vi.unstubAllEnvs()
    }
  })

  it('spawns workers under the daemon home, not the one the process environment would pick', async () => {
    let captured: NodeJS.ProcessEnv | undefined
    vi.stubEnv('AGH_HOME', '/environment-home')
    vi.stubEnv('AGNES_HOME', '/legacy-home')
    const pool = new WorkerPool({
      config: {
        profileName: 'p',
        dataDir: '/daemon-home/data',
        home: '/daemon-home',
        socketPath: '/unused/client.sock',
        workersSocketPath: '/unused/worker.sock',
        limits: DEFAULT_LIMITS,
      },
      profile: { name: 'p', hash: 'h1' } as never,
      profileFile: '/unused/profile.json',
      spawn: ((_command: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
        captured = options.env
        const child = erroredChild()
        queueMicrotask(() => child.emit('error', new Error('home captured')))
        return child
      }) as unknown as typeof import('node:child_process').spawn,
      clock: () => 0,
      onEvent: () => undefined,
      onRequest: async () => undefined,
      notices: { emit() {} },
    })
    try {
      await expect(acquire(pool, 'agnes:t:a:x:dm:home')).rejects.toThrow('home captured')
      expect(captured?.AGH_HOME).toBe('/daemon-home')
    } finally {
      pool.killAll()
      vi.unstubAllEnvs()
    }
  })
  it('rejects and terminates a worker that is still waiting to hello during shutdown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-pool-starting-'))
    const profileFile = join(dir, 'profile.json')
    writeFileSync(profileFile, JSON.stringify({ name: 'p', hash: 'h1' }))
    const pool = new WorkerPool({
      config: {
        profileName: 'p',
        dataDir: dir,
        socketPath: join(dir, 'a.sock'),
        workersSocketPath: join(dir, 'never-listening.sock'),
        limits: { ...DEFAULT_LIMITS, workerStartupMs: 30_000 },
      },
      profile: { name: 'p', hash: 'h1' } as never,
      profileFile,
      execPath: process.execPath,
      workerEntry: fileURLToPath(new URL('./fixtures/hanging-worker.mjs', import.meta.url)),
      clock: () => 0,
      onEvent: () => undefined,
      onRequest: async () => undefined,
      notices: { emit() {} },
    })
    try {
      const acquiring = acquire(pool, 'agnes:t:a:x:dm:starting')
      const rejected = expect(acquiring).rejects.toThrow('shut down during startup')
      await new Promise((resolve) => setTimeout(resolve, 50))

      await pool.closeAll(2_000)
      await rejected
      await expect(acquire(pool, 'agnes:t:a:x:dm:later')).rejects.toThrow('shutting down')
    } finally {
      pool.killAll()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 10_000)

  it('rejects promptly on a child spawn error and clears the pending token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-pool-spawn-error-'))
    const profileFile = join(dir, 'profile.json')
    writeFileSync(profileFile, JSON.stringify({ name: 'p', hash: 'h1' }))
    const children: FakeChild[] = []
    let spawnCount = 0
    const spawn = (() => {
      spawnCount++
      const child = erroredChild()
      children.push(child)
      queueMicrotask(() => child.emit('error', new Error('ENOENT: worker entry not found')))
      return child
    }) as typeof import('node:child_process').spawn
    const pool = new WorkerPool({
      config: {
        profileName: 'p',
        dataDir: dir,
        socketPath: join(dir, 'a.sock'),
        workersSocketPath: join(dir, 'never-listening.sock'),
        limits: { ...DEFAULT_LIMITS, workerStartupMs: 30_000 },
      },
      profile: { name: 'p', hash: 'h1' } as never,
      profileFile,
      spawn,
      clock: () => 0,
      onEvent: () => undefined,
      onRequest: async () => undefined,
      notices: { emit() {} },
    })
    const sessionKey = 'agnes:t:a:x:dm:spawn-error'
    try {
      const startedAt = Date.now()
      await expect(acquire(pool, sessionKey)).rejects.toThrow(/failed to spawn: .*ENOENT/)
      expect(Date.now() - startedAt).toBeLessThan(1_000)
      expect(children[0]?.killCalls).toBe(1)

      // A second attempt gets a fresh token and child. If the failed token remained claimable, the
      // pool could incorrectly hand a late socket to the old generation instead of retrying.
      await expect(acquire(pool, sessionKey)).rejects.toThrow(/failed to spawn: .*ENOENT/)
      expect(spawnCount).toBe(2)
    } finally {
      pool.killAll()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 5_000)

  it('reloads the profile hash and snapshot path together for a new service worker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-pool-profile-reload-'))
    const oldProfileFile = join(dir, 'old.json')
    const nextProfileFile = join(dir, 'next.json')
    writeFileSync(oldProfileFile, JSON.stringify({ name: 'p', hash: 'h1' }))
    writeFileSync(nextProfileFile, JSON.stringify({ name: 'p', hash: 'h2' }))
    let spawnedProfileFile: string | undefined
    const spawn = ((_command: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      spawnedProfileFile = options.env?.AGNES_PROFILE_FILE
      const child = erroredChild()
      queueMicrotask(() => child.emit('error', new Error('expected test stop')))
      return child
    }) as unknown as typeof import('node:child_process').spawn
    const pool = new WorkerPool({
      config: {
        profileName: 'p',
        dataDir: dir,
        socketPath: join(dir, 'a.sock'),
        workersSocketPath: join(dir, 'never-listening.sock'),
        limits: { ...DEFAULT_LIMITS, workerStartupMs: 30_000 },
      },
      profile: { name: 'p', hash: 'h1' } as never,
      profileFile: oldProfileFile,
      spawn,
      clock: () => 0,
      onEvent: () => undefined,
      onRequest: async () => undefined,
      notices: { emit() {} },
    })
    try {
      const uncheckedAcquire = pool.acquire.bind(pool) as unknown as (
        key: string,
        options: { kind: 'service' },
      ) => Promise<unknown>
      await expect(uncheckedAcquire('@service:host-bearing', { kind: 'service' })).rejects.toThrow(
        'service workers are reserved for resource-control helpers',
      )
      pool.reloadProfile({
        profile: { name: 'p', hash: 'h2' } as never,
        profileFile: nextProfileFile,
      })
      await expect(pool.acquire('@service:h2', { kind: 'service', resourceControl: true })).rejects.toThrow(
        'expected test stop',
      )
      expect(spawnedProfileFile).toBe(nextProfileFile)
    } finally {
      pool.killAll()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects promptly when a real worker exits before hello', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-pool-early-exit-'))
    const profileFile = join(dir, 'profile.json')
    writeFileSync(profileFile, JSON.stringify({ name: 'p', hash: 'h1' }))
    const pool = new WorkerPool({
      config: {
        profileName: 'p',
        dataDir: dir,
        socketPath: join(dir, 'a.sock'),
        workersSocketPath: join(dir, 'never-listening.sock'),
        limits: { ...DEFAULT_LIMITS, workerStartupMs: 30_000 },
      },
      profile: { name: 'p', hash: 'h1' } as never,
      profileFile,
      execPath: process.execPath,
      workerEntry: exitingWorker,
      clock: () => 0,
      onEvent: () => undefined,
      onRequest: async () => undefined,
      notices: { emit() {} },
    })
    const sessionKey = 'agnes:t:a:x:dm:early-exit'
    try {
      const startedAt = Date.now()
      await expect(acquire(pool, sessionKey)).rejects.toThrow(/exited before hello \(code 7\)/)
      expect(Date.now() - startedAt).toBeLessThan(1_000)

      // The rejected generation must not leave acquire() stuck behind its old pending token.
      const retryStartedAt = Date.now()
      await expect(acquire(pool, sessionKey)).rejects.toThrow(/exited before hello \(code 7\)/)
      expect(Date.now() - retryStartedAt).toBeLessThan(1_000)
    } finally {
      pool.killAll()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 5_000)

  it('spawns a real worker, gates it, answers a ping, and quarantines after three qualifying crashes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-pool-'))
    const profileFile = join(dir, 'profile.json')
    writeFileSync(profileFile, JSON.stringify({ name: 'p', hash: 'h1' }))
    const config: DaemonConfig = {
      profileName: 'p',
      dataDir: dir,
      socketPath: join(dir, 'a.sock'),
      workersSocketPath: workerSocket(dir),
      limits: { ...DEFAULT_LIMITS, workerStartupMs: REAL_WORKER_STARTUP_MS },
    }
    const notices: string[] = []
    const exited: string[] = []
    const pool = new WorkerPool({
      config,
      profile: { name: 'p', hash: 'h1' } as never,
      profileFile,
      execPath: process.execPath,
      workerEntry: fakeWorker,
      execArgv: ['--import', 'tsx'],
      clock: () => 0,
      onEvent: () => undefined,
      onRequest: async () => undefined,
      notices: { emit: (k: string) => notices.push(k) },
    })
    const server = await listenUnix(config.workersSocketPath, (s) => pool.adopt(s))
    pool.setWorkerExitHandler(({ sessionKey: exitedKey }) => void exited.push(exitedKey))
    // A service (resource-control) worker key, not '@shared': the breaker below is generic crash
    // policy, unrelated to the shared worker's own exemption (see the dedicated test further down).
    const sessionKey = 'agnes:t:a:x:dm:1'
    const link = await pool.acquire(sessionKey, { kind: 'service', resourceControl: true })
    expect(await link.command('ping', {})).toEqual({ ok: true })

    // Three crashes on the same session key. The first `link.command('crash', {})` is sent to the
    // still-live real worker and kills it, which fires the pool's own `child.once('exit', ...)`
    // handler automatically (one `crashed()` call) in addition to the manual one below - so this
    // loop drives four total `crashed()` calls, not three. `clock: () => 0` puts every one of them
    // at the same timestamp, so the 5-minute window never ages any of them out: the breaker still
    // fires at the third *call*, quarantining before the fourth ever changes anything (see the
    // reverse-verification test below for the window/backoff math in isolation).
    const uncheckedCommand = link.command.bind(link) as unknown as (
      method: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>
    for (let i = 0; i < 3; i++) {
      await uncheckedCommand('crash', {}).catch(() => undefined)
      await new Promise((r) => setTimeout(r, 50))
      pool.crashed(sessionKey)
    }
    expect(notices.filter((n) => n === 'worker_crashed')).toHaveLength(2)
    expect(notices).toContain('worker_quarantined')
    expect(exited).toContain(sessionKey)
    await expect(pool.acquire(sessionKey, { kind: 'service', resourceControl: true })).rejects.toThrow(
      /quarantined/,
    )

    await pool.closeAll(1000)
    await server.close()
  }, 60_000)

  it('never quarantines the shared worker, however many times it crashes', () => {
    const pool = new WorkerPool({
      config: { profileName: 'p', dataDir: '.', socketPath: 'a', workersSocketPath: 'b' } as never,
      profile: { name: 'p', hash: 'h1' } as never,
      profileFile: 'x',
      execPath: process.execPath,
      workerEntry: fakeWorker,
      execArgv: [],
      clock: () => 0,
      onEvent: () => undefined,
      onRequest: async () => undefined,
      notices: { emit() {} },
    })
    for (let i = 0; i < 10; i++) expect(pool.crashed('@shared')).toBe('restart')
    expect(pool.isQuarantined('@shared')).toBe(false)
  })

  it('multiplexes two sessions through one shared worker and closes them independently', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-pool-shared-'))
    const profileFile = join(dir, 'profile.json')
    writeFileSync(profileFile, JSON.stringify({ name: 'p', hash: 'h1' }))
    const config: DaemonConfig = {
      profileName: 'p',
      dataDir: dir,
      socketPath: join(dir, 'a.sock'),
      workersSocketPath: workerSocket(dir),
      limits: { ...DEFAULT_LIMITS, workerStartupMs: REAL_WORKER_STARTUP_MS },
    }
    const pool = new WorkerPool({
      config,
      profile: { name: 'p', hash: 'h1' } as never,
      profileFile,
      execPath: process.execPath,
      workerEntry: fakeWorker,
      execArgv: ['--import', 'tsx'],
      clock: () => 0,
      onEvent: () => undefined,
      onRequest: async () => undefined,
      notices: { emit() {} },
    })
    const server = await listenUnix(config.workersSocketPath, (socket) => pool.adopt(socket))
    try {
      const [a, b] = await Promise.all([
        acquire(pool, 'agnes:t:a:x:dm:shared-a', { cwd: dir }),
        acquire(pool, 'agnes:t:a:x:dm:shared-b', { cwd: dir }),
      ])
      expect(pool.links().filter(({ sessionKey }) => sessionKey === '@shared')).toHaveLength(1)
      expect(await a.command('ping', {})).toEqual({ ok: true })
      await a.closeSession()
      expect(pool.businessWorker()?.link.alive).toBe(true)
      expect(await b.command('ping', {})).toEqual({ ok: true })
      const reopened = await acquire(pool, 'agnes:t:a:x:dm:shared-a', { cwd: dir, resume: true })
      expect(reopened).not.toBe(a)
      expect(await reopened.command('ping', {})).toEqual({ ok: true })
      expect(pool.links().filter(({ sessionKey }) => sessionKey === '@shared')).toHaveLength(1)
    } finally {
      await pool.closeAll(1_000)
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('exposes only Host-owning links to package activation while a resource lifecycle worker is live', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-pool-activation-links-'))
    const profileFile = join(dir, 'profile.json')
    const probeFile = join(dir, 'resource-activation-methods.log')
    writeFileSync(profileFile, JSON.stringify({ name: 'p', hash: 'h1' }))
    const config: DaemonConfig = {
      profileName: 'p',
      dataDir: dir,
      socketPath: join(dir, 'a.sock'),
      workersSocketPath: workerSocket(dir),
      limits: { ...DEFAULT_LIMITS, workerStartupMs: REAL_WORKER_STARTUP_MS },
    }
    const previousProbe = process.env.AGNES_RESOURCE_PROBE_FILE
    process.env.AGNES_RESOURCE_PROBE_FILE = probeFile
    const pool = new WorkerPool({
      config,
      profile: { name: 'p', hash: 'h1' } as never,
      profileFile,
      execPath: process.execPath,
      workerEntry: fakeWorker,
      execArgv: ['--import', 'tsx'],
      clock: () => 0,
      onEvent: () => undefined,
      onRequest: async () => undefined,
      notices: { emit() {} },
    })
    const server = await listenUnix(config.workersSocketPath, (socket) => pool.adopt(socket))
    try {
      await acquire(pool, 'agnes:t:a:x:dm:activation-host')
      const resource = await pool.acquire('agnes:t:a:x:dm:resource-lifecycle', {
        kind: 'service',
        resourceControl: true,
      })
      expect(pool.links().map((target) => target.link)).toEqual(
        expect.arrayContaining([pool.businessWorker()?.link, resource]),
      )
      expect(pool.activationLinks().map((target) => target.link)).toEqual([pool.businessWorker()?.link])

      await Promise.all(
        pool
          .activationLinks()
          .map(({ link, generation }) => link.command('ping', { workerGeneration: generation })),
      )
      expect(() => readFileSync(probeFile, 'utf8')).toThrow()
    } finally {
      if (previousProbe === undefined) delete process.env.AGNES_RESOURCE_PROBE_FILE
      else process.env.AGNES_RESOURCE_PROBE_FILE = previousProbe
      await pool.closeAll(1_000).catch(() => undefined)
      pool.killAll()
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('fail-stops returned links synchronously before child exit is observed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-pool-fail-stop-'))
    const profileFile = join(dir, 'profile.json')
    writeFileSync(profileFile, JSON.stringify({ name: 'p', hash: 'h1' }))
    const config: DaemonConfig = {
      profileName: 'p',
      dataDir: dir,
      socketPath: join(dir, 'a.sock'),
      workersSocketPath: workerSocket(dir),
      limits: { ...DEFAULT_LIMITS, workerStartupMs: REAL_WORKER_STARTUP_MS },
    }
    const pool = new WorkerPool({
      config,
      profile: { name: 'p', hash: 'h1' } as never,
      profileFile,
      execPath: process.execPath,
      workerEntry: fakeWorker,
      execArgv: ['--import', 'tsx'],
      clock: () => 0,
      onEvent: () => undefined,
      onRequest: async () => undefined,
      notices: { emit() {} },
    })
    const server = await listenUnix(config.workersSocketPath, (socket) => pool.adopt(socket))
    try {
      const link = await acquire(pool, 'agnes:t:a:x:dm:fail-stop')
      expect(link.alive).toBe(true)
      pool.failStop('activation decision uncertain')
      expect(link.alive).toBe(false)
      await expect(link.command('ping', {})).rejects.toThrow('worker link closed')
      await expect(acquire(pool, 'agnes:t:a:x:dm:after-fail-stop')).rejects.toThrow('shutting down')
    } finally {
      pool.killAll()
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('rejects a worker whose link dies inside startup initialization', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-pool-initializer-exit-'))
    const profileFile = join(dir, 'profile.json')
    writeFileSync(profileFile, JSON.stringify({ name: 'p', hash: 'h1' }))
    const config: DaemonConfig = {
      profileName: 'p',
      dataDir: dir,
      socketPath: join(dir, 'a.sock'),
      workersSocketPath: workerSocket(dir),
      limits: { ...DEFAULT_LIMITS, workerStartupMs: REAL_WORKER_STARTUP_MS },
    }
    const pool = new WorkerPool({
      config,
      profile: { name: 'p', hash: 'h1' } as never,
      profileFile,
      execPath: process.execPath,
      workerEntry: fakeWorker,
      execArgv: ['--import', 'tsx'],
      clock: () => 0,
      onEvent: () => undefined,
      onRequest: async () => undefined,
      notices: { emit() {} },
    })
    pool.setLinkInitializer(async ({ link }) => link.close('injected initializer exit'))
    const server = await listenUnix(config.workersSocketPath, (socket) => pool.adopt(socket))
    try {
      await expect(acquire(pool, 'agnes:t:a:x:dm:initializer-exit')).rejects.toThrow(
        'link closed during startup',
      )
      expect(pool.links()).toEqual([])
    } finally {
      pool.killAll()
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('does not start a replacement generation before prior exit recovery completes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-pool-generation-fence-'))
    const profileFile = join(dir, 'profile.json')
    writeFileSync(profileFile, JSON.stringify({ name: 'p', hash: 'h1' }))
    const config: DaemonConfig = {
      profileName: 'p',
      dataDir: dir,
      socketPath: join(dir, 'a.sock'),
      workersSocketPath: workerSocket(dir),
      limits: { ...DEFAULT_LIMITS, workerStartupMs: REAL_WORKER_STARTUP_MS },
    }
    const pool = new WorkerPool({
      config,
      profile: { name: 'p', hash: 'h1' } as never,
      profileFile,
      execPath: process.execPath,
      workerEntry: fakeWorker,
      execArgv: ['--import', 'tsx'],
      clock: () => 0,
      onEvent: () => undefined,
      onRequest: async () => undefined,
      notices: { emit() {} },
    })
    let releaseRecovery: () => void = () => undefined
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve
    })
    let observeExit: () => void = () => undefined
    const exitObserved = new Promise<void>((resolve) => {
      observeExit = resolve
    })
    pool.setWorkerExitHandler(async () => {
      observeExit()
      await recoveryGate
    })
    const server = await listenUnix(config.workersSocketPath, (socket) => pool.adopt(socket))
    try {
      const key = 'agnes:t:a:x:dm:generation-fence'
      await acquire(pool, key)
      const firstGeneration = pool.links()[0]?.generation
      pool.retireWorker('inject prior generation link loss')
      await exitObserved
      let reopened = false
      const reopening = acquire(pool, key).then((link) => {
        reopened = true
        return link
      })
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(reopened).toBe(false)
      releaseRecovery()
      const second = await reopening
      expect(second.alive).toBe(true)
      expect(pool.links()[0]?.generation).toBeGreaterThan(firstGeneration ?? 0)
    } finally {
      await pool.closeAll(1_000).catch(() => undefined)
      pool.killAll()
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  // On Linux a worker that exits with the start gate still unread resets its pipe, and the error
  // surfaces on the supervisor's end after the gate was written.
  it('treats an error on the written start gate as nothing the supervisor has to handle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-pool-gate-reset-'))
    const profileFile = join(dir, 'profile.json')
    writeFileSync(profileFile, JSON.stringify({ name: 'p', hash: 'h1' }))
    const config: DaemonConfig = {
      profileName: 'p',
      dataDir: dir,
      socketPath: join(dir, 'a.sock'),
      workersSocketPath: workerSocket(dir),
      limits: { ...DEFAULT_LIMITS, workerStartupMs: REAL_WORKER_STARTUP_MS },
    }
    const { spawn } = await import('node:child_process')
    const children: ChildProcess[] = []
    const pool = new WorkerPool({
      config,
      profile: { name: 'p', hash: 'h1' } as never,
      profileFile,
      execPath: process.execPath,
      workerEntry: fakeWorker,
      execArgv: ['--import', 'tsx'],
      clock: () => 0,
      onEvent: () => undefined,
      onRequest: async () => undefined,
      notices: { emit() {} },
      spawn: ((...args: Parameters<typeof spawn>) => {
        const child = spawn(...args)
        children.push(child)
        return child
      }) as typeof spawn,
    })
    const server = await listenUnix(config.workersSocketPath, (socket) => pool.adopt(socket))
    try {
      const link = await acquire(pool, 'agnes:t:a:x:dm:gate-reset')
      const gate = children[0]?.stdio[3]
      expect(gate).toBeDefined()
      const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', syscall: 'read' })
      expect(() => gate?.emit('error', reset)).not.toThrow()
      expect(link.alive).toBe(true)
    } finally {
      await pool.closeAll(1_000).catch(() => undefined)
      pool.killAll()
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('does not finish pool shutdown before worker exit recovery settles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-pool-shutdown-recovery-'))
    const profileFile = join(dir, 'profile.json')
    writeFileSync(profileFile, JSON.stringify({ name: 'p', hash: 'h1' }))
    const config: DaemonConfig = {
      profileName: 'p',
      dataDir: dir,
      socketPath: join(dir, 'a.sock'),
      workersSocketPath: workerSocket(dir),
      limits: { ...DEFAULT_LIMITS, workerStartupMs: REAL_WORKER_STARTUP_MS },
    }
    const pool = new WorkerPool({
      config,
      profile: { name: 'p', hash: 'h1' } as never,
      profileFile,
      execPath: process.execPath,
      workerEntry: fakeWorker,
      execArgv: ['--import', 'tsx'],
      clock: () => 0,
      onEvent: () => undefined,
      onRequest: async () => undefined,
      notices: { emit() {} },
    })
    let releaseRecovery: () => void = () => undefined
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve
    })
    let observeExit: () => void = () => undefined
    const exitObserved = new Promise<void>((resolve) => {
      observeExit = resolve
    })
    pool.setWorkerExitHandler(async () => {
      observeExit()
      await recoveryGate
    })
    const server = await listenUnix(config.workersSocketPath, (socket) => pool.adopt(socket))
    try {
      await acquire(pool, 'agnes:t:a:x:dm:shutdown-recovery')
      let closed = false
      const closing = pool.closeAll(1_000).then(() => {
        closed = true
      })
      await exitObserved
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(closed).toBe(false)
      releaseRecovery()
      await closing
      expect(closed).toBe(true)
    } finally {
      releaseRecovery()
      pool.killAll()
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('does not treat a dead link as a fully exited plugin generation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-pool-delayed-exit-'))
    const profileFile = join(dir, 'profile.json')
    writeFileSync(profileFile, JSON.stringify({ name: 'p', hash: 'h1' }))
    const config: DaemonConfig = {
      profileName: 'p',
      dataDir: dir,
      socketPath: join(dir, 'a.sock'),
      workersSocketPath: workerSocket(dir),
      limits: { ...DEFAULT_LIMITS, workerStartupMs: REAL_WORKER_STARTUP_MS },
    }
    const pool = new WorkerPool({
      config,
      profile: { name: 'p', hash: 'h1' } as never,
      profileFile,
      execPath: process.execPath,
      workerEntry: fakeWorker,
      execArgv: ['--import', 'tsx'],
      clock: () => 0,
      onEvent: () => undefined,
      onRequest: async () => undefined,
      notices: { emit() {} },
    })
    const server = await listenUnix(config.workersSocketPath, (socket) => pool.adopt(socket))
    try {
      const key = 'agnes:t:a:x:dm:delayed-exit'
      await acquire(pool, key)
      const generation = pool.links()[0]?.generation
      if (!generation) throw new Error('delayed-exit generation missing')
      pool.retireWorker('inject transport loss before process exit')
      await expect(pool.waitForGenerationExit('@shared', generation, 30)).resolves.toBe(false)
      await expect(pool.waitForGenerationExit('@shared', generation, 1_000)).resolves.toBe(true)
    } finally {
      await pool.closeAll(1_000).catch(() => undefined)
      pool.killAll()
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('refreshes the idle watermark when a late worker reply arrives', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-pool-activity-'))
    const profileFile = join(dir, 'profile.json')
    writeFileSync(profileFile, JSON.stringify({ name: 'p', hash: 'h1' }))
    let now = 0
    const config: DaemonConfig = {
      profileName: 'p',
      dataDir: dir,
      socketPath: join(dir, 'a.sock'),
      workersSocketPath: workerSocket(dir),
      limits: { ...DEFAULT_LIMITS, workerStartupMs: REAL_WORKER_STARTUP_MS, workerIdleEvictMs: 100 },
    }
    const notices: string[] = []
    const pool = new WorkerPool({
      config,
      profile: { name: 'p', hash: 'h1' } as never,
      profileFile,
      execPath: process.execPath,
      workerEntry: fakeWorker,
      execArgv: ['--import', 'tsx'],
      clock: () => now,
      onEvent: () => undefined,
      onRequest: async () => undefined,
      notices: { emit: (kind) => notices.push(kind) },
    })
    const server = await listenUnix(config.workersSocketPath, (socket) => pool.adopt(socket))
    try {
      const key = 'agnes:t:a:x:dm:activity'
      const link = await acquire(pool, key)
      const reply = link.command('ping', {})
      // Models a command that began before the idle threshold but only replied after it. The reply,
      // not the old acquire time, would be the worker's real last activity - moot here because a
      // session-kind acquire always lands on '@shared', which P1 exempts from idle eviction
      // altogether (see the dedicated exemption test further down): evictIdle stays 0 forever,
      // however long the gap, so this no longer distinguishes a refreshed watermark from a stale one.
      now = 150
      await expect(reply).resolves.toEqual({ ok: true })
      expect(pool.evictIdle(now, () => false)).toBe(0)
      now = 250
      expect(pool.evictIdle(now, () => false)).toBe(0)
      now = 251
      expect(pool.evictIdle(now, () => false)).toBe(0)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(notices).not.toContain('worker_crashed')
      expect(notices).not.toContain('worker_quarantined')
    } finally {
      await pool.closeAll(1_000)
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  // Reverse-verification (not optional per the task brief): prove the 5-minute rolling window
  // actually ages crashes out, not just that three crashes in a row trips the breaker. Drives
  // `crashed()` directly with a controllable clock - no real subprocess needed, since `crashed()`'s
  // window/backoff math has no dependency on how a crash was detected.
  it('never evicts the shared worker for idling, only a differently-keyed worker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-pool-shared-idle-'))
    const profileFile = join(dir, 'profile.json')
    writeFileSync(profileFile, JSON.stringify({ name: 'p', hash: 'h1' }))
    let now = 0
    const config: DaemonConfig = {
      profileName: 'p',
      dataDir: dir,
      socketPath: join(dir, 'a.sock'),
      workersSocketPath: workerSocket(dir),
      limits: { ...DEFAULT_LIMITS, workerStartupMs: REAL_WORKER_STARTUP_MS, workerIdleEvictMs: 100 },
    }
    const pool = new WorkerPool({
      config,
      profile: { name: 'p', hash: 'h1' } as never,
      profileFile,
      execPath: process.execPath,
      workerEntry: fakeWorker,
      execArgv: ['--import', 'tsx'],
      clock: () => now,
      onEvent: () => undefined,
      onRequest: async () => undefined,
      notices: { emit() {} },
    })
    const server = await listenUnix(config.workersSocketPath, (socket) => pool.adopt(socket))
    try {
      const link = await acquire(pool, 'agnes:t:a:x:dm:shared-idle', { cwd: dir })
      await link.closeSession()
      now = 1_000
      // '@shared' is the only slot key any session-kind acquire ever lands on (kept up from daemon
      // start for MCP and Skill scans regardless of session activity); evictIdle must not touch it
      // however long it sits with no active session.
      expect(pool.evictIdle(now, () => false)).toBe(0)
      expect(pool.businessWorker()?.link.alive).toBe(true)
    } finally {
      await pool.closeAll(1_000)
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('does not quarantine two crashes a window apart, and quarantines exactly on the third qualifying one', () => {
    let now = 0
    const notices: string[] = []
    const pool = new WorkerPool({
      config: {
        profileName: 'p',
        dataDir: '/tmp/agnes-unused',
        socketPath: '/tmp/agnes-unused/a.sock',
        workersSocketPath: '/tmp/agnes-unused/w.sock',
        limits: DEFAULT_LIMITS,
      },
      profile: { name: 'p', hash: 'h1' } as never,
      profileFile: '/tmp/agnes-unused/profile.json',
      clock: () => now,
      onEvent: () => undefined,
      onRequest: async () => undefined,
      notices: { emit: (k: string) => notices.push(k) },
    })
    const key = 'agnes:t:a:x:dm:2'

    // Crash #1 at t=0.
    expect(pool.crashed(key)).toBe('restart')

    // Crash #2 at t=6min: outside the 5-minute window relative to crash #1, which ages out. Only
    // one crash is in-window at this point, so the pool must remain usable (not quarantined).
    now = 6 * 60_000
    expect(pool.crashed(key)).toBe('restart')
    expect(notices.filter((n) => n === 'worker_crashed')).toHaveLength(2)
    expect(notices).not.toContain('worker_quarantined')

    // Crash #3 one second later: now two crashes (#2, #3) are mutually in-window - still short of
    // the three-strikes threshold, so still not quarantined. This is the "not before" half of the
    // reverse-verification: two qualifying crashes must never trip the breaker.
    now += 1000
    expect(pool.crashed(key)).toBe('restart')
    expect(notices.filter((n) => n === 'worker_crashed')).toHaveLength(3)
    expect(notices).not.toContain('worker_quarantined')

    // Crash #4 one second after that: crashes #2, #3, #4 are all mutually within 5 minutes - the
    // real trigger, firing exactly on this third qualifying crash and not a call earlier.
    now += 1000
    expect(pool.crashed(key)).toBe('quarantined')
    expect(notices).toContain('worker_quarantined')
  })

  it('does not orphan a spawned child when two callers race the same post-crash backoff wait', async () => {
    vi.useFakeTimers()
    try {
      const spawnedChildren: FakeChild[] = []
      const fakeSpawn = ((..._args: unknown[]) => {
        const child = erroredChild()
        spawnedChildren.push(child)
        return child
      }) as unknown as typeof import('node:child_process').spawn

      const pool = new WorkerPool({
        config: {
          profileName: 'p',
          dataDir: '/unused',
          socketPath: '/unused/client.sock',
          workersSocketPath: '/unused/worker.sock',
          limits: { ...DEFAULT_LIMITS, workerStartupMs: 60_000 },
        },
        profile: { name: 'p', hash: 'h1' } as never,
        profileFile: '/unused/profile.json',
        spawn: fakeSpawn,
        clock: () => Date.now(),
        onEvent: () => undefined,
        onRequest: async () => undefined,
        notices: { emit() {} },
      })

      // Models the state right after a crash: `crashed()` sets a future `backoffUntil` for this key
      // and the dead slot is already gone (the `cur?.exitRecovery` branch deletes it before
      // recursing), so the next acquire() calls for this key go straight to the backoff wait with no
      // slot present.
      const workerKey = 'agnes:t:a:x:dm:backoff-race'
      pool.crashed(workerKey)

      // Issue both calls before awaiting either - real concurrency, not a manual retry loop.
      const opts = { kind: 'service', resourceControl: true } as const
      const call1 = pool.acquire(workerKey, opts)
      const call2 = pool.acquire(workerKey, opts)
      // Neither call's fake worker ever completes its hello handshake in this test; both would
      // eventually reject on the startup timeout (60s, never reached here). Only the synchronous
      // slot-management side effects of the race are under test.
      call1.catch(() => undefined)
      call2.catch(() => undefined)

      // Let both backoff timers fire; vi's async timer advance flushes each continuation's
      // microtasks (including the synchronous spawn() + slot bookkeeping) before the next timer
      // callback runs, mirroring two real macrotask-separated resumptions.
      await vi.advanceTimersByTimeAsync(6_000)

      // At least one child was spawned to service this worker key.
      expect(spawnedChildren.length).toBeGreaterThanOrEqual(1)

      pool.killAll()

      // Contract (killAll doc comment): "Force-terminates every child still owned by the pool,
      // including one still in startup." Every process spawned for this key is still in startup
      // (neither received a hello), so every one of them must be force-killed - none may be
      // silently orphaned outside `this.slots` by the backoff race.
      for (const child of spawnedChildren) expect(child.killCalls).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('WorkerPool when a start from the desired target fails', () => {
  const revision = '9'.repeat(64)
  const artifact = (id: string) =>
    encodeRuntimeTargetArtifact(
      buildRuntimeTarget({
        rows: [
          createPluginRow({
            id,
            plugin: `builtin:host/${id}`,
            snapshotDigest: 'builtin:host:v1',
            exportName: id,
            entryRevision: 'host-row:v1',
            extrasRevision: 'none',
            mountRevision: 'host-row:v1',
          }),
        ],
        resources: { mcp: [], skills: {} },
        resourceRevision: revision,
        compositeRevision: revision,
      }),
    )

  async function withBoot(
    setup: (store: CompositeTargetStore) => void,
    run: (ctx: { pool: WorkerPool; store: CompositeTargetStore; notices: string[] }) => Promise<void>,
  ) {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-pool-boot-failure-'))
    const profileFile = join(dir, 'profile.json')
    writeFileSync(profileFile, JSON.stringify({ name: 'p', hash: 'h1' }))
    const config: DaemonConfig = {
      profileName: 'p',
      dataDir: dir,
      socketPath: join(dir, 'a.sock'),
      workersSocketPath: workerSocket(dir),
      // The same window bounds hello and boot_ready. A tsx-started fake worker can take more than
      // 2.5s to say hello on a loaded hosted runner, which then fails before the boot phase under
      // test. These cases wait for boot_ready to time out, up to three times, so the window stays
      // at 10s rather than the daemon default the other real-worker tests use.
      limits: { ...DEFAULT_LIMITS, workerStartupMs: 10_000 },
    }
    const store = new CompositeTargetStore(sqliteTables().table('composite'), 'default')
    setup(store)
    const notices: string[] = []
    const pool = new WorkerPool({
      config,
      profile: { name: 'p', hash: 'h1' } as never,
      profileFile,
      execPath: process.execPath,
      workerEntry: fakeWorker,
      execArgv: ['--import', 'tsx'],
      clock: () => Date.now(),
      onEvent: () => undefined,
      onRequest: async () => undefined,
      notices: { emit: (kind: string) => notices.push(kind) },
      runtimeDelivery: new CompositeRuntimeDelivery(store),
    })
    const server = await listenUnix(config.workersSocketPath, (socket) => pool.adopt(socket))
    try {
      await run({ pool, store, notices })
    } finally {
      pool.killAll()
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const bootstrapOnly = (store: CompositeTargetStore) => store.publishDesired(artifact('ext:bad'))

  it('records the failure and does not count a worker that never became ready as a crash', async () => {
    await withBoot(bootstrapOnly, async ({ pool, store, notices }) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(pool.acquireSharedWorker()).rejects.toThrow('did not boot_ready')
      }
      expect(store.lastFailure()).toMatchObject({ phase: 'boot', digest: store.desired()?.digest })
      expect(notices).not.toContain('worker_crashed')
      expect(pool.isQuarantined('@shared')).toBe(false)
    })
  }, 90_000)

  it('records the failure when the worker process dies while it is starting from the target', async () => {
    process.env.AGNES_FAKE_BOOT = 'exit'
    try {
      await withBoot(bootstrapOnly, async ({ pool, store, notices }) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await expect(pool.acquireSharedWorker()).rejects.toThrow()
        }
        expect(store.lastFailure()).toMatchObject({ phase: 'boot', digest: store.desired()?.digest })
        expect(notices).not.toContain('worker_crashed')
        expect(pool.isQuarantined('@shared')).toBe(false)
      })
    } finally {
      process.env.AGNES_FAKE_BOOT = undefined
      Reflect.deleteProperty(process.env, 'AGNES_FAKE_BOOT')
    }
  }, 90_000)

  it('fails the start as soon as the worker says it cannot apply the target, and records that target', async () => {
    process.env.AGNES_FAKE_BOOT = 'fail'
    try {
      await withBoot(bootstrapOnly, async ({ pool, store, notices }) => {
        await expect(pool.acquireSharedWorker()).rejects.toThrow('plugin threw while starting')
        expect(store.lastFailure()).toMatchObject({ digest: store.desired()?.digest })
        expect(notices).not.toContain('worker_crashed')
        expect(pool.isQuarantined('@shared')).toBe(false)
      })
    } finally {
      Reflect.deleteProperty(process.env, 'AGNES_FAKE_BOOT')
    }
  }, 40_000)

  it('still counts a crash, and blames no target, when the last confirmed target could not start', async () => {
    await withBoot(
      (store) => {
        const good = artifact('ext:good')
        store.publishDesired(good)
        store.qualifyConverged(1, good, { hash: good.identity.treeHash, ok: true, rows: [] })
        store.publishDesired(artifact('ext:newer'))
      },
      async ({ pool, store, notices }) => {
        await expect(pool.acquireSharedWorker()).rejects.toThrow('did not boot_ready')
        expect(store.lastFailure()).toBeUndefined()
        await vi.waitFor(() => expect(notices).toContain('worker_crashed'))
      },
    )
  }, 40_000)
})
