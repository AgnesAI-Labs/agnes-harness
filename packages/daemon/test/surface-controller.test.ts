import { EventEmitter } from 'node:events'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ResolvedDeployment } from '@agnes/host'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createLocalNodeRuntime,
  createSurfaceController,
  type SpawnedSurfaceProcess,
  type SurfaceExit,
  type SurfaceRuntimeAdapter,
  type SurfaceRuntimeHandle,
  type SurfaceSpawnOptions,
} from '../src/index.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function deployment(options: { sourceId?: string; secretRef?: string } = {}): ResolvedDeployment {
  const sourceId = options.sourceId ?? 'dashboard-source'
  return {
    id: 'customer',
    version: '1.0.0',
    inventoryHash: 'sha256-inventory',
    deploymentHash: 'sha256-deployment',
    policyHash: 'sha256-policy',
    hash: 'sha256-plan',
    surfaces: [
      {
        package: '@acme/dashboard',
        version: '1.0.0',
        integrity: 'sha256-package',
        descriptor: {
          id: 'dashboard',
          apiRange: '^1.0.0',
          artifact: { kind: 'node', entry: './dist/server.mjs' },
          healthPath: '/healthz',
          requires: { services: [] },
        },
        instance: {
          package: '@acme/dashboard',
          surfaceId: 'dashboard',
          mount: '/dashboard',
          sourceId,
          config: { title: 'Reports' },
          secrets: { Backend: options.secretRef ?? 'secret://surface/backend' },
          grants: [],
        },
        services: [],
      },
    ],
  }
}

function deploymentWithSources(...sourceIds: string[]): ResolvedDeployment {
  const base = deployment()
  const surface = base.surfaces[0]
  if (surface === undefined) throw new Error('surface fixture missing')
  return {
    ...base,
    surfaces: sourceIds.map((sourceId, index) => ({
      ...surface,
      descriptor: { ...surface.descriptor, id: `dashboard-${index}` },
      instance: {
        ...surface.instance,
        surfaceId: `dashboard-${index}`,
        sourceId,
        mount: `/dashboard-${index}`,
      },
    })),
  }
}

class FakeProcess extends EventEmitter implements SpawnedSurfaceProcess {
  readonly pid = 4242
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly signals: NodeJS.Signals[] = []

  constructor(
    private readonly termExits: boolean,
    private readonly killExits = true,
  ) {
    super()
  }

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal)
    if ((signal === 'SIGTERM' && this.termExits) || (signal === 'SIGKILL' && this.killExits)) {
      queueMicrotask(() => this.exit(null, signal))
    }
    return true
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }
}

function artifact(): { root: string; entry: string } {
  const root = mkdtempSync(join(tmpdir(), 'agnes-surface-'))
  temporaryDirectories.push(root)
  const dist = join(root, 'dist')
  mkdirSync(dist)
  const entry = join(dist, 'server.mjs')
  writeFileSync(entry, 'setInterval(() => undefined, 1000)\n')
  return { root, entry }
}

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

type FakeHandle = SurfaceRuntimeHandle & {
  terminate: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  cleanup: ReturnType<typeof vi.fn>
}

/** An in-memory runtime that hands out a distinct handle per `start()` call, so a `sourceId` spawned
 * more than once across a cold boot plus an `update()` gets a fresh handle each time. `healthy` and
 * `reaps` are keyed by spawn order, which is how a test makes one specific spawn misbehave. */
function fakeRuntime(
  hooks: {
    beforeStart?: () => Promise<void>
    /** Whether the nth spawned handle ever answers its health probe. Default: every one does. May
     * return a promise, which lets a test hold one spawn inside its health wait. */
    healthy?: (index: number) => boolean | Promise<boolean>
    /** Whether the nth spawned handle exits on TERM/KILL. Default: every one does. */
    reaps?: (index: number) => boolean
    /** Optional delay between TERM/KILL and the nth handle's exit actually landing, which lets a test
     * hold a whole-controller stop open. Default: the exit lands on the next microtask. */
    exitDelay?: (index: number) => Promise<void> | void
  } = {},
): {
  adapter: SurfaceRuntimeAdapter
  handles: FakeHandle[]
} {
  const handles: FakeHandle[] = []
  let nextPort = 32_000
  const adapter: SurfaceRuntimeAdapter = {
    kind: 'test',
    start: async ({ surface }) => {
      await hooks.beforeStart?.()
      const index = handles.length
      let settle: ((exit: SurfaceExit) => void) | undefined
      const exited = new Promise<SurfaceExit>((resolve) => {
        settle = resolve
      })
      const reaps = hooks.reaps?.(index) ?? true
      const settleExit = () => {
        if (!reaps) return
        void Promise.resolve(hooks.exitDelay?.(index)).then(() => settle?.({ code: 0, signal: 'SIGTERM' }))
      }
      const handle: FakeHandle = {
        sourceId: surface.instance.sourceId,
        endpoint: { host: '127.0.0.1', port: nextPort++, healthPath: '/healthz' },
        exited,
        probe: async () => hooks.healthy?.(index) ?? true,
        terminate: vi.fn(settleExit),
        kill: vi.fn(settleExit),
        cleanup: vi.fn<() => void>(),
      }
      handles.push(handle)
      return handle
    },
  }
  return { adapter, handles }
}

function trustedArtifacts() {
  return { resolveNodeArtifact: () => ({ cwd: '/trusted', entry: '/trusted/dist/server.mjs' }) }
}

function constantSecrets() {
  return { resolve: () => 'value' }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function onlySurface(plan: ResolvedDeployment) {
  const surface = plan.surfaces[0]
  if (surface === undefined) throw new Error('surface fixture missing')
  return surface
}

describe('SurfaceController', () => {
  it.runIf(process.platform === 'win32')(
    'stops real Windows Surface descendants with their owning runtime',
    async () => {
      const file = artifact()
      const pidFile = join(file.root, 'descendant.pid')
      writeFileSync(
        file.entry,
        `import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
child.once('spawn',()=>writeFileSync(${JSON.stringify(pidFile)},String(child.pid)));
setInterval(()=>{},1000);`,
      )
      const runtime = createLocalNodeRuntime({ allocatePort: () => 31345, healthProbe: async () => true })
      const plan = deployment()
      const surface = plan.surfaces[0]
      if (!surface) throw new Error('missing fixture')
      const starting = new AbortController()
      const handle = await runtime.start({
        deployment: plan,
        surface,
        artifact: { cwd: file.root, entry: file.entry },
        secrets: {},
        signal: starting.signal,
      })
      try {
        const descendant = await vi.waitFor(() => Number(readFileSync(pidFile, 'utf8')), { timeout: 5000 })
        expect(descendant).toBeGreaterThan(0)
        starting.abort()
        await new Promise((done) => setTimeout(done, 100))
        expect(() => process.kill(descendant, 0)).not.toThrow()
        expect(() => process.kill(handle.pid as number, 0)).not.toThrow()
        handle.terminate()
        await handle.exited
        await handle.cleanup()
        expect(() => process.kill(descendant, 0)).toThrow()
      } finally {
        handle.kill()
        await handle.cleanup()
      }
    },
  )
  it('starts a Node artifact with fixed argv/env, becomes healthy, and drains with TERM', async () => {
    const plan = deployment()
    const file = artifact()
    const child = new FakeProcess(true)
    const spawned = vi.fn(
      (_executable: string, _argv: readonly string[], _options: SurfaceSpawnOptions) => child,
    )
    const secretDisposed = vi.fn()
    const runtimeCleanup = vi.fn()
    const log = logger()
    const runtime = createLocalNodeRuntime({
      allocatePort: () => 31_337,
      spawn: spawned,
      healthProbe: async () => true,
      cleanup: runtimeCleanup,
    })
    const controller = createSurfaceController({
      artifacts: { resolveNodeArtifact: () => ({ cwd: file.root, entry: file.entry }) },
      secrets: {
        resolve: async () => ({ value: 'top-secret-value', dispose: secretDisposed }),
      },
      runtime,
      log,
      startupMs: 500,
      shutdownGraceMs: 50,
      killWaitMs: 20,
    })

    await expect(controller.start(plan)).resolves.toMatchObject({
      phase: 'running',
      deploymentHash: plan.hash,
      instances: [{ sourceId: 'dashboard-source', state: 'healthy' }],
    })
    expect(secretDisposed).toHaveBeenCalledTimes(1)
    expect(spawned).toHaveBeenCalledTimes(1)
    const [executable, argv, options] = spawned.mock.calls[0] as [
      string,
      readonly string[],
      SurfaceSpawnOptions,
    ]
    expect(executable).toBe(process.execPath)
    expect(argv).toEqual([realpathSync.native(file.entry)])
    expect(options).toMatchObject({
      cwd: realpathSync.native(file.root),
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    })
    expect(Object.keys(options.env).sort()).toEqual([
      'AGNES_SURFACE_CONFIG',
      'AGNES_SURFACE_MOUNT',
      'AGNES_SURFACE_SECRETS',
      'AGNES_SURFACE_SOURCE_ID',
      'HOST',
      'NODE_ENV',
      'PORT',
    ])
    expect(options.env.AGNES_SURFACE_SECRETS).toBe('{"Backend":"top-secret-value"}')
    expect(JSON.stringify(controller.snapshot())).not.toContain('top-secret-value')
    expect(JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls])).not.toContain(
      'top-secret-value',
    )

    await expect(controller.stop()).resolves.toBeUndefined()
    expect(child.signals).toEqual(['SIGTERM'])
    expect(runtimeCleanup).toHaveBeenCalledWith('dashboard-source')
    expect(controller.snapshot()).toEqual({ phase: 'idle', instances: [] })
  })

  it('escalates an unhealthy start from TERM to KILL and removes runtime material', async () => {
    const file = artifact()
    const child = new FakeProcess(false)
    const cleanup = vi.fn()
    const controller = createSurfaceController({
      artifacts: { resolveNodeArtifact: () => ({ cwd: file.root, entry: file.entry }) },
      secrets: { resolve: () => 'secret-never-logged' },
      runtime: createLocalNodeRuntime({
        allocatePort: () => 31_338,
        spawn: () => child,
        healthProbe: async () => false,
        cleanup,
      }),
      startupMs: 5,
      healthIntervalMs: 1,
      shutdownGraceMs: 2,
      killWaitMs: 20,
    })

    await expect(controller.start(deployment())).rejects.toMatchObject({
      code: 'START_FAILED',
    })
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(controller.snapshot()).toEqual({ phase: 'idle', instances: [] })
  })

  it('lets stop cancel a hanging start, terminates the child, and disposes its secret lease', async () => {
    const file = artifact()
    const child = new FakeProcess(true)
    const disposed = vi.fn()
    const cleanup = vi.fn()
    const controller = createSurfaceController({
      artifacts: { resolveNodeArtifact: () => ({ cwd: file.root, entry: file.entry }) },
      secrets: { resolve: () => ({ value: 'cancel-secret', dispose: disposed }) },
      runtime: createLocalNodeRuntime({
        allocatePort: () => 31_339,
        spawn: () => child,
        healthProbe: (_endpoint, signal) =>
          new Promise<boolean>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
          }),
        cleanup,
      }),
      startupMs: 1_000,
      shutdownGraceMs: 20,
    })
    const starting = controller.start(deployment())
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledTimes(1))
    const stopping = controller.stop()

    await expect(starting).rejects.toMatchObject({ code: 'START_FAILED' })
    await expect(stopping).resolves.toBeUndefined()
    expect(child.signals).toEqual(['SIGTERM'])
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(controller.snapshot().instances).toHaveLength(0)
  })

  it('marks an unexpected process exit degraded and runs cleanup once', async () => {
    const plan = deployment()
    let exit!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      exit = resolve
    })
    const cleanup = vi.fn()
    const handle: SurfaceRuntimeHandle = {
      sourceId: 'dashboard-source',
      endpoint: { host: '127.0.0.1', port: 31_340, healthPath: '/healthz' },
      exited,
      probe: async () => true,
      terminate: vi.fn(),
      kill: vi.fn(),
      cleanup,
    }
    const controller = createSurfaceController({
      artifacts: { resolveNodeArtifact: () => ({ cwd: '/trusted', entry: '/trusted/dist/server.mjs' }) },
      secrets: { resolve: () => 'value' },
      runtime: { kind: 'test', start: async () => handle },
    })
    await controller.start(plan)
    exit({ code: 7, signal: null })
    await vi.waitFor(() => expect(controller.snapshot().phase).toBe('degraded'))

    expect(controller.snapshot().instances).toEqual([
      expect.objectContaining({ state: 'crashed', exit: { code: 7, signal: null } }),
    ])
    expect(cleanup).toHaveBeenCalledTimes(1)
    await controller.stop()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('reports a bounded stop failure after TERM and KILL while still invoking cleanup', async () => {
    const file = artifact()
    const child = new FakeProcess(false, false)
    const cleanup = vi.fn()
    const controller = createSurfaceController({
      artifacts: { resolveNodeArtifact: () => ({ cwd: file.root, entry: file.entry }) },
      secrets: { resolve: () => 'value' },
      runtime: createLocalNodeRuntime({
        allocatePort: () => 31_341,
        spawn: () => child,
        healthProbe: async () => true,
        cleanup,
      }),
      shutdownGraceMs: 2,
      killWaitMs: 2,
    })
    await controller.start(deployment())

    await expect(controller.stop()).rejects.toMatchObject({ code: 'STOP_FAILED' })
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(controller.snapshot()).toMatchObject({
      phase: 'degraded',
      deploymentHash: 'sha256-plan',
      instances: [{ state: 'stopping', endpoint: { port: 31_341 } }],
    })
  })

  it('does not turn an OCI descriptor into a local command', async () => {
    const nodePlan = deployment()
    const surface = nodePlan.surfaces[0]
    if (surface === undefined) throw new Error('surface fixture missing')
    const ociPlan: ResolvedDeployment = {
      ...nodePlan,
      surfaces: [
        {
          ...surface,
          descriptor: {
            ...surface.descriptor,
            artifact: {
              kind: 'oci',
              image: `registry.example/acme/dashboard@sha256:${'a'.repeat(64)}`,
            },
          },
        },
      ],
    }
    const resolveNodeArtifact = vi.fn()
    const start = vi.fn()
    const controller = createSurfaceController({
      artifacts: { resolveNodeArtifact },
      secrets: { resolve: () => 'value' },
      runtime: { kind: 'local-test', start },
    })

    await expect(controller.start(ociPlan)).rejects.toMatchObject({ code: 'START_FAILED' })
    expect(resolveNodeArtifact).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it('rejects a linked entry before spawning it', async () => {
    const file = artifact()
    const outside = artifact()
    rmSync(file.entry)
    // Use a directory junction on Windows so this security test runs without elevated file-link
    // privileges. The runtime must reject either kind of final reparse entry before spawn.
    if (process.platform === 'win32') symlinkSync(outside.root, file.entry, 'junction')
    else symlinkSync(outside.entry, file.entry)
    const spawn = vi.fn()
    const controller = createSurfaceController({
      artifacts: { resolveNodeArtifact: () => ({ cwd: file.root, entry: file.entry }) },
      secrets: { resolve: () => 'value' },
      runtime: createLocalNodeRuntime({ allocatePort: () => 31_342, spawn }),
      startupMs: 20,
    })

    await expect(controller.start(deployment())).rejects.toMatchObject({ code: 'START_FAILED' })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects a symlink cwd before spawning from it', async () => {
    const file = artifact()
    const parent = mkdtempSync(join(tmpdir(), 'agnes-surface-link-'))
    temporaryDirectories.push(parent)
    const linkedRoot = join(parent, 'package')
    // guards-allow-platform: real directory alias without Windows file-symlink privileges.
    symlinkSync(file.root, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir')
    expect(realpathSync(linkedRoot)).toBe(realpathSync(file.root))
    const spawn = vi.fn()
    const controller = createSurfaceController({
      artifacts: {
        resolveNodeArtifact: () => ({ cwd: linkedRoot, entry: join(linkedRoot, 'dist/server.mjs') }),
      },
      secrets: { resolve: () => 'value' },
      runtime: createLocalNodeRuntime({ allocatePort: () => 31_343, spawn }),
    })

    await expect(controller.start(deployment())).rejects.toMatchObject({ code: 'START_FAILED' })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('binds the resolved file to the descriptor entry exactly', async () => {
    const file = artifact()
    const otherEntry = join(file.root, 'dist', 'other.mjs')
    writeFileSync(otherEntry, 'setInterval(() => undefined, 1000)\n')
    const spawn = vi.fn()
    const controller = createSurfaceController({
      artifacts: { resolveNodeArtifact: () => ({ cwd: file.root, entry: otherEntry }) },
      secrets: { resolve: () => 'value' },
      runtime: createLocalNodeRuntime({ allocatePort: () => 31_344, spawn }),
    })

    await expect(controller.start(deployment())).rejects.toMatchObject({ code: 'START_FAILED' })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('hard-times out a health probe that ignores abort', async () => {
    const handle: SurfaceRuntimeHandle = {
      sourceId: 'dashboard-source',
      endpoint: { host: '127.0.0.1', port: 31_345, healthPath: '/healthz' },
      exited: new Promise(() => undefined),
      probe: () => new Promise(() => undefined),
      terminate: vi.fn(),
      kill: vi.fn(),
      cleanup: vi.fn(),
    }
    const controller = createSurfaceController({
      artifacts: { resolveNodeArtifact: () => ({ cwd: '/trusted', entry: '/trusted/dist/server.mjs' }) },
      secrets: { resolve: () => 'value' },
      runtime: { kind: 'test', start: () => handle },
      startupMs: 10,
      shutdownGraceMs: 5,
      killWaitMs: 5,
      cleanupMs: 5,
    })

    await expect(controller.start(deployment())).rejects.toMatchObject({ code: 'START_FAILED' })
    expect(handle.kill).toHaveBeenCalled()
  })

  it('hard-times out a secret disposer that ignores abort', async () => {
    const handle: SurfaceRuntimeHandle = {
      sourceId: 'dashboard-source',
      endpoint: { host: '127.0.0.1', port: 31_346, healthPath: '/healthz' },
      exited: Promise.resolve({ code: 0, signal: null }),
      probe: async () => true,
      terminate: vi.fn(),
      kill: vi.fn(),
      cleanup: vi.fn(),
    }
    const controller = createSurfaceController({
      artifacts: { resolveNodeArtifact: () => ({ cwd: '/trusted', entry: '/trusted/dist/server.mjs' }) },
      secrets: {
        resolve: () => ({ value: 'value', dispose: () => new Promise(() => undefined) }),
      },
      runtime: { kind: 'test', start: () => handle },
      startupMs: 100,
      cleanupMs: 5,
    })

    await expect(controller.start(deployment())).rejects.toMatchObject({ code: 'START_FAILED' })
    expect(handle.cleanup).toHaveBeenCalled()
  })

  it('uses one stop deadline for multiple hung processes and cleanup hooks', async () => {
    const plan = deploymentWithSources('surface-a', 'surface-b', 'surface-c')
    const cleanups: Array<ReturnType<typeof vi.fn>> = []
    const controller = createSurfaceController({
      artifacts: { resolveNodeArtifact: () => ({ cwd: '/trusted', entry: '/trusted/dist/server.mjs' }) },
      secrets: { resolve: () => 'value' },
      runtime: {
        kind: 'test',
        start: ({ surface }) => {
          const cleanup = vi.fn(() => new Promise<void>(() => undefined))
          cleanups.push(cleanup)
          return {
            sourceId: surface.instance.sourceId,
            endpoint: { host: '127.0.0.1', port: 31_347, healthPath: '/healthz' },
            exited: new Promise(() => undefined),
            probe: async () => true,
            terminate: vi.fn(),
            kill: vi.fn(),
            cleanup,
          }
        },
      },
      shutdownGraceMs: 10,
      killWaitMs: 10,
      cleanupMs: 10,
    })
    await controller.start(plan)

    const stopStartedAt = Date.now()
    await expect(controller.stop()).rejects.toMatchObject({ code: 'STOP_FAILED' })
    expect(Date.now() - stopStartedAt).toBeLessThan(200)
    expect(cleanups).toHaveLength(3)
    expect(cleanups.every((cleanup) => cleanup.mock.calls.length === 1)).toBe(true)
    expect(controller.snapshot().phase).toBe('degraded')
  })

  it('rejects a second concurrent update for the same sourceId with BUSY', async () => {
    const plan = deployment()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let starts = 0
    const runtime = fakeRuntime({
      beforeStart: async () => {
        if (starts++ > 0) await gate
      },
    })
    const controller = createSurfaceController({
      artifacts: trustedArtifacts(),
      secrets: constantSecrets(),
      runtime: runtime.adapter,
      startupMs: 2_000,
    })
    await controller.start(plan)

    const first = controller.update(plan, onlySurface(plan))
    await expect(controller.update(plan, onlySurface(plan))).rejects.toMatchObject({
      code: 'BUSY',
      message: expect.stringContaining('already in flight'),
    })

    release()
    await expect(first).resolves.toMatchObject({ sourceId: 'dashboard-source', state: 'healthy' })
    // The guard is released once the in-flight operation settles.
    await expect(controller.update(plan, onlySurface(plan))).resolves.toMatchObject({
      sourceId: 'dashboard-source',
      state: 'healthy',
    })
  })

  it('cleans up a failed update without leaving a stale record behind', async () => {
    const plan = deployment()
    const runtime = fakeRuntime()
    // Fails before a handle is ever created (`runtime.start` itself rejects), so `spawnInstance`
    // never reaches `records.set`; this exercises the "no record was created at all" outcome, not
    // `discardRecord`'s cleanup of a handle that was created but never became healthy (see
    // "reaps an instance that spawned but never became healthy during an update" for that).
    const failing: SurfaceRuntimeAdapter = {
      kind: 'test',
      start: (input) =>
        runtime.handles.length === 0
          ? runtime.adapter.start(input)
          : Promise.reject(new Error('spawn refused')),
    }
    const controller = createSurfaceController({
      artifacts: trustedArtifacts(),
      secrets: constantSecrets(),
      runtime: failing,
    })
    await controller.start(plan)

    await expect(controller.update(plan, onlySurface(plan))).rejects.toMatchObject({
      code: 'START_FAILED',
    })

    // The old instance was already stopped before the new one failed to start, and a start failure
    // does not restore it -- the Surface has no running instance until the next successful update.
    expect(controller.snapshot().instances).toHaveLength(0)
    expect(runtime.handles[0]?.terminate).toHaveBeenCalledTimes(1)
  })

  it('reaps an instance that spawned but never became healthy during an update', async () => {
    const plan = deployment()
    // Only the cold-boot instance (index 0) answers its health probe; the update's new instance
    // (index 1) spawns a live child and then times out -- the failure mode that actually leaks a
    // process if nobody drains it.
    const runtime = fakeRuntime({ healthy: (index) => index === 0 })
    const controller = createSurfaceController({
      artifacts: trustedArtifacts(),
      secrets: constantSecrets(),
      runtime: runtime.adapter,
      startupMs: 30,
      healthIntervalMs: 1,
      shutdownGraceMs: 50,
      killWaitMs: 20,
    })
    await controller.start(plan)

    await expect(controller.update(plan, onlySurface(plan))).rejects.toMatchObject({
      code: 'START_FAILED',
    })

    expect(runtime.handles).toHaveLength(2)
    expect(runtime.handles[1]?.terminate).toHaveBeenCalledTimes(1)
    expect(runtime.handles[1]?.cleanup).toHaveBeenCalledTimes(1)
    // The old instance was already stopped by the update before the new one was spawned.
    expect(runtime.handles[0]?.terminate).toHaveBeenCalledTimes(1)
    expect(controller.snapshot().instances).toHaveLength(0)
  })

  it('a concurrent whole-controller stop terminates an update in flight and leaves no process behind', async () => {
    const plan = deployment()
    const gates = { probe: deferred() }
    // index 0 is the cold boot; index 1 is the update's new instance, whose health check hangs on
    // `gates.probe` so the test can race a whole-controller `stop()` against it while it is still
    // 'starting'. `stop()` finds this record in the table (update() runs strictly stop-old-then-
    // spawn-new, so by the time the new instance lands in the table the old one is already gone) and
    // terminates it directly -- `waitForSurfaceHealth`'s internal race then loses to the resulting
    // exit event before the health probe (still gated on `gates.probe`) ever gets to answer. This is
    // a different failure path than an orphaned-record reap (spawnInstance's post-health-check
    // `records.get(sourceId) !== record` guard): that guard exists for a record removed from the
    // table WITHOUT its handle being terminated first, which no longer has a reachable trigger now
    // that `coldUpdate` is the only non-boot path into `spawnInstance` and always stops-then-spawns
    // serially. What this test actually proves: a `stop()` racing an in-flight `update()` reliably
    // reaps the new instance's process either way, so nothing survives unmanaged.
    const runtime = fakeRuntime({
      healthy: async (index) => {
        if (index === 1) await gates.probe.promise
        return true
      },
    })
    const controller = createSurfaceController({
      artifacts: trustedArtifacts(),
      secrets: constantSecrets(),
      runtime: runtime.adapter,
      startupMs: 2_000,
      shutdownGraceMs: 2_000,
    })
    await controller.start(plan)

    const pending = controller.update(plan, onlySurface(plan))
    // Wait for the update's new instance specifically -- checking table length alone is not enough:
    // the old (cold-boot) record stays in the table, moved to 'stopping', for most of `update`'s own
    // `stopRecord` step, so the table briefly reads length 1 for the OLD record too. Only `starting`
    // uniquely identifies the new instance, still waiting on its health check.
    await vi.waitFor(() =>
      expect(controller.snapshot().instances.some((instance) => instance.state === 'starting')).toBe(true),
    )
    const stopping = controller.stop()
    await stopping
    // The new instance's handle was already terminated by `stop()`'s own drain; resolving the probe
    // gate now just lets its stalled health check unwind (it will lose the race to the exit event).
    gates.probe.resolve()

    await expect(pending).rejects.toMatchObject({ code: 'START_FAILED' })
    expect(runtime.handles).toHaveLength(2)
    expect(runtime.handles[1]?.terminate).toHaveBeenCalled()
    expect(runtime.handles[1]?.cleanup).toHaveBeenCalled()
    expect(controller.snapshot().instances).toHaveLength(0)
  })

  it('keeps and logs a failed update whose child could not be reaped', async () => {
    const plan = deployment()
    const log = logger()
    // index 0 (cold boot) turns healthy and reaps cleanly; index 1 (the update's new instance) never
    // turns healthy AND ignores TERM/KILL, so its drain cannot finish.
    const runtime = fakeRuntime({
      healthy: (index) => index === 0,
      reaps: (index) => index === 0,
    })
    const controller = createSurfaceController({
      artifacts: trustedArtifacts(),
      secrets: constantSecrets(),
      runtime: runtime.adapter,
      log,
      startupMs: 30,
      healthIntervalMs: 1,
      shutdownGraceMs: 10,
      killWaitMs: 10,
      cleanupMs: 10,
    })
    await controller.start(plan)

    await expect(controller.update(plan, onlySurface(plan))).rejects.toMatchObject({
      code: 'START_FAILED',
    })

    expect(runtime.handles[1]?.terminate).toHaveBeenCalledTimes(1)
    expect(runtime.handles[1]?.kill).toHaveBeenCalledTimes(1)
    // A stuck child must stay visible: silently dropping the record would leave nothing anywhere
    // saying a Surface process survived its own failed startup.
    expect(log.error.mock.calls.map(([message]) => message)).toContain(
      'surface instance cleanup did not complete',
    )
    expect(controller.snapshot().instances).toEqual(
      expect.arrayContaining([expect.objectContaining({ state: 'stopping' })]),
    )
  })

  it('refuses update before the controller has cold booted', async () => {
    const plan = deployment()
    const runtime = fakeRuntime()
    const controller = createSurfaceController({
      artifacts: trustedArtifacts(),
      secrets: constantSecrets(),
      runtime: runtime.adapter,
    })

    await expect(controller.update(plan, onlySurface(plan))).rejects.toThrow(
      'has not completed an initial boot',
    )
    expect(runtime.handles).toHaveLength(0)
  })

  it('cold-updates by stopping the old instance first and does not restore it after start failure', async () => {
    const plan = deployment()
    const runtime = fakeRuntime({ healthy: (index) => index === 0 })
    const controller = createSurfaceController({
      artifacts: trustedArtifacts(),
      secrets: constantSecrets(),
      runtime: runtime.adapter,
      startupMs: 30,
      healthIntervalMs: 1,
      shutdownGraceMs: 50,
      killWaitMs: 20,
    })
    await controller.start(plan)
    expect(controller.snapshot().instances).toEqual([expect.objectContaining({ state: 'healthy' })])
    await expect(controller.update(plan, onlySurface(plan))).rejects.toMatchObject({ code: 'START_FAILED' })
    expect(runtime.handles[0]?.terminate).toHaveBeenCalled()
    // The old instance was stopped and the new one failed to start: no instance is left running.
    expect(controller.snapshot().instances).toHaveLength(0)
  })
})
