import type { Context } from '@agnes/cordis'
import {
  GIT_WORKTREE_OWNER,
  GIT_WORKTREE_PACKAGE,
  GIT_WORKTREE_PROVIDER_ID,
  GIT_WORKTREE_PROVIDER_VERSION,
  type GitWorktreeInstance,
  type GitWorktreeRequest,
  gitWorktreeKind,
} from '@agnes/git-worktree-contract'
import type { GitWorktreeService } from '@agnes/host-infrastructure/git-worktrees'
import type { RowOriginLookup } from '@agnes/plugin-runtime/host'
import type { ExtensionServiceHost } from './author-port.js'

/** Host is the only registrar. Plugins cannot register this kind. */
export function installGitWorktreeService(
  host: ExtensionServiceHost,
  root: Context,
  origins: RowOriginLookup | undefined,
  service: GitWorktreeService,
): void {
  host.install(root, gitWorktreeKind, { ports: [], audience: 'callback' }, origins)
  host.registerOn(
    root,
    gitWorktreeKind,
    {
      id: GIT_WORKTREE_PROVIDER_ID,
      version: GIT_WORKTREE_PROVIDER_VERSION,
      open(ports): GitWorktreeInstance {
        const sessionKey = ports.binding.session?.key
        if (
          ports.binding.owner !== GIT_WORKTREE_OWNER ||
          ports.binding.packageId !== GIT_WORKTREE_PACKAGE ||
          !sessionKey
        )
          throw new Error('git worktree binding is closed')
        const operation = (request: GitWorktreeRequest) => ({
          sessionKey,
          signal: request.signal,
          timeoutMs: request.timeoutMs,
        })
        return {
          create: (cwd, request) => service.create(cwd, operation(request)),
          list: (request) => service.list(operation(request)),
          finish: (path, request) => service.finish(path, operation(request)),
        }
      },
    },
    { owner: GIT_WORKTREE_OWNER, packageId: GIT_WORKTREE_PACKAGE },
  )
}
