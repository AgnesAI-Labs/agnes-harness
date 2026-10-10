import type { ToolContext } from '@agnes/extension-api'
import type {
  GitWorktreeInstance,
  GitWorktreeRequest,
  WorktreeCreateResult,
  WorktreeEntry,
  WorktreeFinishResult,
} from '@agnes/git-worktree-contract'
import type { JsonValue } from '@agnes/protocol'

export type {
  WorktreeCreateResult,
  WorktreeEntry,
  WorktreeFinishResult,
  WorktreeSkipReason,
} from '@agnes/git-worktree-contract'
export type WorktreeManager = {
  create(ctx: ToolContext): Promise<WorktreeCreateResult>
  finish(ctx: ToolContext, childKey: string, path: string): Promise<WorktreeFinishResult>
  list?(ctx: ToolContext): Promise<readonly WorktreeEntry[]>
  bind?(childKey: string, path: string): Promise<void>
}
export type GitWorktreeDeps = {
  open?: () => Promise<GitWorktreeInstance>
  events: { append(name: string, data: JsonValue): Promise<number> }
  persist?: {
    load(): Map<string, WorktreeEntry>
    save(entries: Map<string, WorktreeEntry>): void
    bind?(childKey: string, entry: WorktreeEntry): void
  }
  inUse?: (path: string) => boolean
}

/** Child binding and facts use public ports; Git metadata stays under Host authority. */
export function gitWorktrees(deps: GitWorktreeDeps): WorktreeManager {
  const entries = deps.persist?.load() ?? new Map<string, WorktreeEntry>()
  const request = (ctx: ToolContext): GitWorktreeRequest => ({
    signal: ctx.signal,
    timeoutMs: ctx.timeoutMs,
  })
  const release = async (instance: GitWorktreeInstance | undefined): Promise<void> => {
    try {
      await instance?.dispose?.()
    } catch {
      // A closed generation must not replace the operation result.
    }
  }
  const opened = async <T>(
    fallback: T,
    invoke: (instance: GitWorktreeInstance) => Promise<T>,
  ): Promise<T> => {
    if (!deps.open) return fallback
    let instance: GitWorktreeInstance | undefined
    try {
      instance = await deps.open()
      return await invoke(instance)
    } catch {
      return fallback
    } finally {
      await release(instance)
    }
  }
  return {
    async create(ctx) {
      const result = await opened<WorktreeCreateResult>({ skipped: 'git-error' }, (instance) =>
        instance.create(ctx.cwd, request(ctx)),
      )
      if ('skipped' in result) {
        await deps.events.append('worktree-skipped', { reason: result.skipped })
      } else {
        entries.set(result.path, {
          root: result.root,
          path: result.path,
          branch: result.branch,
          stage: 'attached',
        })
        deps.persist?.save(entries)
        await deps.events.append('worktree-created', { ...result })
      }
      return result
    },
    async list(ctx) {
      if (!deps.open) {
        await deps.events.append('worktree-listed', { paths: [] })
        return []
      }
      let instance: GitWorktreeInstance | undefined
      try {
        instance = await deps.open()
        const result = await instance.list(request(ctx))
        await deps.events.append('worktree-listed', { paths: result.map((entry) => entry.path) })
        return result
      } catch (error) {
        await deps.events.append('worktree-skipped', { reason: 'git-error', operation: 'list' })
        throw error
      } finally {
        await release(instance)
      }
    },
    async bind(childKey, path) {
      const entry = entries.get(path) ?? deps.persist?.load().get(path)
      if (!entry) throw new Error('worktree binding requires a created entry')
      deps.persist?.bind?.(childKey, entry)
      await deps.events.append('worktree-bound', { childKey, path, root: entry.root, branch: entry.branch })
    },
    async finish(ctx, childKey, path) {
      const result = deps.inUse?.(path)
        ? { action: 'kept-in-use' as const }
        : await opened<WorktreeFinishResult>({ action: 'kept-inspection-failed' }, (instance) =>
            instance.finish(path, request(ctx)),
          )
      if (
        result.action === 'kept-unmerged' ||
        (result.action === 'cleanup-failed' && result.stage === 'branch-delete')
      ) {
        await deps.events.append('worktree-removed', { childKey, path, branchRetained: true })
      }
      if (result.action === 'removed') {
        entries.delete(path)
        deps.persist?.save(entries)
        await deps.events.append('worktree-removed', { childKey, path })
      } else {
        await deps.events.append('worktree-cleanup-skipped', { childKey, path, ...result })
      }
      return result
    },
  }
}
