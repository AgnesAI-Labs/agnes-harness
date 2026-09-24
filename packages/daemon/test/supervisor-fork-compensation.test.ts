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
