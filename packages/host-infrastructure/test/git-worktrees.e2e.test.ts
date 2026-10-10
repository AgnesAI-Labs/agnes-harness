import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceInvocationView } from '@agnes/core'
import type { WorktreeCreateResult } from '@agnes/git-worktree-contract'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createGitWorktreeService,
  createSessionGitWorktreeService,
  type GitWorktreeOperation,
} from '../src/git-worktrees.js'

const op: GitWorktreeOperation = {
  sessionKey: 'fixture',
  signal: new AbortController().signal,
  timeoutMs: 30_000,
}
const directories: string[] = []
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function fixture(repo = true, ignored = true) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-worktree-中文 ')))
  directories.push(directory)
  const root = join(directory, 'repository')
  const dataDir = join(directory, 'data')
  mkdirSync(root)
  const git = (args: string[], cwd = root) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 30_000 })
  if (repo) {
    git(['init', '-b', 'main'])
    git(['config', 'user.email', 'fixture@example.test'])
    git(['config', 'user.name', 'fixture'])
    writeFileSync(join(root, 'README.md'), 'root\n')
    writeFileSync(join(root, '.gitignore'), ignored ? '.worktrees/\n' : '')
    git(['add', '.'])
    git(['commit', '-m', 'init'])
  }
  const open = (remote = false) => createGitWorktreeService({ workspaceRoot: root, dataDir, remote })
  return { directory, root, dataDir, git, open, service: open() }
}
function created(result: WorktreeCreateResult) {
  if ('skipped' in result) throw new Error(`creation skipped: ${result.skipped}`)
  return result
}

describe('Host Git worktree service', () => {
  it('creates, lists, and removes only its own clean worktree in a Unicode path', async () => {
    const h = fixture()
    const before = h.git(['rev-parse', 'HEAD'])
    const child = created(await h.service.create(h.root, op))
    expect(child.path).toMatch(/\.worktrees[/\\]agnes-[0-9a-f]{8}$/)
    expect(h.git(['rev-parse', 'HEAD'], child.path)).toBe(before)
    expect(await h.service.list(op)).toEqual([
      { root: h.root, path: child.path, branch: child.branch, stage: 'attached' },
    ])
    await expect(h.service.finish(child.path, op)).resolves.toEqual({ action: 'removed' })
    expect(existsSync(child.path)).toBe(false)
    expect(h.git(['branch', '--list', child.branch]).trim()).toBe('')
    expect(h.git(['rev-parse', 'HEAD'])).toBe(before)
    expect(await h.service.list(op)).toEqual([])
  })
  it('retains locked worktrees and retries cleanup without deleting foreign registrations', async () => {
    const h = fixture()
    const child = created(await h.service.create(h.root, op))
    h.git(['worktree', 'lock', child.path])
    await expect(h.service.finish(child.path, op)).resolves.toEqual({
      action: 'cleanup-failed',
      stage: 'worktree-remove',
    })
    expect(existsSync(child.path)).toBe(true)
    h.git(['worktree', 'unlock', child.path])
    await expect(h.open().finish(child.path, op)).resolves.toEqual({ action: 'removed' })
  })
  it('retains dirty work across restart and cleans after the change is removed', async () => {
    const h = fixture()
    const child = created(await h.service.create(h.root, op))
    const marker = join(child.path, 'dirty.txt')
    writeFileSync(marker, 'keep me\n')
    const restarted = h.open()
    await expect(restarted.finish(child.path, op)).resolves.toEqual({ action: 'kept-dirty' })
    expect(readFileSync(marker, 'utf8')).toBe('keep me\n')
    rmSync(marker)
    await expect(restarted.finish(child.path, op)).resolves.toEqual({ action: 'removed' })
  })
  it('persists the removal stage and retains unmerged child commits until parent review', async () => {
    const h = fixture()
    const child = created(await h.service.create(h.root, op))
    writeFileSync(join(child.path, 'feature.txt'), 'child change\n')
    h.git(['add', '.'], child.path)
    h.git(['commit', '-m', 'child change'], child.path)
    await expect(h.service.finish(child.path, op)).resolves.toEqual({ action: 'kept-unmerged' })
    expect(existsSync(child.path)).toBe(false)
    const restarted = h.open()
    await expect(restarted.finish(child.path, op)).resolves.toEqual({ action: 'kept-unmerged' })
    h.git(['merge', '--no-ff', '-m', 'reviewed child', child.branch])
    // Missing receipt after branch deletion must be retryable after restart.
    h.git(['branch', '-d', child.branch])
    await expect(restarted.finish(child.path, op)).resolves.toEqual({ action: 'removed' })
  })
  it('refuses traversal, outside cwd, foreign worktrees and a symlinked target directory', async () => {
    const h = fixture()
    const foreign = join(h.root, '.worktrees', 'agnes-01234567')
    h.git(['worktree', 'add', '-b', 'agnes/subagent-01234567', foreign])
    await expect(h.service.finish(foreign, op)).resolves.toEqual({ action: 'kept-inspection-failed' })
    await expect(h.service.finish(join(h.root, '.worktrees') + '/../README.md', op)).resolves.toEqual({
      action: 'kept-inspection-failed',
    })
    await expect(h.service.create(h.directory, op)).resolves.toEqual({ skipped: 'git-error' })
    expect(await h.service.list(op)).toEqual([])
    expect(existsSync(foreign)).toBe(true)
    const other = fixture()
    const outside = join(other.directory, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(other.root, '.worktrees'), 'dir')
    await expect(other.service.create(other.root, op)).resolves.toEqual({ skipped: 'git-error' })
    expect(other.git(['branch', '--list', 'agnes/*']).trim()).toBe('')
  })
  it('binds each session to the Host workspace lease and rejects a caller cwd from another session', async () => {
    const a = fixture()
    const b = fixture()
    const service = createSessionGitWorktreeService({
      dataDir: a.dataDir,
      remote: false,
      signal: op.signal,
      workspaceInvocationFor: (key) => ({
        run: async (invoke) => {
          if (key !== 'a' && key !== 'b') throw new Error('unknown session')
          return invoke({ root: key === 'a' ? a.root : b.root } as WorkspaceInvocationView)
        },
      }),
    })
    await expect(service.create(b.root, { ...op, sessionKey: 'a' })).resolves.toEqual({
      skipped: 'git-error',
    })
    const child = created(await service.create(b.root, { ...op, sessionKey: 'b' }))
    await expect(service.finish(child.path, { ...op, sessionKey: 'a' })).resolves.toEqual({
      action: 'kept-inspection-failed',
    })
    await expect(service.finish(child.path, { ...op, sessionKey: 'b' })).resolves.toEqual({
      action: 'removed',
    })
    await expect(service.create(a.root, { ...op, sessionKey: 'unknown' })).rejects.toThrow('unknown session')
  })
  it('shares one workspace owner when two session keys resolve the same root', async () => {
    const h = fixture()
    const service = createSessionGitWorktreeService({
      dataDir: h.dataDir,
      remote: false,
      signal: op.signal,
      workspaceInvocationFor: (key) => ({
        run: async (invoke) => {
          if (key !== 'g1' && key !== 'g2') throw new Error('unknown session')
          return invoke({ root: h.root } as WorkspaceInvocationView)
        },
      }),
    })
    const child = created(await service.create(h.root, { ...op, sessionKey: 'g1' }))
    await expect(service.list({ ...op, sessionKey: 'g2' })).resolves.toEqual([
      { root: child.root, path: child.path, branch: child.branch, stage: 'attached' },
    ])
    const restarted = createSessionGitWorktreeService({
      dataDir: h.dataDir,
      remote: false,
      signal: op.signal,
      workspaceInvocationFor: () => ({
        run: async (invoke) => invoke({ root: h.root } as WorkspaceInvocationView),
      }),
    })
    await expect(restarted.list({ ...op, sessionKey: 'g2' })).resolves.toEqual([
      { root: child.root, path: child.path, branch: child.branch, stage: 'attached' },
    ])
  })
  it('deletes the creating record when git worktree add fails', async () => {
    const h = fixture()
    h.git(['update-ref', '-d', 'HEAD'])
    await expect(h.service.create(h.root, op)).resolves.toEqual({ skipped: 'git-error' })
    const registry = join(h.dataDir, 'git-worktrees')
    const records = existsSync(registry) ? readdirSync(registry).filter((name) => name.endsWith('.json')) : []
    expect(records).toEqual([])
  })
  it('classifies missing Git as git-error and cancellation without mutating the repo', async () => {
    const h = fixture()
    const previous = process.env.PATH
    try {
      process.env.PATH = h.directory
      await expect(h.service.create(h.root, op)).resolves.toEqual({ skipped: 'git-error' })
    } finally {
      if (previous === undefined) delete process.env.PATH
      else process.env.PATH = previous
    }
    const abort = new AbortController()
    abort.abort()
    await expect(h.service.create(h.root, { ...op, signal: abort.signal })).resolves.toEqual({
      skipped: 'git-error',
    })
    expect(h.git(['branch', '--list', 'agnes/*']).trim()).toBe('')
  })
  it('skips non-repositories, nonignored targets and remote sandbox workspaces explicitly', async () => {
    const h = fixture(false)
    await expect(h.service.create(h.root, op)).resolves.toEqual({ skipped: 'not-git' })
    const notIgnored = fixture(true, false)
    await expect(notIgnored.service.create(notIgnored.root, op)).resolves.toEqual({ skipped: 'git-error' })
    const remote = createGitWorktreeService({
      workspaceRoot: '/absent/remote/path',
      dataDir: h.dataDir,
      remote: true,
    })
    await expect(remote.create('/absent/remote/path', op)).resolves.toEqual({ skipped: 'remote-sandbox' })
    expect(await remote.list(op)).toEqual([])
  })
})
