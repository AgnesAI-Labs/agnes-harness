import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceInvocationSource, WorkspaceInvocationView } from '../src/index.js'
import { createWorkspaceInvocationPort, HookEngine } from '../src/index.js'
import { fakeSeams } from './helpers/fake-seams.js'

const source = (over: Partial<WorkspaceInvocationSource> = {}): WorkspaceInvocationSource => {
  const seams = fakeSeams()
  return {
    root: '/workspace',
    fs: {
      read: async () => new Uint8Array(),
      write: async () => undefined,
      list: async () => [],
      stat: async () => ({ kind: 'file', size: 0, mtimeMs: 0 }),
    },
    ready: async () => ({ confine: async (argv) => argv }),
    hookSnapshot: async () => ({
      workspaceDigest: 'sha256-workspace',
      policyRevision: 'policy-1',
      hooks: [{ event: 'before_step' }],
    }),
    hookSandbox: {
      enforcement: () => ({ level: 'full', scope: ['process'] }),
      exec: async () => ({ code: 0, stdout: '', stderr: '', truncated: false }),
    },
    approval: seams.approval,
    checkpoint: seams.checkpoint,
    ...over,
  }
}

describe('WorkspaceInvocationPort', () => {
  it('acquires synchronously and invokes on the next microtask before releasing once', async () => {
    const order: string[] = []
    const port = createWorkspaceInvocationPort(() => {
      order.push('acquire')
      return {
        source: source(),
        release: () => {
          order.push('release')
        },
      }
    })

    const result = port.run(async (view) => {
      order.push('invoke')
      return view.root
    })
    order.push('returned')

    expect(order).toEqual(['acquire', 'returned'])
    await expect(result).resolves.toBe('/workspace')
    expect(order).toEqual(['acquire', 'returned', 'invoke', 'release'])
  })

  it('surfaces acquisition refusal synchronously without invoking or releasing', () => {
    const invoke = vi.fn(async () => undefined)
    const port = createWorkspaceInvocationPort(() => {
      throw Object.assign(new Error('E_WORKSPACE_CLOSED: closing'), { code: 'E_WORKSPACE_CLOSED' })
    })

    expect(() => port.run(invoke)).toThrow('E_WORKSPACE_CLOSED')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('releases once when a hostile source throws while the invocation view is constructed', async () => {
    const release = vi.fn()
    const invoke = vi.fn(async () => undefined)
    const raw = source()
    const approval = new Proxy(raw.approval, {
      get() {
        throw new Error('hostile approval getter')
      },
    })
    const port = createWorkspaceInvocationPort(() => ({
      source: source({ approval }),
      release,
    }))

    await expect(port.run(invoke)).rejects.toThrow('hostile approval getter')
    expect(invoke).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })

  it('releases exactly once when the callback rejects', async () => {
    const failure = new Error('callback failed')
    const release = vi.fn()
    const acquire = vi.fn(() => ({ source: source(), release }))
    const port = createWorkspaceInvocationPort(acquire)

    await expect(
      port.run(async () => {
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(acquire).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
  })

  it('closes registration, aborts and drains an unawaited descendant before release', async () => {
    let finishRead!: () => void
    const read = vi.fn(
      () =>
        new Promise<Uint8Array>((resolve) => {
          finishRead = () => resolve(new Uint8Array([1]))
        }),
    )
    const release = vi.fn()
    let leaked!: WorkspaceInvocationView
    let cachedFs!: ReturnType<WorkspaceInvocationView['fs']>
    const port = createWorkspaceInvocationPort(() => ({
      source: source({ fs: { ...source().fs, read } }),
      release,
    }))

    const running = port.run(async (view) => {
      leaked = view
      cachedFs = view.fs()
      void cachedFs.read('slow')
      return 'callback-settled'
    })
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    await Promise.resolve()
    expect(release).not.toHaveBeenCalled()
    expect(() => leaked.fs()).toThrow('E_WORKSPACE_CLOSED')

    finishRead()
    await expect(running).resolves.toBe('callback-settled')
    expect(release).toHaveBeenCalledOnce()
    await expect(cachedFs.read('late')).rejects.toMatchObject({ code: 'E_WORKSPACE_CLOSED' })
  })

  it('revokes cached fs, confine, approval, checkpoint and hook operations as one scope', async () => {
    const dispose = vi.fn()
    const raw = source()
    const port = createWorkspaceInvocationPort(() => ({
      source: source({
        approval: { ...raw.approval, onGrantRevoked: () => dispose },
      }),
      release: () => undefined,
    }))
    let leaked!: WorkspaceInvocationView
    let fs!: ReturnType<WorkspaceInvocationView['fs']>
    let confine!: Awaited<ReturnType<WorkspaceInvocationView['ready']>>
    let approval!: ReturnType<WorkspaceInvocationView['approvalContext']>
    let checkpoint!: ReturnType<WorkspaceInvocationView['checkpointContext']>
    let snapshot!: Awaited<ReturnType<WorkspaceInvocationView['hookSnapshot']>>

    await port.run(async (view) => {
      leaked = view
      fs = view.fs()
      confine = await view.ready()
      approval = view.approvalContext()
      checkpoint = view.checkpointContext()
      snapshot = await view.hookSnapshot()
      approval.onGrantRevoked?.(() => undefined)
    })

    expect(dispose).toHaveBeenCalledOnce()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.hooks)).toBe(true)
    expect(Object.isFrozen(snapshot.hooks[0])).toBe(true)
    await expect(fs.stat('.')).rejects.toMatchObject({ code: 'E_WORKSPACE_CLOSED' })
    await expect(confine.confine(['echo'])).rejects.toMatchObject({ code: 'E_WORKSPACE_CLOSED' })
    await expect(approval.ask({} as never)).rejects.toMatchObject({ code: 'E_WORKSPACE_CLOSED' })
    await expect(checkpoint.list()).rejects.toMatchObject({ code: 'E_WORKSPACE_CLOSED' })
    await expect(leaked.hookSnapshot()).rejects.toMatchObject({ code: 'E_WORKSPACE_CLOSED' })
    expect(() => leaked.approvalContext()).toThrow('E_WORKSPACE_CLOSED')
    expect(() => leaked.checkpointContext()).toThrow('E_WORKSPACE_CLOSED')
  })

  it('aborts an unawaited readiness operation and waits for it before release', async () => {
    const release = vi.fn()
    let observed: AbortSignal | undefined
    const port = createWorkspaceInvocationPort(() => ({
      source: source({
        ready: (signal) =>
          new Promise((_, reject) => {
            observed = signal
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
          }),
      }),
      release,
    }))

    await expect(
      port.run(async (view) => {
        void view.ready()
      }),
    ).resolves.toBeUndefined()
    expect(observed?.aborted).toBe(true)
    expect(release).toHaveBeenCalledOnce()
  })

  it('drains an unawaited hook exec and revokes the cached sandbox after callback settle', async () => {
    let finishExec!: () => void
    const exec = vi.fn(
      () =>
        new Promise<{ code: number; stdout: string; stderr: string; truncated: boolean }>((resolve) => {
          finishExec = () => resolve({ code: 0, stdout: '', stderr: '', truncated: false })
        }),
    )
    const release = vi.fn()
    const raw = source()
    let cached!: ReturnType<WorkspaceInvocationView['hookSandbox']>
    const port = createWorkspaceInvocationPort(() => ({
      source: source({ hookSandbox: { ...raw.hookSandbox, exec } }),
      release,
    }))

    const running = port.run(async (view) => {
      cached = view.hookSandbox()
      void cached.exec(['echo'], { cwd: '/workspace' })
    })
    await vi.waitFor(() => expect(exec).toHaveBeenCalledOnce())
    await Promise.resolve()
    expect(release).not.toHaveBeenCalled()
    expect(() => cached.enforcement()).toThrow('E_WORKSPACE_CLOSED')
    await expect(cached.exec(['late'], { cwd: '/workspace' })).rejects.toMatchObject({
      code: 'E_WORKSPACE_CLOSED',
    })

    finishExec()
    await expect(running).resolves.toBeUndefined()
    expect(release).toHaveBeenCalledOnce()
  })

  it('holds the lease for an emit handler raw promise and revokes its cached sandbox afterward', async () => {
    let finish!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const handler = new Promise<void>((resolve) => {
      finish = resolve
    })
    const engine = new HookEngine({
      leaseFor: () => ({ expiresAt: '2099-01-01T00:00:00.000Z', scope: {}, budget: { remaining: 1 } }),
      onFailure: () => undefined,
      diag: () => undefined,
      platform: { shell: 'posix', fs: { caseSensitive: true, pathSep: '/' }, terminal: { color: false } },
    })
    engine.on(
      'subagent_start',
      async () => {
        entered()
        await handler
      },
      { source: 'agnes/hooks-runner', trust: 'builtin' },
    )
    const release = vi.fn()
    const port = createWorkspaceInvocationPort(() => ({ source: source(), release }))
    let cached!: ReturnType<WorkspaceInvocationView['hookSandbox']>

    const running = port.run(async (view) => {
      cached = view.hookSandbox()
      return engine.dispatch('subagent_start', () => ({ childKey: 'child', kind: 'spawn', budget: null }), {
        session: { key: 'session', lane: 'main', workspaceRoot: view.root },
        signal: new AbortController().signal,
        replayed: false,
        log: { debug() {}, info() {}, warn() {}, error() {} },
        workspaceSandbox: cached,
      })
    })

    await started
    await vi.waitFor(() => expect(() => cached.enforcement()).toThrow('E_WORKSPACE_CLOSED'))
    expect(release).not.toHaveBeenCalled()
    finish()
    await expect(running).resolves.toEqual({ kind: 'ok', results: [] })
    expect(release).toHaveBeenCalledOnce()
    await expect(cached.exec(['late'], { cwd: '/workspace' })).rejects.toMatchObject({
      code: 'E_WORKSPACE_CLOSED',
    })
    const track = cached.track
    if (!track) throw new Error('workspace hook tracker unavailable')
    await expect(track(async () => undefined)).rejects.toMatchObject({ code: 'E_WORKSPACE_CLOSED' })
  })

  it('keeps a timed-out handler raw promise in the invocation drain until it settles', async () => {
    let fireTimeout!: () => void
    let finish!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const handler = new Promise<void>((resolve) => {
      finish = resolve
    })
    const engine = new HookEngine({
      leaseFor: () => ({ expiresAt: '2099-01-01T00:00:00.000Z', scope: {}, budget: { remaining: 1 } }),
      onFailure: () => undefined,
      diag: () => undefined,
      timers: {
        setTimeout(fn) {
          fireTimeout = fn
          return 1
        },
        clearTimeout() {},
      },
      platform: { shell: 'posix', fs: { caseSensitive: true, pathSep: '/' }, terminal: { color: false } },
    })
    engine.on(
      'session_start',
      async () => {
        entered()
        await handler
      },
      { source: 'agnes/hooks-runner', trust: 'builtin' },
    )
    const release = vi.fn()
    const port = createWorkspaceInvocationPort(() => ({ source: source(), release }))

    const running = port.run((view) =>
      engine.dispatch('session_start', () => ({ reason: 'new', preset: 'standard', cwd: view.root }), {
        session: { key: 'session', lane: 'main', workspaceRoot: view.root },
        signal: new AbortController().signal,
        replayed: false,
        log: { debug() {}, info() {}, warn() {}, error() {} },
        workspaceSandbox: view.hookSandbox(),
      }),
    )

    await started
    fireTimeout()
    await Promise.resolve()
    await Promise.resolve()
    expect(release).not.toHaveBeenCalled()
    finish()
    await expect(running).resolves.toEqual({ kind: 'ok', results: [] })
    expect(release).toHaveBeenCalledOnce()
  })

  it('does not release while a cancelled approval adapter still ignores abort and runs', async () => {
    let finishAsk!: () => void
    const ask = vi.fn(
      () =>
        new Promise<'allowed-once'>((resolve) => {
          finishAsk = () => resolve('allowed-once')
        }),
    )
    const raw = source()
    const release = vi.fn()
    const port = createWorkspaceInvocationPort(() => ({
      source: source({ approval: { ...raw.approval, ask } }),
      release,
    }))

    const running = port.run(async (view) => {
      void view.approvalContext().ask({} as never)
    })
    await vi.waitFor(() => expect(ask).toHaveBeenCalledOnce())
    await Promise.resolve()
    expect(release).not.toHaveBeenCalled()

    finishAsk()
    await expect(running).resolves.toBeUndefined()
    expect(release).toHaveBeenCalledOnce()
  })
})
