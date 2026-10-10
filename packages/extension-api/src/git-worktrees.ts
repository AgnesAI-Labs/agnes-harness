/** Host-owned Git metadata operations. Never exposed as an agent exec capability. */
export type WorktreeSkipReason = 'not-git' | 'remote-sandbox' | 'git-error'
export type WorktreeCreateResult =
  | { id: string; root: string; path: string; branch: string }
  | { skipped: WorktreeSkipReason }
export type WorktreeFinishResult =
  | { action: 'removed' | 'kept-dirty' | 'kept-unmerged' | 'kept-inspection-failed' | 'kept-in-use' }
  | { action: 'cleanup-failed'; stage: 'worktree-remove' | 'branch-delete' }
export type WorktreeEntry = {
  root: string
  path: string
  branch: string
  stage: 'attached' | 'worktree-removed'
}
export type GitWorktreeOperation = { sessionKey: string; signal: AbortSignal; timeoutMs: number }
export interface GitWorktreeService {
  /** Host generates the branch and target; cwd must belong to the bound workspace. */
  create(cwd: string, operation: GitWorktreeOperation): Promise<WorktreeCreateResult>
  /** Only registered worktrees created by this service, never foreign entries. */
  list(operation: GitWorktreeOperation): Promise<readonly WorktreeEntry[]>
  /** No force, merge or global prune. Ownership survives Host restart. */
  finish(path: string, operation: GitWorktreeOperation): Promise<WorktreeFinishResult>
}
