import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { gitWorktrees, type WorktreeEntry } from '../src/worktree.js'

describe('gitWorktrees against a real repository', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  it('keeps a dirty worktree and removes a clean merged one', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-wt-')))
    dirs.push(root)
    execFileSync('git', ['init', '-b', 'main'], { cwd: root })
    execFileSync('git', ['config', 'user.email', 'wt@example.test'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'wt'], { cwd: root })
    writeFileSync(join(root, 'README.md'), 'root\n')
    writeFileSync(join(root, '.gitignore'), '.worktrees\n')
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root })

    const ctx = fakeToolContext({
      cwd: root,
      files: { 'README.md': 'root\n', '.gitignore': '.worktrees\n' },
      exec: (cmd, opts) => {
        const cwd = opts.cwd ?? root
        try {
          const out = execFileSync(cmd[0] as string, cmd.slice(1), {
            cwd,
            encoding: 'utf8',
          })
          return { code: 0, stdout: typeof out === 'string' ? out : '', stderr: '', truncated: false }
        } catch (error) {
          const err = error as { status?: number; stdout?: string; stderr?: string }
          return {
            code: err.status ?? 1,
            stdout: err.stdout ?? '',
            stderr: err.stderr ?? String(error),
            truncated: false,
          }
        }
      },
    })
    ctx.fs.stat = async (path) => {
      const st = statSync(path)
      return { kind: st.isDirectory() ? 'dir' : 'file', size: st.size, mtimeMs: st.mtimeMs }
    }
    const worktrees = gitWorktrees({
      events: {
        async append() {
          return 1
        },
      },
      id: () => 'abcd1234',
    })

    const created = await worktrees.create(ctx)
    expect(created).toMatchObject({ path: join(root, '.worktrees', 'agnes-abcd1234') })
    if (!('path' in created)) throw new Error('expected worktree path')
    writeFileSync(join(created.path, 'dirty.txt'), 'keep me\n')
    await expect(worktrees.finish(ctx, 'child-dirty', created.path)).resolves.toEqual({
      action: 'kept-dirty',
    })
  })

  it('finishes from a persisted entry after the creating manager is gone', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-wt-')))
    dirs.push(root)
    execFileSync('git', ['init', '-b', 'main'], { cwd: root })
    execFileSync('git', ['config', 'user.email', 'wt@example.test'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'wt'], { cwd: root })
    writeFileSync(join(root, 'README.md'), 'root\n')
    writeFileSync(join(root, '.gitignore'), '.worktrees\n')
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root })
    const saved = new Map<string, WorktreeEntry>()
    const persist = {
      load: () => new Map(saved),
      save: (entries: Map<string, WorktreeEntry>) => {
        saved.clear()
        for (const [key, value] of entries) saved.set(key, { ...value })
      },
    }
    const ctx = fakeToolContext({
      cwd: root,
      files: { 'README.md': 'root\n', '.gitignore': '.worktrees\n' },
      exec: (cmd, opts) => {
        try {
          const out = execFileSync(cmd[0] as string, cmd.slice(1), {
            cwd: opts.cwd ?? root,
            encoding: 'utf8',
          })
          return { code: 0, stdout: typeof out === 'string' ? out : '', stderr: '', truncated: false }
        } catch (error) {
          const err = error as { status?: number; stdout?: string; stderr?: string }
          return {
            code: err.status ?? 1,
            stdout: err.stdout ?? '',
            stderr: err.stderr ?? String(error),
            truncated: false,
          }
        }
      },
    })
    ctx.fs.stat = async (path) => {
      const st = statSync(path)
      return { kind: st.isDirectory() ? 'dir' : 'file', size: st.size, mtimeMs: st.mtimeMs }
    }
    const first = gitWorktrees({
      events: {
        async append() {
          return 1
        },
      },
      id: () => 'abcd1234',
      persist,
    })
    const created = await first.create(ctx)
    expect('path' in created).toBe(true)
    if (!('path' in created)) return
    const second = gitWorktrees({
      events: {
        async append() {
          return 1
        },
      },
      id: () => 'ffff0000',
      persist,
    })
    writeFileSync(join(created.path, 'dirty.txt'), 'keep\n')
    await expect(second.finish(ctx, 'child', created.path)).resolves.toEqual({ action: 'kept-dirty' })
  })

  it('does not remove a worktree still used by another child', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-wt-')))
    dirs.push(root)
    execFileSync('git', ['init', '-b', 'main'], { cwd: root })
    execFileSync('git', ['config', 'user.email', 'wt@example.test'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'wt'], { cwd: root })
    writeFileSync(join(root, 'README.md'), 'root\n')
    writeFileSync(join(root, '.gitignore'), '.worktrees\n')
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root })
    const ctx = fakeToolContext({
      cwd: root,
      files: { 'README.md': 'root\n', '.gitignore': '.worktrees\n' },
      exec: (cmd, opts) => {
        try {
          const out = execFileSync(cmd[0] as string, cmd.slice(1), {
            cwd: opts.cwd ?? root,
            encoding: 'utf8',
          })
          return { code: 0, stdout: typeof out === 'string' ? out : '', stderr: '', truncated: false }
        } catch (error) {
          const err = error as { status?: number; stdout?: string; stderr?: string }
          return {
            code: err.status ?? 1,
            stdout: err.stdout ?? '',
            stderr: err.stderr ?? String(error),
            truncated: false,
          }
        }
      },
    })
    ctx.fs.stat = async (path) => {
      const st = statSync(path)
      return { kind: st.isDirectory() ? 'dir' : 'file', size: st.size, mtimeMs: st.mtimeMs }
    }
    const worktrees = gitWorktrees({
      events: {
        async append() {
          return 1
        },
      },
      id: () => 'abcd1234',
      inUse: () => true,
    })
    const created = await worktrees.create(ctx)
    expect('path' in created).toBe(true)
    if (!('path' in created)) return
    await expect(worktrees.finish(ctx, 'child', created.path)).resolves.toEqual({ action: 'kept-in-use' })
  })

  it('keeps an unmerged branch after removing the tree and retries only branch delete', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-wt-')))
    dirs.push(root)
    execFileSync('git', ['init', '-b', 'main'], { cwd: root })
    execFileSync('git', ['config', 'user.email', 'wt@example.test'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'wt'], { cwd: root })
    writeFileSync(join(root, 'README.md'), 'root\n')
    writeFileSync(join(root, '.gitignore'), '.worktrees\n')
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root })
    const ctx = fakeToolContext({
      cwd: root,
      files: { 'README.md': 'root\n', '.gitignore': '.worktrees\n' },
      exec: (cmd, opts) => {
        try {
          const out = execFileSync(cmd[0] as string, cmd.slice(1), {
            cwd: opts.cwd ?? root,
            encoding: 'utf8',
          })
          return { code: 0, stdout: typeof out === 'string' ? out : '', stderr: '', truncated: false }
        } catch (error) {
          const err = error as { status?: number; stdout?: string; stderr?: string }
          return {
            code: err.status ?? 1,
            stdout: err.stdout ?? '',
            stderr: err.stderr ?? String(error),
            truncated: false,
          }
        }
      },
    })
    ctx.fs.stat = async (path) => {
      const st = statSync(path)
      return { kind: st.isDirectory() ? 'dir' : 'file', size: st.size, mtimeMs: st.mtimeMs }
    }
    const worktrees = gitWorktrees({
      events: {
        async append() {
          return 1
        },
      },
      id: () => 'abcd1234',
    })
    const created = await worktrees.create(ctx)
    expect('path' in created && 'branch' in created).toBe(true)
    if (!('path' in created) || !('branch' in created)) return
    writeFileSync(join(created.path, 'feat.txt'), 'unmerged\n')
    execFileSync('git', ['add', '.'], { cwd: created.path })
    execFileSync('git', ['commit', '-m', 'feat'], { cwd: created.path })
    await expect(worktrees.finish(ctx, 'child', created.path)).resolves.toEqual({ action: 'kept-unmerged' })
    await expect(worktrees.finish(ctx, 'child', created.path)).resolves.toEqual({ action: 'kept-unmerged' })
    execFileSync('git', ['merge', '--no-ff', '-m', 'merge child', created.branch], { cwd: root })
    await expect(worktrees.finish(ctx, 'child', created.path)).resolves.toEqual({ action: 'removed' })
  })
})
