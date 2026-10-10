import type { GitWorktreeService, WorktreeEntry } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { gitWorktrees } from '../src/worktree.js'

const entry: WorktreeEntry = {
  root: '/work/proj',
  path: '/work/proj/.worktrees/agnes-1234abcd',
  branch: 'agnes/subagent-1234abcd',
  stage: 'attached',
}
function harness(service?: GitWorktreeService, inUse?: () => boolean) {
  const facts: Array<[string, unknown]> = []
  const saved = new Map<string, WorktreeEntry>()
  const bindings: unknown[] = []
  const ctx = fakeToolContext({
    cwd: entry.root,
    exec: () => {
      throw new Error('agent Git exec forbidden')
    },
  })
  const manager = gitWorktrees({
    ...(service ? { service } : {}),
    ...(inUse ? { inUse } : {}),
    events: {
      append: async (name, data) => {
        facts.push([name, data])
        return facts.length
      },
    },
    persist: {
      load: () => saved,
      save: (entries) => {
        for (const [path, value] of entries) saved.set(path, value)
      },
      bind: (childKey, value) => {
        bindings.push([childKey, value])
      },
    },
  })
  return { ctx, manager, facts, saved, bindings }
}
const service = (): GitWorktreeService => ({
  create: async () => ({ id: '1234abcd', root: entry.root, path: entry.path, branch: entry.branch }),
  list: async () => [entry],
  finish: async () => ({ action: 'removed' }),
})

describe('Host-backed gitWorktrees', () => {
  it('creates, binds, lists and removes through the public port with durable facts, without agent exec', async () => {
    const h = harness(service())
    await expect(h.manager.create(h.ctx)).resolves.toMatchObject({ path: entry.path })
    await h.manager.bind?.('child', entry.path)
    expect(h.bindings).toEqual([['child', entry]])
    await expect(h.manager.list?.(h.ctx)).resolves.toEqual([entry])
    await expect(h.manager.finish(h.ctx, 'child', entry.path)).resolves.toEqual({ action: 'removed' })
    expect(h.facts.map(([name]) => name)).toEqual([
      'worktree-created',
      'worktree-bound',
      'worktree-listed',
      'worktree-removed',
    ])
    expect(h.ctx.calls.exec).toEqual([])
  })
  it.each(['not-git', 'remote-sandbox', 'git-error'] as const)(
    'records %s and does not substitute agent exec',
    async (reason) => {
      const port = service()
      port.create = async () => ({ skipped: reason })
      const h = harness(port)
      await expect(h.manager.create(h.ctx)).resolves.toEqual({ skipped: reason })
      expect(h.facts).toEqual([['worktree-skipped', { reason }]])
      expect(h.ctx.calls.exec).toEqual([])
    },
  )
  it('records a Host lease refusal and partial removal with a retained branch', async () => {
    const port = service()
    port.create = async () => {
      throw new Error('closed workspace lease')
    }
    port.finish = async () => ({ action: 'kept-unmerged' })
    port.list = async () => {
      throw new Error('Git unavailable')
    }
    const h = harness(port)
    await expect(h.manager.create(h.ctx)).resolves.toEqual({ skipped: 'git-error' })
    await expect(h.manager.list?.(h.ctx)).rejects.toThrow('Git unavailable')
    await expect(h.manager.finish(h.ctx, 'child', entry.path)).resolves.toEqual({ action: 'kept-unmerged' })
    expect(h.facts).toEqual([
      ['worktree-skipped', { reason: 'git-error' }],
      ['worktree-skipped', { reason: 'git-error', operation: 'list' }],
      ['worktree-removed', { childKey: 'child', path: entry.path, branchRetained: true }],
      ['worktree-cleanup-skipped', { childKey: 'child', path: entry.path, action: 'kept-unmerged' }],
    ])
  })
  it('fails closed when Host did not supply the service', async () => {
    const h = harness()
    await expect(h.manager.create(h.ctx)).resolves.toEqual({ skipped: 'git-error' })
    await expect(h.manager.bind?.('child', entry.path)).rejects.toThrow('created entry')
    expect(h.ctx.calls.exec).toEqual([])
  })
  it('preserves live child worktrees and records the cleanup refusal', async () => {
    const port = service()
    port.finish = async () => {
      throw new Error('must not clean an active child')
    }
    const h = harness(port, () => true)
    await expect(h.manager.finish(h.ctx, 'child', entry.path)).resolves.toEqual({ action: 'kept-in-use' })
    expect(h.facts).toEqual([
      ['worktree-cleanup-skipped', { childKey: 'child', path: entry.path, action: 'kept-in-use' }],
    ])
  })
  it('binds a persisted entry after extension restart', async () => {
    const h = harness(service())
    h.saved.set(entry.path, entry)
    await h.manager.bind?.('child', entry.path)
    expect(h.bindings).toEqual([['child', entry]])
  })
})
