import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { gitWorktrees } from '../src/worktree.js'

it('creates and removes real Git worktrees in a Unicode path while preserving dirty work', async () => {
  const temporaryParent = realpathSync(tmpdir())
  const temporary = realpathSync(mkdtempSync(join(temporaryParent, 'agnes-worktree-中文 ')))
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
    const manager = gitWorktrees({ events: { append: async () => 1 }, id: () => '1234abcd' })
    const created = await manager.create(ctx)
    expect(created).toHaveProperty('path')
    if ('skipped' in created) throw new Error(`real Git creation failed: ${created.skipped}`)
    expect(realpathSync(created.path)).toBe(created.path)
    expect(git(['-C', created.path, 'rev-parse', 'HEAD'])).toBe(before)
    const marker = join(created.path, 'uncommitted-fixture.txt')
    writeFileSync(marker, 'must survive cleanup\n')
    await expect(manager.finish(ctx, 'child', created.path)).resolves.toEqual({ action: 'kept-dirty' })
    expect(readFileSync(marker, 'utf8')).toBe('must survive cleanup\n')
    rmSync(marker)
    await expect(manager.finish(ctx, 'child', created.path)).resolves.toEqual({ action: 'removed' })
    expect(existsSync(created.path)).toBe(false)
    expect(git(['branch', '--list', created.branch]).trim()).toBe('')
    expect(git(['rev-parse', 'HEAD'])).toBe(before)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}, 60000)
