import { execFileSync } from 'node:child_process'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { gitWorktrees } from '../src/worktree.js'

type Reply = { code: number; stdout: string; stderr: string; truncated?: boolean }

const ROOT = resolve('/work/proj')
const GIT_ROOT = ROOT.split(sep).join('/')

const ok = (stdout = ''): Reply => ({ code: 0, stdout, stderr: '' })
const commandIs = (command: string[], ...parts: string[]): boolean =>
  parts.every((part, index) => command[index] === part)

function harness(script: (command: string[]) => Reply, options: { cwd?: string; id?: string } = {}) {
  const events: unknown[] = []
  const ctx = fakeToolContext({
    cwd: options.cwd ?? ROOT,
    files: { 'README.md': 'project' },
    exec: script,
  })
  const worktrees = gitWorktrees({
    events: {
      async append(name, data) {
        events.push([name, data])
        return events.length
      },
    },
    id: () => options.id ?? '1234abcd',
  })
  // This fixture's memory filesystem uses POSIX keys; model just the native cwd directory here.
  const stat = ctx.fs.stat
  ctx.fs.stat = async (path) => (path === ctx.cwd ? { kind: 'dir', size: 0, mtimeMs: 0 } : stat(path))
  return { ctx, events, worktrees }
}

function normalScript(command: string[]): Reply {
  if (commandIs(command, 'git', 'rev-parse')) return ok(`${GIT_ROOT}\n`)
  return ok()
}

describe('gitWorktrees create', () => {
  it('accepts the repository root printed by the actual Git executable', async () => {
    const output = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dirname(fileURLToPath(import.meta.url)),
      encoding: 'utf8',
    })
    const cwd = resolve(output.trim())
    const { ctx, worktrees } = harness(
      (command) => (commandIs(command, 'git', 'rev-parse') ? ok(output) : ok()),
      { cwd },
    )
    await expect(worktrees.create(ctx)).resolves.toMatchObject({
      path: join(cwd, '.worktrees', 'agnes-1234abcd'),
    })
  })

  it('creates one worktree under the fenced repository with a dedicated branch', async () => {
    const { ctx, worktrees } = harness(normalScript)

    await expect(worktrees.create(ctx)).resolves.toEqual({
      id: '1234abcd',
      path: join(ROOT, '.worktrees', 'agnes-1234abcd'),
      branch: 'agnes/subagent-1234abcd',
    })
    expect(ctx.calls.exec[0]).toEqual(['git', 'rev-parse', '--show-toplevel'])
    expect(ctx.calls.exec[1]).toEqual(['git', 'check-ignore', '--quiet', '--', '.worktrees/agnes-1234abcd'])
    expect(ctx.calls.exec[2]).toEqual([
      'git',
      'worktree',
      'add',
      '-b',
      'agnes/subagent-1234abcd',
      join(ROOT, '.worktrees', 'agnes-1234abcd'),
      'HEAD',
    ])
    expect(ctx.calls.execOpts[2]).toMatchObject({ cwd: ROOT, timeoutMs: 30_000 })
  })

  it('falls back outside git and records the reason', async () => {
    const { ctx, events, worktrees } = harness(() => ({
      code: 128,
      stdout: '',
      stderr: 'fatal: not a git repository',
    }))

    await expect(worktrees.create(ctx)).resolves.toEqual({ skipped: 'not-git' })
    expect(events).toEqual([['worktree-skipped', { reason: 'not-git' }]])
  })

  it('classifies a sandbox refusal without attempting worktree creation', async () => {
    const { ctx, events, worktrees } = harness(() => {
      throw new Error('SANDBOX_DENIED: remote sandbox has no git access')
    })

    await expect(worktrees.create(ctx)).resolves.toEqual({ skipped: 'remote-sandbox' })
    expect(events).toEqual([['worktree-skipped', { reason: 'remote-sandbox' }]])
    expect(ctx.calls.exec).toHaveLength(1)
  })

  it('rejects a repository root that the HostFs fence refuses', async () => {
    const { ctx, events, worktrees } = harness((command) =>
      commandIs(command, 'git', 'rev-parse') ? ok(`${resolve('/work')}\n`) : ok(),
    )
    const stat = ctx.fs.stat
    ctx.fs.stat = async (path) => {
      if (path === resolve('/work'))
        throw Object.assign(new Error('E_FS_DENIED: outside workspace'), { code: 'E_FS_DENIED' })
      return stat(path)
    }

    await expect(worktrees.create(ctx)).resolves.toEqual({ skipped: 'git-error' })
    expect(events).toEqual([['worktree-skipped', { reason: 'git-error' }]])
    expect(ctx.calls.exec).toHaveLength(1)
  })

  it('rejects malformed roots and ids before they can become command paths', async () => {
    const badRoot = harness((command) =>
      commandIs(command, 'git', 'rev-parse') ? ok(`${GIT_ROOT}/../escape\n`) : ok(),
    )
    await expect(badRoot.worktrees.create(badRoot.ctx)).resolves.toEqual({ skipped: 'git-error' })
    expect(badRoot.ctx.calls.exec).toHaveLength(1)

    const badId = harness(normalScript, { id: '../../escape' })
    await expect(badId.worktrees.create(badId.ctx)).resolves.toEqual({ skipped: 'git-error' })
    expect(badId.ctx.calls.exec).toHaveLength(1)
  })

  it.each(['', `${GIT_ROOT}/../escape`, `${GIT_ROOT}//child`, `${GIT_ROOT}\n${GIT_ROOT}`, `${GIT_ROOT}\0`])(
    'rejects noncanonical Git output %j before any mutating command',
    async (root) => {
      const { ctx, worktrees } = harness((command) =>
        commandIs(command, 'git', 'rev-parse') ? ok(`${root}\n`) : ok(),
      )
      await expect(worktrees.create(ctx)).resolves.toEqual({ skipped: 'git-error' })
      expect(ctx.calls.exec).toEqual([['git', 'rev-parse', '--show-toplevel']])
    },
  )

  it('does not silently reuse an active id when creation is repeated', async () => {
    const { ctx, events, worktrees } = harness(normalScript)

    await expect(worktrees.create(ctx)).resolves.toMatchObject({ id: '1234abcd' })
    await expect(worktrees.create(ctx)).resolves.toEqual({ skipped: 'git-error' })
    expect(ctx.calls.exec.filter((command) => commandIs(command, 'git', 'worktree', 'add'))).toHaveLength(1)
    expect(events).toEqual([['worktree-skipped', { reason: 'git-error' }]])
  })

  it('refuses to create a nested worktree unless the repository ignores its exact target', async () => {
    const { ctx, events, worktrees } = harness((command) => {
      if (commandIs(command, 'git', 'rev-parse')) return ok(`${GIT_ROOT}\n`)
      if (commandIs(command, 'git', 'check-ignore')) {
        return { code: 1, stdout: '', stderr: '' }
      }
      return ok()
    })

    await expect(worktrees.create(ctx)).resolves.toEqual({ skipped: 'git-error' })
    expect(ctx.calls.exec).toContainEqual([
      'git',
      'check-ignore',
      '--quiet',
      '--',
      '.worktrees/agnes-1234abcd',
    ])
    expect(ctx.calls.exec.some((command) => commandIs(command, 'git', 'worktree', 'add'))).toBe(false)
    expect(events).toEqual([['worktree-skipped', { reason: 'git-error' }]])
  })

  it('turns worktree-add failures into an auditable fallback', async () => {
    const { ctx, events, worktrees } = harness((command) => {
      if (commandIs(command, 'git', 'rev-parse')) return ok(`${GIT_ROOT}\n`)
      if (commandIs(command, 'git', 'check-ignore')) return ok()
      return { code: 128, stdout: '', stderr: 'branch already exists' }
    })

    await expect(worktrees.create(ctx)).resolves.toEqual({ skipped: 'git-error' })
    expect(events).toEqual([['worktree-skipped', { reason: 'git-error' }]])
  })
})

describe('gitWorktrees finish', () => {
  it('removes a clean worktree and its merged branch without force or merge operations', async () => {
    const { ctx, worktrees } = harness(normalScript)
    const created = await worktrees.create(ctx)
    if ('skipped' in created) throw new Error('fixture did not create a worktree')

    await expect(worktrees.finish(ctx, 'child-1', created.path)).resolves.toEqual({ action: 'removed' })
    expect(ctx.calls.exec).toContainEqual([
      'git',
      '-C',
      created.path,
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ])
    expect(ctx.calls.exec).toContainEqual(['git', 'worktree', 'remove', created.path])
    expect(ctx.calls.exec).toContainEqual(['git', 'branch', '-d', created.branch])
    const flattened = ctx.calls.exec.flat()
    expect(flattened).not.toContain('--force')
    expect(flattened).not.toContain('-D')
    expect(flattened).not.toContain('merge')
    expect(flattened).not.toContain('rebase')
  })

  it('keeps a dirty worktree without attempting cleanup', async () => {
    const { ctx, worktrees } = harness((command) => {
      if (commandIs(command, 'git', 'rev-parse')) return ok(`${GIT_ROOT}\n`)
      if (command.includes('status')) return ok(' M src/a.ts\n?? new.txt\n')
      return ok()
    })
    const created = await worktrees.create(ctx)
    if ('skipped' in created) throw new Error('fixture did not create a worktree')

    await expect(worktrees.finish(ctx, 'child-1', created.path)).resolves.toEqual({
      action: 'kept-dirty',
    })
    expect(ctx.calls.exec.some((command) => commandIs(command, 'git', 'worktree', 'remove'))).toBe(false)
  })

  it.each([
    ['non-zero', false],
    ['throw', true],
  ])('keeps the worktree when status inspection returns %s', async (_name, throws) => {
    const { ctx, worktrees } = harness((command) => {
      if (commandIs(command, 'git', 'rev-parse')) return ok(`${GIT_ROOT}\n`)
      if (command.includes('status')) {
        if (throws) throw new Error('status unavailable')
        return { code: 1, stdout: '', stderr: 'status failed' }
      }
      return ok()
    })
    const created = await worktrees.create(ctx)
    if ('skipped' in created) throw new Error('fixture did not create a worktree')

    await expect(worktrees.finish(ctx, 'child-1', created.path)).resolves.toEqual({
      action: 'kept-inspection-failed',
    })
    expect(ctx.calls.exec.some((command) => commandIs(command, 'git', 'worktree', 'remove'))).toBe(false)
  })

  it('does not operate on a path that was not created by this manager', async () => {
    const { ctx, worktrees } = harness(normalScript)

    await expect(worktrees.finish(ctx, 'child-1', '/tmp/unrelated')).resolves.toEqual({
      action: 'kept-inspection-failed',
    })
    expect(ctx.calls.exec).toEqual([])
  })

  it('reports worktree removal failure and never deletes the branch afterward', async () => {
    const { ctx, worktrees } = harness((command) => {
      if (commandIs(command, 'git', 'rev-parse')) return ok(`${GIT_ROOT}\n`)
      if (commandIs(command, 'git', 'worktree', 'remove')) {
        return { code: 1, stdout: '', stderr: 'locked worktree' }
      }
      return ok()
    })
    const created = await worktrees.create(ctx)
    if ('skipped' in created) throw new Error('fixture did not create a worktree')

    await expect(worktrees.finish(ctx, 'child-1', created.path)).resolves.toEqual({
      action: 'cleanup-failed',
      stage: 'worktree-remove',
    })
    expect(ctx.calls.exec.some((command) => commandIs(command, 'git', 'branch'))).toBe(false)
  })

  it('preserves an unmerged branch and can retry only that cleanup stage', async () => {
    let deletes = 0
    const { ctx, worktrees } = harness((command) => {
      if (commandIs(command, 'git', 'rev-parse')) return ok(`${GIT_ROOT}\n`)
      if (commandIs(command, 'git', 'branch', '-d')) {
        deletes++
        return deletes === 1 ? { code: 1, stdout: '', stderr: 'not fully merged' } : ok()
      }
      return ok()
    })
    const created = await worktrees.create(ctx)
    if ('skipped' in created) throw new Error('fixture did not create a worktree')

    await expect(worktrees.finish(ctx, 'child-1', created.path)).resolves.toEqual({
      action: 'kept-unmerged',
    })
    await expect(worktrees.finish(ctx, 'child-1', created.path)).resolves.toEqual({ action: 'removed' })
    expect(ctx.calls.exec.filter((command) => command.includes('status'))).toHaveLength(1)
    expect(ctx.calls.exec.filter((command) => commandIs(command, 'git', 'worktree', 'remove'))).toHaveLength(
      1,
    )
    expect(ctx.calls.exec.filter((command) => commandIs(command, 'git', 'branch', '-d'))).toHaveLength(2)
  })
})
