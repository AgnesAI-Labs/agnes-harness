import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DaemonDiscovery, DaemonScope } from '@agnes/daemon'
import * as daemon from '@agnes/daemon'
import * as host from '@agnes/host'
import type { Client } from '@agnes/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LaunchResources } from '../launch/resources.js'
import { ensureLocalBackend, type SpawnDaemonInput } from '../src/boot/backend.js'
import { BootError } from '../src/errors.js'

const TEST_RESOURCES = {
  mode: 'package' as const,
  root: '/tmp/agnes-test-resources',
  daemonEntry: '/tmp/agnes-test-resources/daemon.mjs',
  workerEntry: '/tmp/agnes-test-resources/worker.mjs',
  webRoot: '/tmp/agnes-test-resources/web',
}

vi.mock('@agnes/daemon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agnes/daemon')>()
  return {
    ...actual,
    acquireDaemonStartup: vi.fn(),
    daemonStatus: vi.fn(),
    readDaemonDiscovery: vi.fn(),
    readDaemonWebCredential: vi.fn(),
    resolveDaemonScope: vi.fn(),
    stopDaemon: vi.fn(),
  }
})

vi.mock('@agnes/host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agnes/host')>()
  return {
    ...actual,
    defaultProcessIdentity: vi.fn(async (pid: number) => ({ state: 'alive', startId: `start-${pid}` })),
  }
})

const scope: DaemonScope = {
  home: '/tmp/agnes-test-home',
  profile: 'local-dev',
  workspace: '/tmp/agnes-test-cwd',
  profileDir: '/tmp/agnes-test-home/profiles/local-dev',
  dataDir: '/tmp/agnes-test-home/profiles/local-dev/data',
  daemonDir: '/tmp/agnes-test-home/profiles/local-dev/data/daemon',
  ownerPath: '/tmp/agnes-test-home/profiles/local-dev/data/daemon/owner.json',
  discoveryPath: '/tmp/agnes-test-home/profiles/local-dev/data/daemon/discovery.json',
  webCredentialPath: '/tmp/agnes-test-home/profiles/local-dev/data/daemon/web-credential',
  profileFile: '/tmp/agnes-test-home/profiles/local-dev/profile.json',
  scopeID: 'scope-local-dev',
}

type DescriptorOverrides = {
  scopeID?: string
  dataDir?: string
  socketPath?: string
  owner?: DaemonDiscovery['owner']
  web?: DaemonDiscovery['web']
}

function descriptor(overrides: DescriptorOverrides = {}): DaemonDiscovery {
  const { web, ...identityOverrides } = overrides
  const base: Omit<DaemonDiscovery, 'web'> = {
    protocol: 'agnesd-discovery',
    version: 1,
    capabilities: web ? ['unix', 'local-web'] : ['unix'],
    scopeID: scope.scopeID,
    profile: scope.profile,
    profileHash: 'profile-hash-1',
    dataDir: scope.dataDir,
    socketPath: join(scope.daemonDir, 'agnesd.sock'),
    owner: {
      pid: 123,
      processStartId: 'start-123',
      generation: 'generation-1',
      startedAt: new Date().toISOString(),
    },
    ...identityOverrides,
    ready: true,
  }
  return web ? { ...base, web } : base
}

type FakeChild = ChildProcess & { unref: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> }

function fakeChild(pid = 123): FakeChild {
  const child = new EventEmitter() as FakeChild
  Object.assign(child, {
    pid,
    exitCode: null,
    signalCode: null,
    unref: vi.fn(),
    kill: vi.fn((signal: NodeJS.Signals) => {
      ;(child as unknown as { signalCode: NodeJS.Signals | null }).signalCode =
        signal === 'SIGTERM' || signal === 'SIGKILL' ? signal : null
      return true
    }),
  })
  return child
}

function fakeClient(
  overrides: Partial<{
    initialize: () => Promise<void>
    configGet: () => Promise<unknown>
    apis: () => Promise<unknown>
  }> = {},
): Client {
  return {
    initialize: overrides.initialize ?? (async () => undefined),
    config: { get: overrides.configGet ?? (async () => ({ profile: scope.profile })) },
    apis: overrides.apis ?? (async () => ({ profile: { name: scope.profile } })),
    close: vi.fn(async () => undefined),
  } as unknown as Client
}

function setupMocks(): void {
  vi.clearAllMocks()
  vi.mocked(host.defaultProcessIdentity).mockImplementation(async (pid) => ({
    state: 'alive',
    startId: `start-${pid}`,
  }))
  vi.mocked(daemon.resolveDaemonScope).mockResolvedValue(scope)
  vi.mocked(daemon.readDaemonDiscovery).mockResolvedValue(null)
  vi.mocked(daemon.readDaemonWebCredential).mockResolvedValue('test-web-token')
  vi.mocked(daemon.daemonStatus).mockResolvedValue({ running: false })
  vi.mocked(daemon.acquireDaemonStartup).mockReturnValue({ release: vi.fn() })
  vi.mocked(daemon.stopDaemon).mockResolvedValue('stopped')
}

function statusOwner(discovery: DaemonDiscovery): {
  pid: number
  processStartId: string
  generation: string
  startedAt: string
  socketPath: string
} {
  return { ...discovery.owner, socketPath: discovery.socketPath }
}

afterEach(() => {
  vi.restoreAllMocks()
})

beforeEach(() => {
  setupMocks()
})

describe('ensureLocalBackend', () => {
  it.skipIf(process.platform === 'win32')(
    'reports unsafe short directory before spawning, but still reuses a live discovery',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'agnes-cli-path-'))
      const longScope = { ...scope, dataDir: join(root, 'long-'.repeat(30)) }
      const paths = daemon.daemonSocketPaths({ dataDir: longScope.dataDir, ipc: 'unix' })
      const directory = join(paths.socketPath, '..')
      writeFileSync(directory, 'preserve')
      vi.mocked(daemon.resolveDaemonScope).mockResolvedValue(longScope)
      const spawnDaemon = vi.fn()
      try {
        await expect(ensureLocalBackend({ resources: TEST_RESOURCES, spawnDaemon })).rejects.toThrow(
          /short socket directory/,
        )
        expect(spawnDaemon).not.toHaveBeenCalled()
        vi.mocked(daemon.readDaemonDiscovery).mockResolvedValue(descriptor({ dataDir: longScope.dataDir }))
        await expect(
          ensureLocalBackend({ spawnDaemon, createClientImpl: () => fakeClient() }),
        ).resolves.toBeDefined()
        expect(spawnDaemon).not.toHaveBeenCalled()
      } finally {
        rmSync(directory, { force: true })
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  it.each([undefined, { url: 'ws://127.0.0.1:49100', origin: 'http://127.0.0.1:4180' }])(
    'attaches by IPC without imposing startup Web defaults: %j',
    async (web) => {
      vi.mocked(daemon.readDaemonDiscovery).mockResolvedValue(descriptor({ web }))
      const spawnDaemon = vi.fn()
      const result = await ensureLocalBackend({
        startupWeb: { addr: '127.0.0.1:0', origin: 'http://127.0.0.1:4177' },
        createClientImpl: () => fakeClient(),
        spawnDaemon,
      })
      expect(result.discovery.owner.generation).toBe('generation-1')
      expect(result.web).toBeUndefined()
      expect(spawnDaemon).not.toHaveBeenCalled()
      expect(daemon.readDaemonWebCredential).not.toHaveBeenCalled()
    },
  )

  it('does not relax an explicit Web origin to the discovered one', async () => {
    vi.mocked(daemon.readDaemonDiscovery).mockResolvedValue(
      descriptor({
        web: { url: 'ws://127.0.0.1:49100', origin: 'http://127.0.0.1:4180' },
      }),
    )
    await expect(
      ensureLocalBackend({
        webOrigin: 'http://127.0.0.1:4177',
        createClientImpl: () => fakeClient(),
      }),
    ).rejects.toThrow('origin does not match')
    expect(daemon.stopDaemon).not.toHaveBeenCalled()
  })

  it('uses startup Web defaults only for its own newly launched daemon', async () => {
    const discovery = descriptor({ web: { url: 'ws://127.0.0.1:49100', origin: 'http://127.0.0.1:4177' } })
    const spawned = vi.fn((_input: SpawnDaemonInput) => {
      vi.mocked(daemon.readDaemonDiscovery).mockResolvedValue(discovery)
      return fakeChild()
    })
    await ensureLocalBackend({
      resources: TEST_RESOURCES,
      startupWeb: { addr: '127.0.0.1:0', origin: 'http://127.0.0.1:4177' },
      spawnDaemon: spawned,
      createClientImpl: () => fakeClient(),
    })
    expect(spawned.mock.calls[0]?.[0].argv).toContain('http://127.0.0.1:4177')
    expect(daemon.readDaemonWebCredential).not.toHaveBeenCalled()
  })

  it
    .runIf(process.platform === 'win32')
    .each(['timeout', 'early-exit', 'abort-after-spawn', 'unrelated-owner'] as const)(
    'cleans up a real Windows daemon child on %s',
    async (scenario) => {
      const root = mkdtempSync(join(tmpdir(), 'agnes-真实失败-'))
      const entry = join(root, 'daemon.mjs')
      writeFileSync(entry, scenario === 'early-exit' ? 'process.exit(7)' : 'setTimeout(()=>{},3000)')
      vi.mocked(daemon.resolveDaemonScope).mockResolvedValue({ ...scope, workspace: root })
      const actual = await vi.importActual<typeof import('@agnes/host')>('@agnes/host')
      vi.mocked(host.defaultProcessIdentity).mockImplementation(actual.defaultProcessIdentity)
      const controller = new AbortController()
      let ownChild: host.DetachedChild | undefined
      const unrelated =
        scenario === 'unrelated-owner'
          ? actual.spawnDetachedProcess(process.execPath, [entry], { cwd: root, env: process.env })
          : undefined
      const launched = vi.spyOn(host, 'spawnDetachedProcess').mockImplementation((...args) => {
        ownChild = actual.spawnDetachedProcess(...args)
        // The native process already exists. Cancellation must use this handle, not skip cleanup.
        if (scenario === 'abort-after-spawn') controller.abort()
        return ownChild
      })
      try {
        if (unrelated?.pid !== undefined) {
          const identity = await actual.defaultProcessIdentity(unrelated.pid)
          if (identity.state !== 'alive') throw new Error('Unrelated fixture did not start')
          const owner = { ...statusOwner(descriptor()), pid: unrelated.pid, processStartId: identity.startId }
          vi.mocked(daemon.daemonStatus).mockImplementation(async () =>
            ownChild ? { running: true, owner } : { running: false },
          )
        }
        const expected =
          scenario === 'early-exit'
            ? /exited before readiness \(7\)/
            : scenario === 'abort-after-spawn'
              ? /cancelled/
              : /deadline|did not become ready/
        await expect(
          ensureLocalBackend({
            resources: { ...TEST_RESOURCES, root, daemonEntry: entry },
            signal: controller.signal,
            readinessTimeoutMs: scenario === 'early-exit' ? 1500 : 500,
            readinessPollMs: 5,
          }),
        ).rejects.toThrow(expected)
        expect(launched).toHaveBeenCalledOnce()
        const pid = ownChild?.pid
        if (pid === undefined) throw new Error('Real child was not started')
        await expect
          .poll(() => actual.defaultProcessIdentity(pid), { timeout: 500 })
          .toEqual({ state: 'dead' })
        expect(vi.mocked(daemon.acquireDaemonStartup).mock.results[0]?.value.release).toHaveBeenCalledOnce()
        expect(daemon.stopDaemon).not.toHaveBeenCalled()
        if (unrelated?.pid !== undefined)
          expect(await actual.defaultProcessIdentity(unrelated.pid)).toMatchObject({ state: 'alive' })
      } finally {
        if (ownChild) actual.releaseDetachedProcess(ownChild)
        if (unrelated) {
          try {
            unrelated.kill('SIGTERM')
            const pid = unrelated.pid
            if (pid !== undefined)
              await expect
                .poll(() => actual.defaultProcessIdentity(pid), { timeout: 1000 })
                .toEqual({ state: 'dead' })
          } finally {
            actual.releaseDetachedProcess(unrelated)
          }
        }
        rmSync(root, { recursive: true, force: true })
      }
    },
  )
  it('fails within the finite startup deadline and cleans up its child', async () => {
    const child = fakeChild()
    const spawnDaemon = vi.fn((_input: SpawnDaemonInput) => child)
    const started = performance.now()

    await expect(
      ensureLocalBackend({
        resources: TEST_RESOURCES,
        spawnDaemon,
        readinessTimeoutMs: 30,
        readinessPollMs: 3,
      }),
    ).rejects.toThrow(/readiness deadline|did not become ready/)

    expect(performance.now() - started).toBeLessThan(500)
    expect(spawnDaemon).toHaveBeenCalledOnce()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(vi.mocked(daemon.acquireDaemonStartup).mock.results[0]?.value.release).toHaveBeenCalledOnce()
  })

  it('honours an abort during startup and terminates only its child', async () => {
    const child = fakeChild()
    const controller = new AbortController()
    const spawnDaemon = vi.fn((_input: SpawnDaemonInput) => {
      setTimeout(() => controller.abort(), 5)
      return child
    })

    await expect(
      ensureLocalBackend({
        signal: controller.signal,
        resources: TEST_RESOURCES,
        spawnDaemon,
        readinessTimeoutMs: 1_000,
        readinessPollMs: 5,
      }),
    ).rejects.toThrow('cancelled')

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(vi.mocked(daemon.stopDaemon)).not.toHaveBeenCalled()
  })

  it('bounds identity probing and still cleans up the spawned handle safely', async () => {
    const child = fakeChild()
    vi.mocked(host.defaultProcessIdentity).mockImplementationOnce(() => new Promise(() => undefined))

    await expect(
      ensureLocalBackend({
        resources: TEST_RESOURCES,
        spawnDaemon: vi.fn(() => child),
        readinessTimeoutMs: 30,
        readinessPollMs: 2,
      }),
    ).rejects.toThrow(/deadline|did not become ready/)

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  // The daemon and its workers must resolve the very home this CLI selected, under the current
  // variable name: a caller environment naming some other AGH_HOME must not reach the child.
  it('hands the daemon child its scope home as AGH_HOME', async () => {
    const child = fakeChild()
    const launch: { input?: SpawnDaemonInput } = {}
    await expect(
      ensureLocalBackend({
        env: { AGH_HOME: '/tmp/agnes-some-other-home' },
        resources: TEST_RESOURCES,
        spawnDaemon: (input) => {
          launch.input = input
          queueMicrotask(() => child.emit('error', new Error('fixture child stopped')))
          return child
        },
        readinessTimeoutMs: 500,
        readinessPollMs: 2,
      }),
    ).rejects.toThrow(/fixture child stopped/)

    expect(launch.input?.env.AGH_HOME).toBe(scope.home)
  })

  it('uses the bundled Node runtime for a SEA daemon child', async () => {
    const child = fakeChild()
    const launch: { input?: SpawnDaemonInput } = {}
    const seaModule = { isSea: () => true } as unknown as ReturnType<typeof process.getBuiltinModule>
    vi.spyOn(process, 'getBuiltinModule').mockImplementation((id) =>
      id === 'node:sea' ? seaModule : undefined,
    )
    const resources = {
      ...TEST_RESOURCES,
      mode: 'sea' as const,
      runtimeNode: '/opt/agnes/runtime/node',
    } as LaunchResources & { runtimeNode: string }
    const spawned = vi.fn((input: SpawnDaemonInput) => {
      launch.input = input
      queueMicrotask(() => child.emit('error', new Error('fixture child stopped')))
      return child
    })

    await expect(
      ensureLocalBackend({
        resources,
        spawnDaemon: spawned,
        readinessTimeoutMs: 500,
        readinessPollMs: 2,
      }),
    ).rejects.toThrow(/fixture child stopped/)

    expect(launch.input?.execPath).toBe('/opt/agnes/runtime/node')
    expect(launch.input?.execPath).not.toBe('node')
  })

  it('keeps the startup lock through SDK verification and cleans up its own failed generation', async () => {
    const child = fakeChild()
    const events: string[] = []
    const release = vi.fn(() => events.push('release'))
    vi.mocked(daemon.acquireDaemonStartup).mockReturnValue({ release })
    let statusReads = 0
    vi.mocked(daemon.daemonStatus).mockImplementation(async () => {
      statusReads += 1
      return statusReads === 1 ? { running: false } : { running: true, owner: statusOwner(descriptor()) }
    })
    let reads = 0
    vi.mocked(daemon.readDaemonDiscovery).mockImplementation(async () => {
      reads += 1
      return reads >= 3 ? descriptor() : null
    })
    vi.mocked(daemon.stopDaemon).mockImplementation(async () => {
      events.push('stop')
      return 'stopped'
    })
    const configFailure = new Error('config handshake failed')
    const client = fakeClient({
      configGet: async () => {
        events.push('config-failure')
        throw configFailure
      },
    })

    await expect(
      ensureLocalBackend({
        resources: TEST_RESOURCES,
        spawnDaemon: vi.fn(() => child),
        createClientImpl: () => client,
        readinessTimeoutMs: 500,
        readinessPollMs: 2,
      }),
    ).rejects.toThrow(/config handshake failed/)

    expect(events.indexOf('config-failure')).toBeGreaterThanOrEqual(0)
    expect(events.indexOf('stop')).toBeGreaterThan(events.indexOf('config-failure'))
    expect(events.indexOf('release')).toBeGreaterThan(events.indexOf('stop'))
    expect(vi.mocked(daemon.stopDaemon)).toHaveBeenCalledOnce()
  })

  it('preserves an unrelated owner when its child fails after ownership changed', async () => {
    const child = fakeChild()
    const unrelated = descriptor({
      owner: { ...descriptor().owner, pid: 999, processStartId: 'start-999', generation: 'generation-2' },
    })
    let statusReads = 0
    vi.mocked(daemon.daemonStatus).mockImplementation(async () => {
      statusReads += 1
      return statusReads === 1 ? { running: false } : { running: true, owner: statusOwner(unrelated) }
    })
    let reads = 0
    vi.mocked(daemon.readDaemonDiscovery).mockImplementation(async () => {
      reads += 1
      return reads >= 3 ? unrelated : null
    })
    const client = fakeClient({
      configGet: async () => {
        ;(child as unknown as { exitCode: number | null }).exitCode = 0
        throw new Error('late SDK failure')
      },
    })

    await expect(
      ensureLocalBackend({
        resources: TEST_RESOURCES,
        spawnDaemon: vi.fn(() => child),
        createClientImpl: () => client,
        readinessTimeoutMs: 500,
        readinessPollMs: 2,
      }),
    ).rejects.toThrow(/late SDK failure/)

    expect(vi.mocked(daemon.stopDaemon)).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('does not let a hung SDK close defeat bounded startup failure', async () => {
    const child = fakeChild()
    let statusReads = 0
    vi.mocked(daemon.daemonStatus).mockImplementation(async () => {
      statusReads += 1
      return statusReads === 1 ? { running: false } : { running: true, owner: statusOwner(descriptor()) }
    })
    let reads = 0
    vi.mocked(daemon.readDaemonDiscovery).mockImplementation(async () => {
      reads += 1
      return reads >= 3 ? descriptor() : null
    })
    const client = fakeClient({
      configGet: async () => {
        ;(child as unknown as { exitCode: number | null }).exitCode = 0
        throw new Error('SDK request failed')
      },
    })
    const close = vi.fn(() => new Promise<void>(() => undefined))
    client.close = close
    const started = performance.now()

    await expect(
      ensureLocalBackend({
        resources: TEST_RESOURCES,
        spawnDaemon: vi.fn(() => child),
        createClientImpl: () => client,
        readinessTimeoutMs: 100,
        readinessPollMs: 2,
      }),
    ).rejects.toThrow(/SDK request failed/)

    expect(close).toHaveBeenCalledOnce()
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('fails closed for a discovery whose Web origin does not match', async () => {
    const spawnDaemon = vi.fn((_input: SpawnDaemonInput) => fakeChild())
    vi.mocked(daemon.readDaemonDiscovery).mockResolvedValue(
      descriptor({ web: { url: 'http://127.0.0.1:4188', origin: 'http://127.0.0.1:4188' } }),
    )

    await expect(
      ensureLocalBackend({
        webOrigin: 'http://127.0.0.1:4177',
        localWeb: { addr: '127.0.0.1:0', origin: 'http://127.0.0.1:4177' },
        resources: TEST_RESOURCES,
        spawnDaemon,
        readinessTimeoutMs: 100,
      }),
    ).rejects.toThrow(/origin does not match/)

    expect(spawnDaemon).not.toHaveBeenCalled()
    expect(vi.mocked(daemon.acquireDaemonStartup)).not.toHaveBeenCalled()
  })

  it('reclaims a stale discovery and publishes a fresh generation', async () => {
    const child = fakeChild()
    let reads = 0
    vi.mocked(daemon.readDaemonDiscovery).mockImplementation(async () => {
      reads += 1
      return reads >= 3 ? descriptor() : null
    })
    const client = fakeClient()

    const result = await ensureLocalBackend({
      resources: TEST_RESOURCES,
      spawnDaemon: vi.fn(() => child),
      createClientImpl: () => client,
      readinessTimeoutMs: 500,
      readinessPollMs: 2,
    })

    expect(result.discovery.owner.generation).toBe('generation-1')
    expect(vi.mocked(daemon.acquireDaemonStartup)).toHaveBeenCalledOnce()
  })

  it('reuses one scope and endpoint when invoked from different working directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-cli-cwd-'))
    const firstCwd = join(root, 'one')
    const secondCwd = join(root, 'two')
    mkdirSync(firstCwd)
    mkdirSync(secondCwd)
    const actual = await vi.importActual<typeof import('@agnes/daemon')>('@agnes/daemon')
    const resolveCalls: string[] = []
    vi.mocked(daemon.resolveDaemonScope).mockImplementation(async (options = {}) => {
      resolveCalls.push(options.cwd ?? '')
      return actual.resolveDaemonScope({
        ...options,
        home: root,
        profile: 'local-dev',
        dataDir: join(root, 'shared-data'),
      })
    })
    vi.mocked(daemon.readDaemonDiscovery).mockImplementation(async (current) => ({
      ...descriptor(),
      scopeID: current.scopeID,
      dataDir: current.dataDir,
      socketPath: join(current.daemonDir, 'agnesd.sock'),
    }))
    const client = fakeClient()

    try {
      const first = await ensureLocalBackend({ cwd: firstCwd, createClientImpl: () => client })
      const second = await ensureLocalBackend({ cwd: secondCwd, createClientImpl: () => client })
      expect(resolveCalls).toEqual([firstCwd, secondCwd])
      expect(first.scope.scopeID).toBe(second.scope.scopeID)
      expect(first.socketPath).toBe(second.socketPath)
      expect(vi.mocked(daemon.acquireDaemonStartup)).not.toHaveBeenCalled()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects an invalid timing configuration before launching anything', async () => {
    await expect(ensureLocalBackend({ readinessTimeoutMs: 0 })).rejects.toBeInstanceOf(BootError)
    expect(vi.mocked(daemon.resolveDaemonScope)).not.toHaveBeenCalled()
  })
})
