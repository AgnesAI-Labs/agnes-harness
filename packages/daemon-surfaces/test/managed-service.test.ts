import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireManagedLease } from '../src/managed/lease.js'
import { allocateManagedListeners } from '../src/managed/listeners.js'
import { createManagedServiceSupervisor, type ReviewedManagedService } from '../src/managed/supervisor.js'
import type { SurfaceExit, SurfaceRuntimeHandle } from '../src/surfaces/types.js'

const directories: string[] = []
const running: ReturnType<typeof createManagedServiceSupervisor>[] = []
afterEach(async () => {
  for (const s of running.splice(0)) await s.close().catch(() => undefined)
  vi.useRealTimers()
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true })
})
function directory() {
  const d = mkdtempSync(join(tmpdir(), 'agh-managed-unit-'))
  directories.push(d)
  return d
}
const selector = { profileId: 'one', owner: 'sample/plugin', serviceId: 'sample' }
function fixture(
  options: {
    badProof?: boolean
    shutdown?: 'settled' | 'unknown'
    stuck?: boolean
    conflict?: boolean
    fixed?: boolean
  } = {},
) {
  let revision = 'sha256-one',
    activationId = 'active-one',
    spawns = 0,
    stopped = 0
  const abort = new AbortController()
  const endpoints = new Map<
    number,
    { incarnation: string; listeners: readonly string[]; apiVersion: string; healthy: boolean }
  >()
  const events: string[] = []
  const descriptor: ReviewedManagedService['descriptor'] = {
    id: 'sample',
    scope: 'profile',
    artifact: { kind: 'node', entry: './dist/server.mjs' },
    healthPath: '/health',
    listeners: [{ name: 'device', host: '127.0.0.1', port: options.fixed ? 4180 : 'auto' }],
    startupTimeoutMs: 100,
    shutdownTimeoutMs: 100,
    apiVersion: '1.0.0',
    requires: [],
  }
  let rejectResolution = false
  const supervisor = createManagedServiceSupervisor({
    installationId: 'installation',
    directory: directory(),
    healthIntervalMs: 100,
    async resolve(s) {
      if (rejectResolution) throw new Error('disabled')
      return {
        owner: s.owner,
        profileId: s.profileId,
        packageId: '@sample/plugin',
        revision,
        activationId,
        descriptor,
        artifact: { entry: '/synthetic/dist/server.mjs', cwd: '/synthetic' },
        signal: abort.signal,
        assertCurrent() {
          if (abort.signal.aborted) throw new Error('disabled')
        },
      }
    },
    async allocateListeners(d) {
      return Object.fromEntries(
        d.listeners.map((l) => [
          l.name,
          { host: '127.0.0.1' as const, port: l.port === 'auto' ? 32000 + spawns : l.port },
        ]),
      )
    },
    runtime(binding, init) {
      return {
        kind: 'fake',
        start(input) {
          spawns++
          events.push(`start:${binding.revision}`)
          let settle!: (exit: SurfaceExit) => void
          const exited = new Promise<SurfaceExit>((resolve) => {
            settle = resolve
          })
          const port = 33000 + spawns
          endpoints.set(port, {
            incarnation: init.incarnation,
            listeners: Object.keys(init.listeners),
            apiVersion: binding.descriptor.apiVersion,
            healthy: true,
          })
          if (options.conflict) queueMicrotask(() => settle({ code: 98, signal: null }))
          const handle: SurfaceRuntimeHandle = {
            sourceId: input.surface.instance.sourceId,
            endpoint: { host: '127.0.0.1', port, healthPath: '/health' },
            exited,
            probe: async () => true,
            terminate() {
              events.push(`stop:${binding.revision}`)
              if (!options.stuck) {
                stopped++
                settle({ code: 0, signal: null })
              }
            },
            kill() {
              if (!options.stuck) settle({ code: null, signal: 'SIGKILL' })
            },
            cleanup() {},
          }
          return handle
        },
      }
    },
    async request(endpoint, incarnation, path) {
      if (path === '/_agnes/managed/shutdown') return { incarnation, state: options.shutdown ?? 'settled' }
      const ready = endpoints.get(endpoint.port)
      if (!ready?.healthy || options.conflict) throw new Error('unhealthy')
      return {
        incarnation: options.badProof ? 'different-instance' : ready.incarnation,
        apiVersion: ready.apiVersion,
        listeners: ready.listeners,
        storageReady: true,
        shutdownReady: true,
      }
    },
  })
  running.push(supervisor)
  return {
    supervisor,
    abort,
    events,
    descriptor,
    get spawns() {
      return spawns
    },
    get stopped() {
      return stopped
    },
    revision(value: string) {
      revision = value
    },
    activate() {
      activationId = 'active-two'
    },
    disable() {
      rejectResolution = true
    },
    unhealthy() {
      for (const e of endpoints.values()) e.healthy = false
    },
  }
}
describe('managed service supervisor', () => {
  it('shares one ready instance across generations and refuses other profiles and API majors', async () => {
    const f = fixture()
    const [a, b] = await Promise.all([f.supervisor.ensure(selector, 1), f.supervisor.ensure(selector, 1)])
    expect(a.state).toBe('ready')
    expect(b.instanceId).toBe(a.instanceId)
    expect(f.spawns).toBe(1)
    expect(await f.supervisor.ensure(selector)).toEqual(a)
    await expect(f.supervisor.ensure(selector, 2)).rejects.toThrow('REFUSED')
    const other = await f.supervisor.ensure({ ...selector, profileId: 'two' })
    expect(other.state).toBe('ready')
    expect(other.instanceId).not.toBe(a.instanceId)
    expect(f.spawns).toBe(2)
    await f.supervisor.stop(selector)
    expect(f.supervisor.signal(selector).aborted).toBe(true)
    expect(f.supervisor.status({ ...selector, profileId: 'two' })?.state).toBe('ready')
  })
  it('fails closed on an unrelated HTTP 200 and bounds auto-port retries without restoring old code', async () => {
    vi.useFakeTimers()
    const bad = fixture({ badProof: true }),
      pending = bad.supervisor.ensure(selector)
    await vi.advanceTimersByTimeAsync(200)
    expect((await pending).state).toBe('failed')
    expect(bad.spawns).toBe(1)
    const auto = fixture({ conflict: true })
    const a = await auto.supervisor.ensure(selector)
    expect(a).toMatchObject({ state: 'failed', reason: 'port-in-use' })
    expect(auto.spawns).toBe(3)
    const fixed = fixture({ conflict: true, fixed: true })
    expect(await fixed.supervisor.ensure(selector)).toMatchObject({ state: 'failed', reason: 'port-in-use' })
    expect(fixed.spawns).toBe(1)
  })
  it('cold upgrades terminate first, expose unknown settlement and never restart old work', async () => {
    const f = fixture({ shutdown: 'unknown' })
    await f.supervisor.ensure(selector)
    f.revision('sha256-two')
    const next = await f.supervisor.ensure(selector)
    expect(next).toMatchObject({ state: 'ready', revision: 'sha256-two' })
    expect(f.events).toEqual(['start:sha256-one', 'stop:sha256-one', 'start:sha256-two'])
    f.disable()
    f.abort.abort()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await f.supervisor.stop(selector)
    expect(f.supervisor.status(selector)).toMatchObject({ state: 'stopped', reason: 'shutdown-unconfirmed' })
    await expect(f.supervisor.ensure(selector)).rejects.toThrow('REFUSED')
    expect(f.spawns).toBe(2)
  })
  it('revokes live authority when health fails and retains failed cleanup as visible unknown', async () => {
    vi.useFakeTimers()
    const f = fixture({ stuck: true })
    await f.supervisor.ensure(selector)
    const signal = f.supervisor.signal(selector)
    f.unhealthy()
    await vi.advanceTimersByTimeAsync(2200)
    expect(signal.aborted).toBe(true)
    expect(f.supervisor.status(selector)).toMatchObject({ state: 'failed', reason: 'shutdown-unconfirmed' })
    f.revision('sha256-two')
    await expect(f.supervisor.ensure(selector)).rejects.toThrow('SHUTDOWN_UNCONFIRMED')
    expect(f.spawns).toBe(1)
  })
  it('reports a busy fixed listener without disturbing its owner and allocates distinct automatic listeners', async () => {
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const address = blocker.address()
    if (!address || typeof address === 'string') throw new Error('missing port')
    const f = fixture()
    try {
      await expect(
        allocateManagedListeners({
          ...f.descriptor,
          listeners: [{ name: 'device', host: '127.0.0.1', port: address.port }],
        }),
      ).rejects.toThrow('PORT_IN_USE')
      expect(blocker.listening).toBe(true)
      const ports = await allocateManagedListeners({
        ...f.descriptor,
        listeners: [
          { name: 'one', host: '127.0.0.1', port: 'auto' },
          { name: 'two', host: '127.0.0.1', port: 'auto' },
        ],
      })
      expect(ports.one?.host).toBe('127.0.0.1')
      expect(ports.one?.port).not.toBe(ports.two?.port)
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  it('serializes independent supervisors with kernel leases and preserves crash uncertainty', () => {
    const d = directory(),
      one = acquireManagedLease(d, 'same-profile-owner-service')
    one.record('active')
    expect(() => acquireManagedLease(d, 'same-profile-owner-service')).toThrow('BUSY')
    const isolated = acquireManagedLease(d, 'other-profile-owner-service')
    isolated.record('stopped')
    isolated.release()
    one.release()
    const recovered = acquireManagedLease(d, 'same-profile-owner-service')
    expect(recovered.previous).toBe('active')
    recovered.diagnose('shutdown-unconfirmed')
    expect(recovered.diagnostics()).toEqual(['shutdown-unconfirmed'])
    recovered.record('stopped')
    recovered.release()
  })
  it('disable during asynchronous resolution cannot start a late instance', async () => {
    let resolve!: (binding: ReviewedManagedService) => void
    const binding: ReviewedManagedService = {
      owner: selector.owner,
      profileId: selector.profileId,
      packageId: '@sample/plugin',
      revision: 'sha256-one',
      activationId: 'one',
      descriptor: {
        id: 'sample',
        scope: 'profile',
        artifact: { kind: 'node', entry: './dist/server.mjs' },
        healthPath: '/health',
        listeners: [],
        startupTimeoutMs: 100,
        shutdownTimeoutMs: 100,
        apiVersion: '1.0.0',
        requires: [],
      },
      artifact: { entry: '/synthetic/dist/server.mjs', cwd: '/synthetic' },
      signal: new AbortController().signal,
      assertCurrent() {},
    }
    const s = createManagedServiceSupervisor({
      installationId: 'installation',
      directory: directory(),
      resolve: () =>
        new Promise((r) => {
          resolve = r
        }),
    })
    running.push(s)
    const start = s.ensure(selector)
    const failure = expect(start).rejects.toThrow()
    const stopping = s.stop(selector)
    resolve(binding)
    await failure
    await stopping
    expect(s.status(selector)).toBeUndefined()
  })
})
