import { describe, expect, it, vi } from 'vitest'
import {
  type ProbedSandboxWorkspaceBackend,
  SandboxReadinessManager,
  type SandboxWorkspaceProbe,
} from '../src/sandbox-readiness-manager.js'

const hash = (digit: string): string => digit.repeat(64)
const key = (root = '/Work') => ({
  backendId: 'seatbelt-v1',
  canonicalRoot: root,
  staticConfigHash: hash('a'),
  caseSensitive: true,
})

describe('SandboxReadinessManager', () => {
  it('singleflights the exact key and caches only the successful backend', async () => {
    let release: (value: ProbedSandboxWorkspaceBackend | PromiseLike<ProbedSandboxWorkspaceBackend>) => void =
      () => {}
    const probe = vi.fn<SandboxWorkspaceProbe>(
      () =>
        new Promise((resolve) => {
          release = resolve
        }) as ReturnType<SandboxWorkspaceProbe>,
    )
    const manager = new SandboxReadinessManager(probe)
    const activated: ProbedSandboxWorkspaceBackend[] = []
    const a = manager.bind(key(), (raw) => activated.push(raw)).capability.ready()
    const b = manager.bind(key()).capability.ready()
    expect(probe).toHaveBeenCalledOnce()
    release({
      execBackend: 'l1',
      enforcement: { level: 'full', scope: ['file', 'network', 'process'] },
      confine: ({ argv }: { argv: readonly string[] }) => [...argv, '--confined'],
    })
    const [left, right] = await Promise.all([a, b])
    expect(await left.confine({ argv: ['echo'], cwd: '/Work' })).toEqual(['echo', '--confined'])
    expect(await right.confine({ argv: ['pwd'], cwd: '/Work' })).toEqual(['pwd', '--confined'])
    expect(activated[0]).toMatchObject({ execBackend: 'l1' })
    expect(Object.keys(left)).toEqual(['confine'])
    await manager.bind(key()).capability.ready()
    expect(probe).toHaveBeenCalledOnce()
    await manager.revoke()
  })

  it('uses root case semantics in the canonical-root component of the key', async () => {
    const probe = vi.fn<SandboxWorkspaceProbe>(async () => ({ confine: ({ argv }) => argv }))
    const manager = new SandboxReadinessManager(probe)
    await Promise.all([
      manager.bind({ ...key('/Work'), caseSensitive: false }).capability.ready(),
      manager.bind({ ...key('/work'), caseSensitive: false }).capability.ready(),
    ])
    expect(probe).toHaveBeenCalledOnce()
    await manager.bind(key('/Work')).capability.ready()
    expect(probe).toHaveBeenCalledTimes(2)
    await manager.revoke()
  })

  it('does not cache failure and retries the next open', async () => {
    const probe = vi
      .fn<SandboxWorkspaceProbe>()
      .mockRejectedValueOnce(new Error('probe failed'))
      .mockResolvedValueOnce({ confine: ({ argv }) => argv })
    const manager = new SandboxReadinessManager(probe)
    await expect(manager.bind(key()).capability.ready()).rejects.toMatchObject({
      code: 'E_SANDBOX_WORKSPACE',
    })
    await expect(manager.bind(key()).capability.ready()).resolves.toBeDefined()
    expect(probe).toHaveBeenCalledTimes(2)
    await manager.revoke()
  })

  it('keeps one waiters cancellation from cancelling the shared probe', async () => {
    let release: (value: ProbedSandboxWorkspaceBackend | PromiseLike<ProbedSandboxWorkspaceBackend>) => void =
      () => {}
    const probe = vi.fn<SandboxWorkspaceProbe>(
      () =>
        new Promise((resolve) => {
          release = resolve
        }) as ReturnType<SandboxWorkspaceProbe>,
    )
    const manager = new SandboxReadinessManager(probe)
    const abort = new AbortController()
    const cancelled = manager.bind(key()).capability.ready(abort.signal)
    const survivor = manager.bind(key()).capability.ready()
    abort.abort(new Error('caller left'))
    await expect(cancelled).rejects.toThrow('caller left')
    release({ confine: ({ argv }: { argv: readonly string[] }) => argv })
    await expect(survivor).resolves.toBeDefined()
    expect(probe).toHaveBeenCalledOnce()
    await manager.revoke()
  })

  it('revokes bound capabilities, future probes and already-returned backends', async () => {
    const close = vi.fn(async () => {})
    const probe = vi.fn<SandboxWorkspaceProbe>(async () => ({ close, confine: ({ argv }) => argv }))
    const manager = new SandboxReadinessManager(probe)
    const bound = manager.bind(key())
    const backend = await bound.capability.ready()
    bound.revoke()
    await expect(bound.capability.ready()).rejects.toMatchObject({ code: 'E_WORKSPACE_CLOSED' })
    expect(() => backend.confine({ argv: ['echo'], cwd: '/Work' })).toThrow('E_WORKSPACE_CLOSED')
    await manager.revoke()
    expect(close).toHaveBeenCalledOnce()
    await expect(manager.bind(key('/Other')).capability.ready()).rejects.toMatchObject({
      code: 'E_WORKSPACE_CLOSED',
    })
  })
})
