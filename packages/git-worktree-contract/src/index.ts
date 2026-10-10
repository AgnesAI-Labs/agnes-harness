import { defineServiceKind, type ServiceInstance, type ServicePorts } from '@agnes/extension-api'

/** Fixed grant. Only the bundled subagent may bind this kind. */
export const GIT_WORKTREE_OWNER = 'agnes/subagent'
export const GIT_WORKTREE_PACKAGE = '@agnes/base'
export const GIT_WORKTREE_PROVIDER_ID = 'agnes/git-worktree'
export const GIT_WORKTREE_PROVIDER_VERSION = '1.0.0'

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

/** Session identity comes from the admitted binding, never from the caller. */
export interface GitWorktreeRequest {
  readonly signal: AbortSignal
  readonly timeoutMs: number
}

export interface GitWorktreeInstance extends ServiceInstance {
  create(cwd: string, request: GitWorktreeRequest): Promise<WorktreeCreateResult>
  list(request: GitWorktreeRequest): Promise<readonly WorktreeEntry[]>
  finish(path: string, request: GitWorktreeRequest): Promise<WorktreeFinishResult>
}

/** One provider for each canonical workspace. Host is the only registrar. */
export const gitWorktreeKind = defineServiceKind<GitWorktreeInstance, ServicePorts>({
  kind: 'git-worktree',
  cardinality: 'single',
  instanceScope: 'workspace',
  scope: 'workspace',
  ports: [],
})
