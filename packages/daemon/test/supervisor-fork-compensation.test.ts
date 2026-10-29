import { describe, expect, it, vi } from 'vitest'
import type { SessionEntry } from '../src/local/sessions.js'
import type { SessionWorkspacePort } from '../src/storage/lister.js'
import type { RemoteEntry, WorkerRegistry } from '../src/supervisor/registry.js'
import { activateForkOwnership, SupervisorRegistry } from '../src/supervisor/supervisor.js'

const child = {
  key: 'fork-child',
  generation: 7,
  session: { cwd: '/workspace' },
} as unknown as RemoteEntry

function workspacePort(fail: 'put' | 'refresh'): SessionWorkspacePort {
  return {
    put: vi.fn(() => {
      if (fail === 'put') throw new Error('workspace put failed')
    }),
    get: vi.fn(),
    keys: vi.fn(() => []),
    observe: vi.fn(),
    metadata: vi.fn(),
    refresh: vi.fn(async () => {
      if (fail === 'refresh') throw new Error('workspace refresh failed')
    }),
  }
}

describe('supervisor open identity', () => {
  it('carries permission to the worker and never merges opens that differ only in permission', async () => {
    let finish!: (entry: RemoteEntry) => void
    const opened = { key: 'k', generation: 1, session: { cwd: '/workspace' } } as unknown as RemoteEntry
    let live: RemoteEntry | undefined
    const inner = {
      get: vi.fn(() => live),
      open: vi.fn(
        () =>
          new Promise<RemoteEntry>((resolve) => {
            finish = resolve
          }),
      ),
    } as unknown as WorkerRegistry
    const ports = workspacePort('none' as never)
    const registry = new SupervisorRegistry(inner, ports)
    const request = { key: 'k', cwd: '/workspace', preset: 'standard' }

    const first = registry.open({ ...request, permission: 'full-access' })
    const retry = registry.open({ ...request, permission: 'full-access' })
    await expect(registry.open(request)).rejects.toMatchObject({ data: { code: 'ID_CONFLICT' } })
    await expect(registry.open({ ...request, permission: 'read-only' })).rejects.toMatchObject({
      data: { code: 'ID_CONFLICT' },
    })
    await vi.waitFor(() => expect(inner.open).toHaveBeenCalledTimes(1))
    expect(inner.open).toHaveBeenCalledWith(
      expect.objectContaining({ preset: 'standard', permission: 'full-access' }),
    )
    finish(opened)
    await Promise.all([first, retry])

    // A live worker conflicts only with a named level it does not run under.
    live = {
      ...opened,
      session: {
        cwd: '/workspace',
        currentPreset: async () => 'standard',
        status: async () => ({ lastSeq: 1, preset: 'standard', permission: 'workspace-write' }),
      },
    } as unknown as RemoteEntry
    vi.mocked(inner.open).mockResolvedValue(live)
    await expect(registry.open({ ...request, permission: 'full-access' })).rejects.toMatchObject({
      data: { code: 'ID_CONFLICT' },
    })
    expect(inner.open).toHaveBeenCalledTimes(1)
    for (const permission of ['workspace-write', 'default', undefined])
      await expect(
        registry.open({ ...request, ...(permission ? { permission } : {}) }),
      ).resolves.toBeDefined()
    expect(inner.open).toHaveBeenCalledTimes(4)
    expect(inner.open).toHaveBeenLastCalledWith(expect.objectContaining({ permission: 'default' }))
  })
})

describe('supervisor fork compensation', () => {
  it.each(['put', 'refresh'] as const)(
    'closes the worker child when workspace %s fails after fork',
    async (fail) => {
      const close = vi.fn(async () => undefined)
      const inner = {
        fork: vi.fn(async () => child),
        close,
      } as unknown as WorkerRegistry
      const registry = new SupervisorRegistry(inner, workspacePort(fail))

      await expect(registry.fork({ parent: 'parent', at: 9, childKey: child.key })).rejects.toThrow(
        `workspace ${fail} failed`,
      )

      expect(close).toHaveBeenCalledTimes(1)
      expect(close).toHaveBeenCalledWith(child.key)
    },
  )

  it('closes the child when ownership activation rejects the handoff', async () => {
    const close = vi.fn(async () => undefined)
    const entry = { key: child.key } as SessionEntry

    await expect(activateForkOwnership({ close }, entry, () => false)).rejects.toMatchObject({
      data: { method: 'session.fork', reason: 'session owner unavailable' },
    })

    expect(close).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledWith(child.key)
  })

  it('closes the child when ownership activation throws', async () => {
    const close = vi.fn(async () => undefined)
    const entry = { key: child.key } as SessionEntry

    await expect(
      activateForkOwnership({ close }, entry, (): boolean => {
        throw new Error('ownership storage failed')
      }),
    ).rejects.toThrow('ownership storage failed')

    expect(close).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledWith(child.key)
  })
})
