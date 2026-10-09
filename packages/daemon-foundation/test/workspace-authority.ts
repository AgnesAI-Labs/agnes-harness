import { MemorySessionWorkspaces } from '../src/storage/lister.js'
import {
  MemoryWorkspaceStore,
  type WorkspaceBindingEnvelope,
  WorkspaceCatalog,
} from '../src/storage/workspaces.js'

/** Explicit test authority: callers still register before asking for a session binding. */
export async function workspaceBinding(
  sessionKey: string,
  canonicalRoot = '/workspace',
): Promise<WorkspaceBindingEnvelope> {
  const catalog = new WorkspaceCatalog(
    new MemoryWorkspaceStore(),
    new MemorySessionWorkspaces(),
    async () => ({ path: canonicalRoot, name: canonicalRoot.split('/').at(-1) || canonicalRoot }),
  )
  await catalog.add(canonicalRoot)
  return catalog.authorizeAndBind(sessionKey, canonicalRoot)
}
