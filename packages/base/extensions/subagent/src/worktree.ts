import type {
  GitWorktreeService,
  ToolContext,
  WorktreeCreateResult,
  WorktreeEntry,
  WorktreeFinishResult,
} from '@agnes/extension-api'
import type { JsonValue } from '@agnes/protocol'

export type {
  WorktreeCreateResult,
  WorktreeEntry,
  WorktreeFinishResult,
  WorktreeSkipReason,
} from '@agnes/extension-api'
export type WorktreeManager = {
  create(ctx: ToolContext): Promise<WorktreeCreateResult>
  finish(ctx: ToolContext, childKey: string, path: string): Promise<WorktreeFinishResult>
  list?(ctx: ToolContext): Promise<readonly WorktreeEntry[]>
  bind?(childKey: string, path: string): Promise<void>
}
export type GitWorktreeDeps = {
  service?: GitWorktreeService
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
  const operation = (ctx: ToolContext) => ({
    sessionKey: ctx.session.key,
    signal: ctx.signal,
    timeoutMs: ctx.timeoutMs,
  })
  return {
    async create(ctx) {
      let result: WorktreeCreateResult
      try {
        result = deps.service ? await deps.service.create(ctx.cwd, operation(ctx)) : { skipped: 'git-error' }
      } catch {
        result = { skipped: 'git-error' }
      }
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
      try {
        const result = deps.service ? await deps.service.list(operation(ctx)) : []
        await deps.events.append('worktree-listed', { paths: result.map((entry) => entry.path) })
        return result
      } catch (error) {
        await deps.events.append('worktree-skipped', { reason: 'git-error', operation: 'list' })
        throw error
      }
    },
    async bind(childKey, path) {
      const entry = entries.get(path) ?? deps.persist?.load().get(path)
      if (!entry) throw new Error('worktree binding requires a created entry')
      deps.persist?.bind?.(childKey, entry)
      await deps.events.append('worktree-bound', { childKey, path, root: entry.root, branch: entry.branch })
    },
    async finish(ctx, childKey, path) {
      let result: WorktreeFinishResult
      try {
        result = deps.inUse?.(path)
          ? { action: 'kept-in-use' }
          : deps.service
            ? await deps.service.finish(path, operation(ctx))
            : { action: 'kept-inspection-failed' }
      } catch {
        result = { action: 'kept-inspection-failed' }
      }
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
