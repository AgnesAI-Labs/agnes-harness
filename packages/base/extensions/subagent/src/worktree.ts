import { randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ToolContext } from '@agnes/extension-api'
import type { JsonValue } from '@agnes/protocol'

export type WorktreeSkipReason = 'not-git' | 'remote-sandbox' | 'git-error'

export type WorktreeCreateResult =
  | { id: string; path: string; branch: string }
  | { skipped: WorktreeSkipReason }

export type WorktreeFinishResult =
  | { action: 'removed' }
  | { action: 'kept-dirty' }
  | { action: 'kept-unmerged' }
  | { action: 'kept-inspection-failed' }
  | { action: 'kept-in-use' }
  | { action: 'cleanup-failed'; stage: 'worktree-remove' | 'branch-delete' }

export type WorktreeManager = {
  create(ctx: ToolContext): Promise<WorktreeCreateResult>
  finish(ctx: ToolContext, childKey: string, path: string): Promise<WorktreeFinishResult>
  bind?(childKey: string, path: string): Promise<void>
}

export type WorktreeEntry = {
  root: string
  path: string
  branch: string
  stage: 'attached' | 'worktree-removed'
}

type WorktreeEvents = {
  append(name: string, data: JsonValue): Promise<number>
}

export type GitWorktreeDeps = {
  events: WorktreeEvents
  /** Deterministic only in tests; production ids always come from randomUUID. */
  id?: () => string
  /** Durable entry store so finish does not depend on this process's Map. */
  persist?: {
    load(): Map<string, WorktreeEntry>
    save(entries: Map<string, WorktreeEntry>): void
    bind?(childKey: string, entry: WorktreeEntry): void
  }
  /** True when another live child still uses this cwd. */
  inUse?: (path: string) => boolean
}

const ID = /^[0-9a-f]{8}$/
const MAX_GIT_MS = 30_000

function boundedTimeout(ctx: ToolContext): number {
  if (!Number.isFinite(ctx.timeoutMs) || ctx.timeoutMs <= 0) return MAX_GIT_MS
  return Math.max(1, Math.min(Math.floor(ctx.timeoutMs), MAX_GIT_MS))
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return String(error)
  } catch {
    return ''
  }
}

function isRemoteSandboxFailure(value: unknown): boolean {
  return /SANDBOX_DENIED|remote(?:[-_\s]?sandbox)?/i.test(errorText(value))
}

function parseRepositoryRoot(stdout: string, cwd: string): string | undefined {
  let root = stdout
  if (root.endsWith('\n')) root = root.slice(0, -1)
  if (root.endsWith('\r')) root = root.slice(0, -1)
  if (root.length === 0 || root.includes('\0') || root.includes('\n') || root.includes('\r')) return
  // Git prints forward slashes on Windows; preserve all other canonical-path checks.
  root = root.split('/').join(sep)
  if (!isAbsolute(root) || resolve(root) !== root) return

  const fromRoot = relative(root, resolve(cwd))
  if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) return
  return root
}

/**
 * Git-backed worktree lifecycle using only the kernel-controlled ToolContext boundaries.
 *
 * `ctx.exec` already enters the sandbox seam, so commands stay argv-shaped and are never passed to
 * an ambient shell. `ctx.fs.stat` makes the HostFs fence prove the repository root is reachable
 * before that root can become an exec cwd. Production confinement beyond that remains the host's
 * sandbox responsibility; this module does not claim to install an L1/L2 backend.
 */
export function gitWorktrees(deps: GitWorktreeDeps): WorktreeManager {
  const entries = deps.persist?.load() ?? new Map<string, WorktreeEntry>()
  const save = (): void => {
    deps.persist?.save(entries)
  }

  const skipped = async (reason: WorktreeSkipReason): Promise<WorktreeCreateResult> => {
    await deps.events.append('worktree-skipped', { reason })
    return { skipped: reason }
  }

  return {
    async create(ctx): Promise<WorktreeCreateResult> {
      const timeoutMs = boundedTimeout(ctx)
      let top: Awaited<ReturnType<ToolContext['exec']>>
      try {
        top = await ctx.exec(['git', 'rev-parse', '--show-toplevel'], { cwd: ctx.cwd, timeoutMs })
      } catch (error) {
        return skipped(isRemoteSandboxFailure(error) ? 'remote-sandbox' : 'git-error')
      }
      if (top.code !== 0) {
        return skipped(isRemoteSandboxFailure(`${top.stdout}\n${top.stderr}`) ? 'remote-sandbox' : 'not-git')
      }
      if (top.truncated) return skipped('git-error')

      const root = parseRepositoryRoot(top.stdout, ctx.cwd)
      if (!root) return skipped('git-error')
      try {
        const stat = await ctx.fs.stat(root)
        if (stat.kind !== 'dir') return skipped('git-error')
      } catch (error) {
        return skipped(isRemoteSandboxFailure(error) ? 'remote-sandbox' : 'git-error')
      }

      const id = deps.id?.() ?? randomUUID().replaceAll('-', '').slice(0, 8)
      if (!ID.test(id)) return skipped('git-error')
      const path = join(root, '.worktrees', `agnes-${id}`)
      const branch = `agnes/subagent-${id}`
      if (entries.has(path)) return skipped('git-error')

      const fromRoot = relative(root, path)
      if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
        return skipped('git-error')
      }
      const relativeTarget = fromRoot.split(sep).join('/')

      // A nested worktree that is not ignored appears as an untracked directory in the parent.
      // Besides making every status look dirty, `git add .` can then stage the nested checkout.
      // The repository owner must opt into this location with an ignore rule; this primitive never
      // edits that policy on the user's behalf.
      let ignored: Awaited<ReturnType<ToolContext['exec']>>
      try {
        ignored = await ctx.exec(['git', 'check-ignore', '--quiet', '--', relativeTarget], {
          cwd: root,
          timeoutMs,
        })
      } catch (error) {
        return skipped(isRemoteSandboxFailure(error) ? 'remote-sandbox' : 'git-error')
      }
      if (ignored.code !== 0 || ignored.truncated) {
        return skipped(
          isRemoteSandboxFailure(`${ignored.stdout}\n${ignored.stderr}`) ? 'remote-sandbox' : 'git-error',
        )
      }

      let added: Awaited<ReturnType<ToolContext['exec']>>
      try {
        added = await ctx.exec(['git', 'worktree', 'add', '-b', branch, path, 'HEAD'], {
          cwd: root,
          timeoutMs,
        })
      } catch (error) {
        return skipped(isRemoteSandboxFailure(error) ? 'remote-sandbox' : 'git-error')
      }
      if (added.code !== 0 || added.truncated) {
        return skipped(
          isRemoteSandboxFailure(`${added.stdout}\n${added.stderr}`) ? 'remote-sandbox' : 'git-error',
        )
      }

      entries.set(path, { root, path, branch, stage: 'attached' })
      save()
      return { id, path, branch }
    },

    async bind(childKey, path) {
      if (deps.persist) {
        for (const [key, value] of deps.persist.load()) entries.set(key, value)
      }
      const entry = entries.get(path)
      if (!entry) return
      deps.persist?.bind?.(childKey, entry)
      deps.persist?.save(entries)
      await deps.events.append('worktree-bound', { childKey, path, root: entry.root, branch: entry.branch })
    },

    async finish(ctx, _childKey, path): Promise<WorktreeFinishResult> {
      if (deps.persist) {
        for (const [key, value] of deps.persist.load()) entries.set(key, value)
      }
      const entry = entries.get(path)
      if (!entry) return { action: 'kept-inspection-failed' }
      if (deps.inUse?.(path)) return { action: 'kept-in-use' }
      const timeoutMs = boundedTimeout(ctx)

      if (entry.stage === 'attached') {
        let status: Awaited<ReturnType<ToolContext['exec']>>
        try {
          status = await ctx.exec(
            ['git', '-C', entry.path, 'status', '--porcelain=v1', '--untracked-files=all'],
            { cwd: entry.root, timeoutMs },
          )
        } catch {
          return { action: 'kept-inspection-failed' }
        }
        if (status.code !== 0 || status.truncated) return { action: 'kept-inspection-failed' }
        if (status.stdout.length !== 0) return { action: 'kept-dirty' }

        // Deliberately no --force: if the tree becomes dirty after inspection, Git must refuse
        // instead of deleting the raced-in work.
        let removed: Awaited<ReturnType<ToolContext['exec']>>
        try {
          removed = await ctx.exec(['git', 'worktree', 'remove', entry.path], {
            cwd: entry.root,
            timeoutMs,
          })
        } catch {
          return { action: 'cleanup-failed', stage: 'worktree-remove' }
        }
        if (removed.code !== 0) return { action: 'cleanup-failed', stage: 'worktree-remove' }
        entry.stage = 'worktree-removed'
        save()
      }

      // `-d`, never `-D`: a clean working tree can still contain unmerged child commits. Refusal
      // preserves the branch for parent review and a later finish call retries only this stage.
      let branch: Awaited<ReturnType<ToolContext['exec']>>
      try {
        branch = await ctx.exec(['git', 'branch', '-d', entry.branch], {
          cwd: entry.root,
          timeoutMs,
        })
      } catch {
        return { action: 'cleanup-failed', stage: 'branch-delete' }
      }
      if (branch.code !== 0) {
        if (/not fully merged|not merged/i.test(`${branch.stdout}\n${branch.stderr}`))
          return { action: 'kept-unmerged' }
        return { action: 'cleanup-failed', stage: 'branch-delete' }
      }

      entries.delete(path)
      save()
      return { action: 'removed' }
    },
  }
}
