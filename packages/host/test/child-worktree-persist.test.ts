import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { childControlWorktreePersist } from '@agnes/base'
import { createSqliteStorage } from '@agnes/host-infrastructure/adapters/storage-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('subagent worktree binding', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agnes-wt-bind-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('binds a worktree through the real child-control store', async () => {
    const storage = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
    await storage.open('parent', { writerRunId: 'r1', ttlMs: 1000 })
    await storage.ensureRootScope('root', 10_000_000n)
    await storage.createDelegatedChild({
      childKey: 'parent/wt',
      parentKey: 'parent',
      boundarySeq: 1,
      creationId: 'c-wt',
      kind: 'spawn',
      rootTaskId: 'root',
      runtimeOwnerSessionKey: 'parent',
      generationDepth: 1,
      generationLimit: 2,
      maxFanOut: 4,
      inputHash: 'h',
      inputText: 'wt',
      cwd: '/work/proj',
      actorId: 'u',
      isolation: 'worktree',
      workspaceId: 'ws-wt',
      treeCapMicro: 10_000_000n,
      childCapMicro: null,
      writerRunId: 'w',
    })
    const persist = childControlWorktreePersist({
      lookupByKey: (key) => storage.lookupByKey(key),
      updateWorkspace: async (id, patch) => {
        await storage.updateWorkspace?.(id, patch)
      },
    })
    await persist.bind('parent/wt', {
      root: '/work/proj',
      path: '/work/proj/.worktrees/agnes-1',
      branch: 'agnes/subagent-1',
      stage: 'attached',
    })
    await storage.close()
    const raw = new DatabaseSync(join(dir, 'sessions.db'), { readOnly: true })
    try {
      expect(
        raw
          .prepare(`SELECT path, phase, root, branch FROM child_workspaces WHERE workspace_id = 'ws-wt'`)
          .get(),
      ).toEqual({
        path: '/work/proj/.worktrees/agnes-1',
        phase: 'attached',
        root: '/work/proj',
        branch: 'agnes/subagent-1',
      })
      expect(raw.prepare(`SELECT cwd FROM child_tasks WHERE child_key = 'parent/wt'`).get()).toEqual({
        cwd: '/work/proj/.worktrees/agnes-1',
      })
    } finally {
      raw.close()
    }
  })
})
