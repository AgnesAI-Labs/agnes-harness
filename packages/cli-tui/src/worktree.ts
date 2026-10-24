import { execFile } from 'node:child_process'
import { existsSync, lstatSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import type { Locale } from './locale.js'
import { tt } from './locale-extended.js'

/** A refusal to create a worktree; its message is already in the user's language. */
export class WorktreeError extends Error {}

export type WorktreeInfo = {
  name: string
  path: string
  branch: string
  /** False when `.worktrees/` is not git-ignored, so the worktree would show up as untracked. */
  ignored: boolean
}

export type WorktreeOutcome = { info: WorktreeInfo; removed: boolean }

const NAME = /^[a-z0-9-]{1,32}$/

/** `agh-YYYYMMDD-HHMMSS` in local time. */
export function defaultWorktreeName(now = new Date()): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  const day = `${p(now.getFullYear(), 4)}${p(now.getMonth() + 1)}${p(now.getDate())}`
  return `agh-${day}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
}

/** One fixed-argument git call without a shell. */
function git(cwd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, out, err) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        resolve({ code, out, err })
      },
    )
  })
}

/** The main checkout's root, also from inside a linked worktree (whose own toplevel is the worktree). */
async function repoRoot(cwd: string): Promise<string | undefined> {
  const top = await git(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'])
  if (top.code !== 0) return undefined
  const [toplevel, common] = top.out.trim().split('\n')
  if (!toplevel) return undefined
  return common && basename(common) === '.git' ? dirname(common) : toplevel
}

/**
 * Creates `<root>/.worktrees/<name>` on a new branch `agh/<name>` cut from HEAD. Refuses a bad name, a
 * directory outside git, and a branch or directory that already exists; nothing is ever overwritten.
 */
export async function createWorktree(
  cwd: string,
  requested: string | undefined,
  locale: Locale,
  now = new Date(),
): Promise<WorktreeInfo> {
  const name = requested || defaultWorktreeName(now)
  if (!NAME.test(name)) throw new WorktreeError(tt('worktree.badName', locale))
  const root = await repoRoot(cwd)
  if (!root) throw new WorktreeError(tt('worktree.notRepo', locale, { cwd }))
  const branch = `agh/${name}`
  const parent = join(root, '.worktrees')
  // A symlinked .worktrees/ (say, committed by a cloned repo) would put the checkout outside the repo.
  if (lstatSync(parent, { throwIfNoEntry: false })?.isDirectory() === false)
    throw new WorktreeError(tt('worktree.badParent', locale, { path: parent }))
  const path = join(parent, name)
  const branchTaken =
    (await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0
  if (branchTaken || existsSync(path))
    throw new WorktreeError(tt('worktree.exists', locale, { name, branch, path }))
  const added = await git(root, ['worktree', 'add', '-b', branch, path, 'HEAD'])
  if (added.code !== 0)
    throw new WorktreeError(
      tt('worktree.gitFailed', locale, { detail: added.err.trim() || added.out.trim() }),
    )
  const ignored = (await git(root, ['check-ignore', '--quiet', '--', `.worktrees/${name}`])).code === 0
  return { name, path, branch, ignored }
}

/**
 * Removes the worktree when it has no changes. A dirty worktree (ignored files such as .env or node_modules
 * count: `git worktree remove` would delete them), one whose state cannot be read, and one git refuses to
 * remove are kept. Never forced, and the branch is never deleted.
 */
export async function cleanupWorktree(info: WorktreeInfo): Promise<WorktreeOutcome> {
  const status = await git(info.path, ['status', '--porcelain', '--ignored'])
  if (status.code !== 0 || status.out.trim() !== '') return { info, removed: false }
  const root = await repoRoot(info.path)
  if (!root) return { info, removed: false }
  const removed = await git(root, ['worktree', 'remove', info.path])
  return { info, removed: removed.code === 0 }
}

/** The line that says what happened to one worktree at cleanup. */
export function outcomeLine(outcome: WorktreeOutcome, locale: Locale): string {
  const { info } = outcome
  const params = { name: info.name, path: info.path, branch: info.branch }
  return tt(outcome.removed ? 'worktree.removed' : 'worktree.kept', locale, params)
}

/** The notices after starting in a worktree: where, the gitignore warning, and that trust is not inherited. */
export function startedNotices(info: WorktreeInfo, locale: Locale): string[] {
  return [
    tt('worktree.started', locale, { name: info.name, branch: info.branch, path: info.path }),
    ...(info.ignored ? [] : [tt('worktree.unignored', locale)]),
    tt('worktree.untrusted', locale),
  ]
}

/** The worktrees one TUI run created, keyed by the session started in each. */
export class WorktreeKeeper {
  private readonly owned = new Map<string, WorktreeInfo>()
  private active: WorktreeInfo | undefined
  private notes: string[] = []

  /** Lines to show under the next session shown (what was started, what was left behind). */
  queueNotes(lines: string[]): void {
    this.notes.push(...lines)
  }

  takeNotes(): string[] {
    const taken = this.notes
    this.notes = []
    return taken
  }

  /** Records the worktree a session was started in. */
  adopt(sessionId: string, info: WorktreeInfo): void {
    this.owned.set(sessionId, info)
  }

  /** The worktree of the session now shown, if this run made it. */
  current(): WorktreeInfo | undefined {
    return this.active
  }

  /**
   * The session shown changed: the worktree being left is cleaned. Returns what happened to it. A session
   * whose workspace `cwd` lies in a worktree of this run (a `/new` started inside it) belongs to that worktree.
   */
  async switched(sessionId: string, cwd?: string): Promise<WorktreeOutcome | undefined> {
    const within = (info: WorktreeInfo) => {
      const rel = cwd === undefined ? '..' : relative(info.path, cwd)
      return !rel.startsWith('..') && !isAbsolute(rel)
    }
    const home = this.owned.has(sessionId) ? undefined : [...this.owned.values()].find(within)
    if (home) this.owned.set(sessionId, home)
    const next = this.owned.get(sessionId)
    const left = this.active
    this.active = next
    if (!left || left === next) return undefined
    return this.clean(left)
  }

  /** At exit: every worktree this run made that is still on disk. */
  async finish(): Promise<WorktreeOutcome[]> {
    const outcomes: WorktreeOutcome[] = []
    for (const info of new Set(this.owned.values())) outcomes.push(await this.clean(info))
    return outcomes
  }

  private async clean(info: WorktreeInfo): Promise<WorktreeOutcome> {
    const outcome = await cleanupWorktree(info)
    if (outcome.removed) for (const [id, held] of this.owned) if (held === info) this.owned.delete(id)
    return outcome
  }
}
