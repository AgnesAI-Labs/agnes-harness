import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteStorage } from '../src/adapters/storage-sqlite.js'
import { listChildCandidates, repairChildCandidates, sessionsDbPath } from '../src/child-maintenance.js'

describe('child maintenance', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agnes-maint-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('lists candidates without opening a session and skips dirty keep phases on repair', async () => {
    const dbPath = sessionsDbPath(dir)
    const storage = createSqliteStorage({ file: dbPath, tablesDir: join(dir, 'tables') })
    await storage.open('parent', { writerRunId: 'r1', ttlMs: 1000 })
    await storage.ensureRootScope('root', 10_000_000n)
    await storage.createDelegatedChild({
      childKey: 'parent/safe',
      parentKey: 'parent',
      boundarySeq: 1,
      creationId: 'c1',
      kind: 'spawn',
      rootTaskId: 'root',
      runtimeOwnerSessionKey: 'parent',
      generationDepth: 1,
      generationLimit: 2,
      maxFanOut: 4,
      inputHash: 'h',
      inputText: 'safe',
      cwd: '/tmp/safe',
      actorId: 'u',
      isolation: 'shared',
      workspaceId: 'ws-safe',
      treeCapMicro: 10_000_000n,
      childCapMicro: null,
      writerRunId: 'w',
    })
    await storage.createDelegatedChild({
      childKey: 'parent/dirty',
      parentKey: 'parent',
      boundarySeq: 1,
      creationId: 'c2',
      kind: 'spawn',
      rootTaskId: 'root',
      runtimeOwnerSessionKey: 'parent',
      generationDepth: 1,
      generationLimit: 2,
      maxFanOut: 4,
      inputHash: 'h2',
      inputText: 'dirty',
      cwd: '/tmp/dirty',
      actorId: 'u',
      isolation: 'worktree',
      workspaceId: 'ws-dirty',
      treeCapMicro: 10_000_000n,
      childCapMicro: null,
      writerRunId: 'w',
    })
    await storage.casState('parent/safe', 1, 'completed')
    await storage.casState('parent/dirty', 1, 'completed')
    const db = (await import('node:sqlite')).DatabaseSync
    const raw = new db(dbPath)
    raw.prepare(`UPDATE child_workspaces SET phase = 'kept_dirty' WHERE workspace_id = 'ws-dirty'`).run()
    raw.close()
    await storage.close()

    const listed = listChildCandidates(dbPath)
    expect(listed.map((c) => c.childKey).sort()).toEqual(['parent/dirty', 'parent/safe'])
    expect(listed.find((c) => c.childKey === 'parent/dirty')?.keepReason).toBe('kept_dirty')

    const repaired = repairChildCandidates(dbPath)
    expect(repaired).toEqual([
      { childKey: '_v1', action: 'skipped', reason: 'automatic repair is disabled in this release' },
    ])
  })

  it('skips a second tick while the sweep lease is live and resumes after it expires', async () => {
    const dbPath = sessionsDbPath(dir)
    const storage = createSqliteStorage({ file: dbPath, tablesDir: join(dir, 'tables') })
    await storage.open('parent', { writerRunId: 'r1', ttlMs: 1000 })
    await storage.ensureRootScope('root', 10_000_000n)
    await storage.createDelegatedChild({
      childKey: 'parent/safe',
      parentKey: 'parent',
      boundarySeq: 1,
      creationId: 'c-lease',
      kind: 'spawn',
      rootTaskId: 'root',
      runtimeOwnerSessionKey: 'parent',
      generationDepth: 1,
      generationLimit: 2,
      maxFanOut: 4,
      inputHash: 'h',
      inputText: 'safe',
      cwd: '/tmp/safe',
      actorId: 'u',
      isolation: 'shared',
      workspaceId: 'ws-lease',
      treeCapMicro: 10_000_000n,
      childCapMicro: null,
      writerRunId: 'w',
    })
    await storage.casState('parent/safe', 1, 'completed')
    await storage.close()

    expect(repairChildCandidates(dbPath, 50, 1_000)).toEqual([
      { childKey: '_v1', action: 'skipped', reason: 'automatic repair is disabled in this release' },
    ])
  })

  it('removes a clean leftover worktree and keeps a dirty one on disk', async () => {
    const { execFileSync } = await import('node:child_process')
    const { mkdirSync, realpathSync, writeFileSync, existsSync } = await import('node:fs')
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-maint-git-')))
    dir = root
    execFileSync('git', ['init', '-b', 'main'], { cwd: root })
    execFileSync('git', ['config', 'user.email', 'm@example.test'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'm'], { cwd: root })
    writeFileSync(join(root, 'README.md'), 'root\n')
    writeFileSync(join(root, '.gitignore'), '.worktrees\n')
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root })
    mkdirSync(join(root, '.worktrees'))
    const cleanPath = join(root, '.worktrees', 'agnes-clean00')
    const dirtyPath = join(root, '.worktrees', 'agnes-dirty00')
    execFileSync('git', ['worktree', 'add', '-b', 'agnes/subagent-clean00', cleanPath], { cwd: root })
    execFileSync('git', ['worktree', 'add', '-b', 'agnes/subagent-dirty00', dirtyPath], { cwd: root })
    writeFileSync(join(dirtyPath, 'keep.txt'), 'dirty\n')

    const dbPath = sessionsDbPath(root)
    const storage = createSqliteStorage({ file: dbPath, tablesDir: join(root, 'tables') })
    await storage.open('parent', { writerRunId: 'r1', ttlMs: 1000 })
    await storage.ensureRootScope('root', 10_000_000n)
    for (const [key, path, branch, ws] of [
      ['parent/clean', cleanPath, 'agnes/subagent-clean00', 'ws-clean'],
      ['parent/dirty', dirtyPath, 'agnes/subagent-dirty00', 'ws-dirty2'],
    ] as const) {
      await storage.createDelegatedChild({
        childKey: key,
        parentKey: 'parent',
        boundarySeq: 1,
        creationId: key,
        kind: 'spawn',
        rootTaskId: 'root',
        runtimeOwnerSessionKey: 'parent',
        generationDepth: 1,
        generationLimit: 2,
        maxFanOut: 4,
        inputHash: key,
        inputText: key,
        cwd: path,
        actorId: 'u',
        isolation: 'worktree',
        workspaceId: ws,
        treeCapMicro: 10_000_000n,
        childCapMicro: null,
        writerRunId: 'w',
      })
      await storage.casState(key, 1, 'completed')
      await storage.updateWorkspace?.(ws, { phase: 'attached', path, root, branch })
    }
    await storage.close()

    const repaired = repairChildCandidates(dbPath)
    expect(repaired[0]).toMatchObject({ action: 'skipped', reason: /disabled/ })
    expect(existsSync(cleanPath)).toBe(true)
    expect(existsSync(join(dirtyPath, 'keep.txt'))).toBe(true)
  })

  it('does not delete an unmerged worktree still used by a running descendant', async () => {
    const { execFileSync } = await import('node:child_process')
    const { mkdirSync, realpathSync, writeFileSync, existsSync } = await import('node:fs')
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-maint-shared-')))
    dir = root
    execFileSync('git', ['init', '-b', 'main'], { cwd: root })
    execFileSync('git', ['config', 'user.email', 'm@example.test'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'm'], { cwd: root })
    writeFileSync(join(root, 'README.md'), 'root\n')
    writeFileSync(join(root, '.gitignore'), '.worktrees\n')
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root })
    mkdirSync(join(root, '.worktrees'))
    const shared = join(root, '.worktrees', 'agnes-shared00')
    execFileSync('git', ['worktree', 'add', '-b', 'agnes/subagent-shared00', shared], { cwd: root })
    writeFileSync(join(shared, 'extra.txt'), 'commit me\n')
    execFileSync('git', ['add', '.'], { cwd: shared })
    execFileSync('git', ['commit', '-m', 'unmerged'], { cwd: shared })

    const dbPath = sessionsDbPath(root)
    const storage = createSqliteStorage({ file: dbPath, tablesDir: join(root, 'tables') })
    await storage.open('parent', { writerRunId: 'r1', ttlMs: 1000 })
    await storage.ensureRootScope('root', 10_000_000n)
    await storage.createDelegatedChild({
      childKey: 'parent/done',
      parentKey: 'parent',
      boundarySeq: 1,
      creationId: 'done',
      kind: 'spawn',
      rootTaskId: 'root',
      runtimeOwnerSessionKey: 'parent',
      generationDepth: 1,
      generationLimit: 2,
      maxFanOut: 4,
      inputHash: 'done',
      inputText: 'done',
      cwd: shared,
      actorId: 'u',
      isolation: 'worktree',
      workspaceId: 'ws-done',
      treeCapMicro: 10_000_000n,
      childCapMicro: null,
      writerRunId: 'w',
    })
    await storage.casState('parent/done', 1, 'completed')
    await storage.updateWorkspace?.('ws-done', {
      phase: 'attached',
      path: shared,
      root,
      branch: 'agnes/subagent-shared00',
    })
    await storage.createDelegatedChild({
      childKey: 'parent/live',
      parentKey: 'parent',
      boundarySeq: 1,
      creationId: 'live',
      kind: 'spawn',
      rootTaskId: 'root',
      runtimeOwnerSessionKey: 'parent',
      generationDepth: 2,
      generationLimit: 2,
      maxFanOut: 4,
      inputHash: 'live',
      inputText: 'live',
      cwd: shared,
      actorId: 'u',
      isolation: 'worktree',
      workspaceId: 'ws-live',
      treeCapMicro: 10_000_000n,
      childCapMicro: null,
      writerRunId: 'w',
    })
    await storage.updateWorkspace?.('ws-live', {
      phase: 'attached',
      path: shared,
      root,
      branch: 'agnes/subagent-shared00',
    })
    await storage.close()

    const repaired = repairChildCandidates(dbPath)
    expect(repaired[0]?.action).toBe('skipped')
    expect(existsSync(join(shared, 'extra.txt'))).toBe(true)
  })
})
