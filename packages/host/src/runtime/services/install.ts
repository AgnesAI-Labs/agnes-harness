import type { Context } from '@agnes/cordis'
import { workspaceStateKind } from '@agnes/extension-api'
import type { RowOriginLookup } from '@agnes/plugin-runtime/host'
import type { ExtensionServiceHost } from './author-port.js'
import { installGitWorktreeService } from './git-worktrees.js'
import { installObservabilityService } from './observability-feed.js'

/** Generic host service descriptors; each registration keeps its existing lifecycle and grants. */
export function installHostServices(
  host: ExtensionServiceHost,
  root: Context,
  origins: RowOriginLookup,
  gitWorktrees: Parameters<typeof installGitWorktreeService>[3],
) {
  host.install(root, workspaceStateKind, { ports: [], audience: 'host' }, origins)
  installGitWorktreeService(host, root, origins, gitWorktrees)
  installObservabilityService(host, root, origins)
}
