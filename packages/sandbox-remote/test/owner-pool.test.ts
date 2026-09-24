import { createHash } from 'node:crypto'
import type { RemoteTransport } from '@agnes/core'
import { describe, expect, it, vi } from 'vitest'
import { RemoteWorkspacePool, remoteWorkspaceOwnerToken } from '../src/owner-pool.js'

const result = { code: 0, stdout: '', stderr: '', truncated: false }
type ExecResult = Awaited<ReturnType<RemoteTransport['exec']>>

function transport() {
  let alive = true
  return {
    alive: () => alive,
    close: vi.fn(async () => {
      alive = false
    }),
    exec: vi.fn<RemoteTransport['exec']>(async () => result),
    upload: vi.fn<RemoteTransport['upload']>(async () => {}),
    download: vi.fn<RemoteTransport['download']>(async () => []),
  }
}

const pool = (t: ReturnType<typeof transport>, over: Record<string, unknown> = {}) =>
  new RemoteWorkspacePool({
    transport: t,
    rootTemplate: '/owners/{session}',
    keepOnClose: false,
    providerTtlMs: 60_000,
    cleanupBackoffMs: 0,
    wait: async () => {},
    ...over,
  })

describe('RemoteWorkspacePool', () => {
  it('uses the full SHA-256 owner token without exposing the session key', () => {
    const owner = 'agnes:tenant:account:surface:conversation'
    const token = remoteWorkspaceOwnerToken(owner)
    expect(token).toBe(createHash('sha256').update(owner).digest('hex'))
    expect(token).toHaveLength(64)
    expect(token).not.toContain('tenant')
  })

  it('singleflights an owner, lets children share its ref, and cleans only after the final release', async () => {
    const t = transport()
    let release: (value: ExecResult | PromiseLike<ExecResult>) => void = () => {}
    t.exec.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }) as ReturnType<RemoteTransport['exec']>,
    )
    const p = pool(t)
    const first = p.acquire('owner-a')
    const child = p.acquire('owner-a')
    expect(t.exec).toHaveBeenCalledOnce()
    release(result)
    const [a, b] = await Promise.all([first, child])
    expect(a.root).toBe(b.root)
    expect(p.status('owner-a')).toMatchObject({ state: 'active', refs: 2 })
    await a.close()
    expect(t.exec).toHaveBeenCalledTimes(1)
    await b.close()
    expect(t.exec.mock.calls.map(([argv]) => argv[0])).toEqual(['mkdir', 'rm'])
    expect(p.status('owner-a')).toMatchObject({ state: 'cleaned', refs: 0 })
    await p.close()
  })

  it('isolates different sessions and deterministically restores the same owner path', async () => {
    const t = transport()
    const p = pool(t)
    const a = await p.acquire('owner-a')
    const b = await p.acquire('owner-b')
    expect(a.root).not.toBe(b.root)
    const original = a.root
    await a.close()
    const restored = await p.acquire('owner-a')
    expect(restored.root).toBe(original)
    await Promise.all([b.close(), restored.close()])
    await p.close()
  })

  it('keeps cleanup-pending metadata and makes reopen wait for that exact cleanup', async () => {
    const t = transport()
    const p = pool(t)
    const first = await p.acquire('owner-a')
    let releaseRm: (value: ExecResult | PromiseLike<ExecResult>) => void = () => {}
    t.exec.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRm = resolve
        }) as ReturnType<RemoteTransport['exec']>,
    )
    const closing = first.close()
    expect(p.status('owner-a')).toMatchObject({ state: 'cleanup-pending', refs: 0 })
    const reopening = p.acquire('owner-a')
    await Promise.resolve()
    expect(t.exec.mock.calls.map(([argv]) => argv[0])).toEqual(['mkdir', 'rm'])
    releaseRm(result)
    await closing
    const second = await reopening
    expect(t.exec.mock.calls.map(([argv]) => argv[0])).toEqual(['mkdir', 'rm', 'mkdir'])
    await second.close()
    await p.close()
  })

  it('does not reopen an owner until failed-open cleanup finishes', async () => {
    const t = transport()
    let releaseRm: (value: ExecResult | PromiseLike<ExecResult>) => void = () => {}
    t.exec
      .mockRejectedValueOnce(new Error('mkdir settlement failed'))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseRm = resolve
          }) as ReturnType<RemoteTransport['exec']>,
      )
      .mockResolvedValue(result)
    const p = pool(t)

    const failed = p.acquire('owner-a')
    await vi.waitFor(() => {
      expect(p.status('owner-a')).toMatchObject({ state: 'cleanup-pending', refs: 0 })
    })
    const reopening = p.acquire('owner-a')
    await Promise.resolve()
    expect(t.exec.mock.calls.map(([argv]) => argv[0])).toEqual(['mkdir', 'rm'])

    releaseRm(result)
    await expect(failed).rejects.toMatchObject({ code: 'E_REMOTE_WORKSPACE' })
    const lease = await reopening
    expect(t.exec.mock.calls.map(([argv]) => argv[0])).toEqual(['mkdir', 'rm', 'mkdir'])
    await lease.close()
    await p.close()
  })

  it('consumes the final ref, retries bounded cleanup, and never revives the old lease', async () => {
    const t = transport()
    const p = pool(t, { cleanupAttempts: 3 })
    const lease = await p.acquire('owner-a')
    t.exec
      .mockRejectedValueOnce(new Error('rm one'))
      .mockRejectedValueOnce(new Error('rm two'))
      .mockResolvedValueOnce(result)
    await lease.close()
    expect(p.status('owner-a')).toMatchObject({ state: 'cleaned', refs: 0, cleanupAttempts: 3 })
    await lease.close()
    expect(t.exec.mock.calls.filter(([argv]) => argv[0] === 'rm')).toHaveLength(3)
    await p.close()
  })

  it('refuses an abandoned owner until the provider TTL or explicit acknowledgement', async () => {
    const t = transport()
    let now = 100
    const p = pool(t, { cleanupAttempts: 2, providerTtlMs: 50, now: () => now })
    const lease = await p.acquire('owner-a')
    t.exec.mockRejectedValueOnce(new Error('rm one')).mockRejectedValueOnce(new Error('rm two'))
    await expect(lease.close()).rejects.toMatchObject({ code: 'E_REMOTE_WORKSPACE' })
    expect(p.status('owner-a')).toMatchObject({ state: 'abandoned', providerTtlExpiresAt: 150 })
    await expect(p.acquire('owner-a')).rejects.toMatchObject({ code: 'E_REMOTE_WORKSPACE' })
    now = 150
    t.exec.mockResolvedValue(result)
    const afterTtl = await p.acquire('owner-a')
    await afterTtl.close()

    const manual = await p.acquire('owner-b')
    t.exec.mockRejectedValueOnce(new Error('rm one')).mockRejectedValueOnce(new Error('rm two'))
    await expect(manual.close()).rejects.toMatchObject({ code: 'E_REMOTE_WORKSPACE' })
    expect(p.acknowledgeProviderCleanup('owner-b')).toBe(true)
    t.exec.mockResolvedValue(result)
    const afterManual = await p.acquire('owner-b')
    await afterManual.close()
    await p.close()
  })

  it('honors keepOnClose and closes the process-wide transport after owners', async () => {
    const t = transport()
    const p = pool(t, { keepOnClose: true })
    const lease = await p.acquire('owner-a')
    await lease.close()
    expect(t.exec.mock.calls.map(([argv]) => argv[0])).toEqual(['mkdir'])
    await p.close()
    expect(t.close).toHaveBeenCalledOnce()
  })

  it('keeps active lease refs intact when pool close fails and never underflows on release', async () => {
    const t = transport()
    const p = pool(t)
    const lease = await p.acquire('owner-a')

    await expect(p.close()).rejects.toThrow('remote workspace pool close failed')
    expect(p.status('owner-a')).toMatchObject({ state: 'active', refs: 1 })
    await lease.close()
    await lease.close()
    expect(p.status('owner-a')).toMatchObject({ state: 'cleaned', refs: 0 })
  })
})
