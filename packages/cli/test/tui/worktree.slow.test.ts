import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorktree, defaultWorktreeName, WorktreeKeeper } from '@agnes/cli-tui'
import { createClient } from '@agnes/sdk'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../../src/args.js'
import { UsageError } from '../../src/errors.js'
import { TuiApp } from '../../src/tui/app.js'
import { runSlash } from '../../src/tui/commands.js'
import { FakeTerminal } from '../../src/tui/terminal.js'
import { openWorktreeFlag } from '../../src/worktree.js'
import { scriptedEndpoint } from '../fake-endpoint.js'
import { screenOf } from './harness.js'

const dirs: string[] = []
const scratch = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agh-worktree-')))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })

function repo(ignoreWorktrees = false): string {
  const dir = scratch()
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  if (ignoreWorktrees) writeFileSync(join(dir, '.gitignore'), '.worktrees/\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

const branches = (dir: string): string[] =>
  git(dir, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean)

describe('createWorktree', () => {
  it('makes .worktrees/<name> on agh/<name>, and says whether .worktrees/ is ignored', async () => {
    const root = repo()
    const made = await createWorktree(root, 'demo', 'en')
    expect(made).toMatchObject({
      name: 'demo',
      branch: 'agh/demo',
      path: join(root, '.worktrees', 'demo'),
      ignored: false,
    })
    expect(existsSync(join(made.path, 'a.txt'))).toBe(true)
    expect(branches(root)).toContain('agh/demo')
    const quiet = repo(true)
    expect((await createWorktree(quiet, 'demo', 'en')).ignored).toBe(true)
  })

  it('names the default by time, and from inside a linked worktree still uses the main checkout', async () => {
    expect(defaultWorktreeName(new Date(2026, 9, 24, 0, 12, 3))).toBe('agh-20261024-001203')
    const root = repo()
    const first = await createWorktree(root, undefined, 'en')
    expect(first.name).toMatch(/^agh-\d{8}-\d{6}$/)
    const second = await createWorktree(first.path, 'other', 'en')
    expect(second.path).toBe(join(root, '.worktrees', 'other'))
  })

  it('refuses a bad name, a non-repository, and an existing branch or directory', async () => {
    const root = repo()
    for (const bad of ['Bad', 'a_b', 'x'.repeat(33), '../up'])
      await expect(createWorktree(root, bad, 'en')).rejects.toThrow('[a-z0-9-]{1,32}')
    await expect(createWorktree(scratch(), 'demo', 'en')).rejects.toThrow('not inside one')
    await createWorktree(root, 'demo', 'en')
    await expect(createWorktree(root, 'demo', 'en')).rejects.toThrow('already exists')
    git(root, 'branch', 'agh/solo')
    await expect(createWorktree(root, 'solo', 'en')).rejects.toThrow('already exists')
    mkdirSync(join(root, '.worktrees', 'dir'), { recursive: true })
    await expect(createWorktree(root, 'dir', 'en')).rejects.toThrow('already exists')
    const linked = repo()
    const outside = scratch()
    symlinkSync(outside, join(linked, '.worktrees'))
    await expect(createWorktree(linked, 'evil', 'en')).rejects.toThrow('symlink or not a directory')
    expect(readdirSync(outside)).toEqual([])
  })
})

describe('WorktreeKeeper', () => {
  it('removes a clean worktree on exit, keeps a dirty one, and keeps both branches', async () => {
    const root = repo()
    const keeper = new WorktreeKeeper()
    const clean = await createWorktree(root, 'clean', 'en')
    const dirty = await createWorktree(root, 'dirty', 'en')
    keeper.adopt('s1', clean)
    keeper.adopt('s2', dirty)
    writeFileSync(join(dirty.path, 'new.txt'), 'x')
    const outcomes = await keeper.finish()
    expect(outcomes.map((o) => [o.info.name, o.removed])).toEqual([
      ['clean', true],
      ['dirty', false],
    ])
    expect(existsSync(clean.path)).toBe(false)
    expect(existsSync(dirty.path)).toBe(true)
    expect(branches(root)).toEqual(expect.arrayContaining(['agh/clean', 'agh/dirty']))
  })

  it('keeps a worktree that holds only git-ignored files, since removing it would lose them', async () => {
    const root = repo(true)
    writeFileSync(join(root, '.gitignore'), '.worktrees/\n.env\n')
    git(root, 'commit', '-q', '-am', 'ignore .env')
    const keeper = new WorktreeKeeper()
    const info = await createWorktree(root, 'envonly', 'en')
    keeper.adopt('s1', info)
    writeFileSync(join(info.path, '.env'), 'SECRET=1')
    const [outcome] = await keeper.finish()
    expect(outcome?.removed).toBe(false)
    expect(readFileSync(join(info.path, '.env'), 'utf8')).toBe('SECRET=1')
  })
})

describe('--worktree', () => {
  it('parses the flag, with a name only through =', () => {
    expect(parseArgs(['--worktree']).worktree).toBe('')
    expect(parseArgs(['--worktree=fix-it', 'go']).worktree).toBe('fix-it')
    expect(parseArgs(['--worktree', 'go']).positional).toEqual(['go'])
    expect(() => parseArgs(['sessions', '--worktree'])).toThrow(UsageError)
  })

  it('points the run at the new worktree, and refuses remote, ACP and a non-repository', async () => {
    const root = repo()
    const p = parseArgs(['--worktree=demo'])
    const made = await openWorktreeFlag(p, 'tui', { cwd: root, env: {} }, 'en')
    expect(p.cwd).toBe(made?.path)
    expect(existsSync(join(root, '.worktrees', 'demo'))).toBe(true)
    const again = parseArgs(['--worktree=more', '--connect', 'tcp://x'])
    await expect(openWorktreeFlag(again, 'tui', { cwd: root, env: {} }, 'en')).rejects.toThrow(
      'only be created on this machine',
    )
    await expect(
      openWorktreeFlag(
        parseArgs(['--worktree=more']),
        'tui',
        { cwd: root, env: { AGNES_CONNECT: 'x' } },
        'en',
      ),
    ).rejects.toThrow('only be created on this machine')
    await expect(
      openWorktreeFlag(parseArgs(['--worktree=more', '--resume', 'x']), 'tui', { cwd: root, env: {} }, 'en'),
    ).rejects.toThrow('--resume')
    await expect(
      openWorktreeFlag(parseArgs(['--worktree=more']), 'acp', { cwd: root, env: {} }, 'en'),
    ).rejects.toThrow('ACP')
    await expect(
      openWorktreeFlag(parseArgs(['--worktree=more']), 'print', { cwd: scratch(), env: {} }, 'en'),
    ).rejects.toThrow(UsageError)
    expect(existsSync(join(root, '.worktrees', 'more'))).toBe(false)
  })
})

describe('/worktree', () => {
  async function liveApp(cwd: string, remote = false) {
    let n = 0
    const ep = scriptedEndpoint()
      .on('session/new', () => ({ sessionId: `agnes:local:default:cli:dm:s${n++}` }))
      .on('_agnes/v1/workspace.add', (params) => ({
        workspace: {
          path: (params as { path: string }).path,
          name: 'w',
          lastUsedAt: null,
          sessionCount: 0,
          available: true,
          workspaceId: 'a'.repeat(64),
          revision: 1,
        },
      }))
      .on('_agnes/v1/session.projectUI', () => ({
        sessionId: 'x',
        upto: 0,
        generation: 1,
        opState: null,
        turns: [],
        nodes: [],
      }))
      .on('_agnes/v1/session.budget', () => ({ state: null, ledger: [] }))
    const client = createClient({ transport: { kind: 'inproc', endpoint: ep } })
    const session = await client.session.new({ cwd })
    const term = new FakeTerminal({ columns: 100, rows: 30 })
    const app = new TuiApp({
      session,
      term,
      header: 'Agnes',
      locale: 'en',
      cwd,
      ...(remote ? { remote } : {}),
    })
    await app.start()
    return { app, term, client, ep }
  }
  const calls = (ep: { calls: Array<{ method: string; params: unknown }> }, method: string) =>
    ep.calls.filter((c) => c.method === method)

  it('creates the worktree, registers it, starts a session there, and says the workspace is untrusted', async () => {
    const root = repo()
    const { app, term, client, ep } = await liveApp(root)
    try {
      const first = app.session.id
      term.feed('/worktree demo')
      term.feed('\r')
      await vi.waitFor(() => expect(app.session.id).not.toBe(first))
      const path = join(root, '.worktrees', 'demo')
      expect(existsSync(path)).toBe(true)
      expect(branches(root)).toContain('agh/demo')
      expect(calls(ep, '_agnes/v1/workspace.add').at(-1)?.params).toMatchObject({ path })
      expect(calls(ep, 'session/new').at(-1)?.params).toMatchObject({ cwd: path })
      await vi.waitFor(async () =>
        expect((await screenOf(term, 100, 30)).join('\n')).toContain('not trusted'),
      )
      expect(app.worktrees.current()?.path).toBe(path)
    } finally {
      await app.stop()
      await client.close()
    }
  })

  it('switching away removes a clean worktree and keeps a dirty one, never the branch', async () => {
    const root = repo()
    const { app, term, client } = await liveApp(root)
    try {
      for (const [name, dirty] of [
        ['clean', false],
        ['dirty', true],
      ] as const) {
        const before = app.session.id
        term.feed(`/worktree ${name}`)
        term.feed('\r')
        await vi.waitFor(() => expect(app.session.id).not.toBe(before))
        const path = join(root, '.worktrees', name)
        if (dirty) writeFileSync(join(path, 'wip.txt'), 'x')
        const inside = app.session.id
        term.feed('/new')
        term.feed('\r')
        await vi.waitFor(() => expect(app.session.id).not.toBe(inside))
        await vi.waitFor(() => expect(existsSync(path)).toBe(dirty))
        expect(branches(root)).toContain(`agh/${name}`)
      }
      expect(app.worktrees.current()).toBeUndefined()
    } finally {
      await app.stop()
      await client.close()
    }
  })

  it('refuses over a remote connection, outside a repository, and for a name that is taken', async () => {
    const root = repo()
    const remote = await liveApp(root, true)
    try {
      expect((await runSlash(remote.app, '/worktree demo')).text).toContain('only be created on this machine')
      expect(existsSync(join(root, '.worktrees'))).toBe(false)
    } finally {
      await remote.app.stop()
      await remote.client.close()
    }
    const outside = await liveApp(scratch())
    try {
      await expect(runSlash(outside.app, '/worktree demo')).rejects.toThrow('not inside one')
    } finally {
      await outside.app.stop()
      await outside.client.close()
    }
    const local = await liveApp(root)
    try {
      await runSlash(local.app, '/worktree demo')
      await expect(runSlash(local.app, '/worktree demo')).rejects.toThrow('already exists')
    } finally {
      await local.app.stop()
      await local.client.close()
    }
  })
})
