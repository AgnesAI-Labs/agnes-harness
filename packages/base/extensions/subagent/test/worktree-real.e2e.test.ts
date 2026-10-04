import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { sqliteWorktreePersist } from '../../../src/worktree-persist.js'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { gitWorktrees } from '../src/worktree.js'

it('creates and removes real Git worktrees in a Unicode path while preserving dirty work', async () => {
  // Native real paths: Git prints the repository root with 8.3 short names expanded on Windows,
  // and the host hands tools a workspace cwd in that same spelling.
  const temporaryParent = realpathSync.native(tmpdir())
  const temporary = realpathSync.native(mkdtempSync(join(temporaryParent, 'agnes-worktree-中文 ')))
  if (dirname(temporary) !== temporaryParent) throw new Error('unexpected fixture cleanup path')
  const repository = join(temporary, 'repository')
  const source = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: dirname(fileURLToPath(import.meta.url)),
    encoding: 'utf8',
  }).trim()
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: repository, encoding: 'utf8', windowsHide: true, timeout: 30000 })
  try {
    execFileSync('git', ['clone', '--shared', '--no-checkout', '--', source, repository], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      stdio: 'pipe',
    })
    git(['config', 'core.autocrlf', 'false'])
    writeFileSync(join(repository, '.git', 'info', 'exclude'), '.worktrees/\n')
    const before = git(['rev-parse', 'HEAD'])
    const ctx = fakeToolContext({
      cwd: repository,
      exec: (command, options) => {
        const result = spawnSync(command[0] as string, command.slice(1), {
          cwd: options.cwd,
          encoding: 'utf8',
          windowsHide: true,
          timeout: options.timeoutMs,
        })
        if (result.error) throw result.error
        return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }
      },
    })
    ctx.fs.stat = async (path) => {
      const child = relative(repository, resolve(path))
      if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`))
        throw new Error('outside fixture')
      const stat = statSync(path)
      return { kind: stat.isDirectory() ? 'dir' : 'file', size: stat.size, mtimeMs: stat.mtimeMs }
    }
    const db = new DatabaseSync(join(temporary, 'sessions.db'))
    db.exec(`CREATE TABLE child_tasks(child_key TEXT PRIMARY KEY,cwd TEXT);
      CREATE TABLE child_workspaces(workspace_id TEXT,child_key TEXT PRIMARY KEY,isolation TEXT,path TEXT,root TEXT,branch TEXT,phase TEXT);
      INSERT INTO child_tasks VALUES('child',NULL);
      INSERT INTO child_workspaces VALUES('workspace','child','worktree',NULL,NULL,NULL,'planned')`)
    const phase = () => db.prepare('SELECT phase FROM child_workspaces WHERE child_key=?').get('child')?.phase
    const persist = sqliteWorktreePersist(temporary)
    let loseWorktreeReceipt = true
    const manager = gitWorktrees({
      events: { append: async () => 1 },
      id: () => '1234abcd',
      persist: {
        ...persist,
        save: (entries) => {
          if (loseWorktreeReceipt && [...entries.values()].some((e) => e.stage === 'worktree-removed')) {
            loseWorktreeReceipt = false
            throw new Error('simulated worktree receipt loss')
          }
          persist.save(entries)
        },
      },
    })
    const created = await manager.create(ctx)
    expect(created).toHaveProperty('path')
    if ('skipped' in created) throw new Error(`real Git creation failed: ${created.skipped}`)
    await manager.bind?.('child', created.path)
    expect(phase()).toBe('attached')
    const stale = persist.load()
    expect(realpathSync(created.path)).toBe(created.path)
    expect(git(['-C', created.path, 'rev-parse', 'HEAD'])).toBe(before)
    const marker = join(created.path, 'uncommitted-fixture.txt')
    writeFileSync(marker, 'must survive cleanup\n')
    await expect(manager.finish(ctx, 'child', created.path)).resolves.toEqual({ action: 'kept-dirty' })
    expect(readFileSync(marker, 'utf8')).toBe('must survive cleanup\n')
    rmSync(marker)
    git(['-C', created.path, 'config', 'user.name', 'Fixture'])
    git(['-C', created.path, 'config', 'user.email', 'fixture@example.test'])
    writeFileSync(join(created.path, 'child-result.txt'), 'keep unmerged result\n')
    git(['-C', created.path, 'add', 'child-result.txt'])
    git(['-C', created.path, 'commit', '-m', 'child result'])
    await expect(manager.finish(ctx, 'other-child', created.path)).resolves.toEqual({
      action: 'kept-inspection-failed',
    })
    expect(existsSync(created.path)).toBe(true)
    await expect(manager.finish(ctx, 'child', created.path)).rejects.toThrow(
      'simulated worktree receipt loss',
    )
    expect(phase()).toBe('attached')
    expect(existsSync(created.path)).toBe(false)
    const resumeRemoval = gitWorktrees({
      events: { append: async () => 1 },
      persist: sqliteWorktreePersist(temporary),
    })
    await expect(resumeRemoval.finish(ctx, 'child', created.path)).resolves.toEqual({
      action: 'kept-unmerged',
    })
    expect(phase()).toBe('worktree_removed')
    expect(existsSync(created.path)).toBe(false)
    expect(git(['branch', '--list', created.branch]).trim()).toBe(created.branch)
    const wrongOwner = {
      ...stale.get(created.path)!,
      workspaceId: 'another-workspace',
      stage: 'worktree-removed' as const,
    }
    expect(() => persist.save(new Map([[created.path, wrongOwner]]))).toThrow('ownership')
    expect(() => persist.removed?.(wrongOwner)).toThrow('ownership')
    expect(phase()).toBe('worktree_removed')
    persist.save(stale)
    expect(phase()).toBe('worktree_removed')
    const restarted = gitWorktrees({
      events: { append: async () => 1 },
      persist: {
        ...sqliteWorktreePersist(temporary),
        removed: () => {
          throw new Error('simulated receipt loss')
        },
      },
    })
    // The branch becomes safe to remove only after its result is incorporated in the parent.
    // This clone has no checkout, so update HEAD to the descendant commit without touching files.
    const childHead = git(['rev-parse', created.branch]).trim()
    git(['update-ref', 'HEAD', childHead, before.trim()])
    await expect(restarted.finish(ctx, 'child', created.path)).rejects.toThrow('simulated receipt loss')
    expect(phase()).toBe('worktree_removed')
    expect(git(['branch', '--list', created.branch]).trim()).toBe('')
    const recovered = gitWorktrees({
      events: { append: async () => 1 },
      persist: sqliteWorktreePersist(temporary),
    })
    await expect(recovered.finish(ctx, 'child', created.path)).resolves.toEqual({ action: 'removed' })
    expect(phase()).toBe('branch_removed')
    expect(sqliteWorktreePersist(temporary).load().size).toBe(0)
    persist.save(stale)
    expect(phase()).toBe('branch_removed')
    expect(() => persist.bind?.('child', stale.get(created.path)!)).toThrow('retired')
    expect(phase()).toBe('branch_removed')
    db.close()
    expect(existsSync(created.path)).toBe(false)
    expect(git(['branch', '--list', created.branch]).trim()).toBe('')
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(childHead)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}, 60000)
