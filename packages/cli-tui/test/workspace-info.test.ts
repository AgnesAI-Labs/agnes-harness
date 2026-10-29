import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  readWorkspaceInfo,
  tildePath,
  type WorkspaceInfo,
  workspaceRefresher,
} from '../src/workspace-info.js'

// realpath: git reports /private/var/... on macOS, where tmpdir() says /var/...
const home = realpathSync(mkdtempSync(join(tmpdir(), 'agh-workspace-info-')))
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
    cwd,
    env,
    encoding: 'utf8',
  }).trim()

const repo = join(home, 'agnes-harness')
mkdirSync(join(repo, 'packages', 'web'), { recursive: true })
git(repo, 'init', '--quiet', '--initial-branch=feat/agh-plugin-core')
const fresh = join(home, 'fresh')
mkdirSync(fresh)
git(fresh, 'init', '--quiet', '--initial-branch=main')
git(repo, 'commit', '--quiet', '--allow-empty', '-m', 'one')
const lane = join(home, 'lanes', 'lane-a')
git(repo, 'worktree', 'add', '--quiet', '-b', 'feat/web-settings', lane)
mkdirSync(join(lane, 'packages', 'web'), { recursive: true })
const detachedLane = join(home, 'lanes', 'detached')
git(repo, 'worktree', 'add', '--quiet', '--detach', detachedLane)
const short = git(repo, 'rev-parse', '--short', 'HEAD')
const tracked = join(home, 'tracked')
mkdirSync(tracked)
git(tracked, 'init', '--quiet', '--initial-branch=main')
git(tracked, 'commit', '--quiet', '--allow-empty', '-m', 'one')
git(home, 'init', '--quiet', '--bare', join(home, 'remote.git'))
git(tracked, 'remote', 'add', 'origin', join(home, 'remote.git'))
git(tracked, 'push', '--quiet', '-u', 'origin', 'main')
git(tracked, 'commit', '--quiet', '--allow-empty', '-m', 'two')
const plain = join(home, 'notes')
mkdirSync(plain)

afterAll(() => rmSync(home, { recursive: true, force: true }))

describe('workspace info for the composer rail', () => {
  it.each<[string, string, WorkspaceInfo]>([
    ['main repository root', repo, { root: '~/agnes-harness', subpath: '', branch: 'feat/agh-plugin-core' }],
    [
      'subdirectory of the main repository',
      join(repo, 'packages', 'web'),
      { root: '~/agnes-harness', subpath: 'packages/web', branch: 'feat/agh-plugin-core' },
    ],
    [
      'subdirectory of a linked worktree names the main repository and the worktree',
      join(lane, 'packages', 'web'),
      { root: '~/agnes-harness', subpath: 'packages/web', worktree: 'lane-a', branch: 'feat/web-settings' },
    ],
    [
      'detached HEAD shows the short commit',
      detachedLane,
      { root: '~/agnes-harness', subpath: '', worktree: 'detached', detached: short },
    ],
    [
      'repository without commits still has its branch',
      fresh,
      { root: '~/fresh', subpath: '', branch: 'main' },
    ],
    [
      'a branch ahead of its upstream counts the commits',
      tracked,
      { root: '~/tracked', subpath: '', branch: 'main', ahead: 1 },
    ],
    ['outside git only the directory', plain, { root: '~/notes', subpath: '' }],
    [
      'a directory that does not exist is only path text',
      join(home, 'gone'),
      { root: '~/gone', subpath: '' },
    ],
  ])('%s', async (_name, cwd, expected) => {
    expect(await readWorkspaceInfo(cwd, { home })).toEqual(expected)
  })

  it('a timed-out probe degrades to the directory', async () => {
    expect(await readWorkspaceInfo(repo, { home, signal: AbortSignal.abort() })).toEqual({
      root: '~/agnes-harness',
      subpath: '',
    })
  })

  it('abbreviates only a home-directory prefix', () => {
    const me = join(home, 'me')
    expect(tildePath(join(me, 'x'), me)).toBe('~/x')
    expect(tildePath(me, me)).toBe('~')
    expect(tildePath(join(home, 'mel', 'x'), me)).toBe(join(home, 'mel', 'x').split(sep).join('/'))
  })

  it('keeps one probe in flight and reruns once for refreshes asked meanwhile', async () => {
    const seen: string[] = []
    let calls = 0
    let release = () => {}
    const refresh = workspaceRefresher(
      '/w',
      () => {
        calls++
        return new Promise((resolve) => {
          release = () => resolve({ root: `r${calls}`, subpath: '' })
        })
      },
      (info) => seen.push(info.root),
    )
    refresh()
    refresh()
    refresh()
    expect(calls).toBe(1)
    release()
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toBe(2)
    release()
    await new Promise((r) => setTimeout(r, 0))
    expect(seen).toEqual(['r1', 'r2'])
    expect(calls).toBe(2)
  })
})
