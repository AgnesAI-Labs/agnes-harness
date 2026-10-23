import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionWorkspacePort } from '@agnes/daemon-foundation/storage/lister'
import type { Tables } from '@agnes/daemon-foundation/storage/table'
import {
  MemoryWorkspaceBindings,
  MemoryWorkspaceStore,
  WorkspaceBindingIndex,
  WorkspaceCatalog,
  WorkspaceIndex,
} from '@agnes/daemon-foundation/storage/workspaces'
import { createPlatform, resolveWorkspaceDirectory } from '@agnes/host'
import { windowsEnsurePrivateDirectorySync } from '@agnes/system-node'

/** Opens the daemon workspace authority and registers the startup root and the managed chats root. */
export async function openWorkspaceCatalog(input: {
  dataDir: string
  tables: Pick<Tables, 'table'> | undefined
  sessions: SessionWorkspacePort
  clock: () => number
  workspaceRoot: string | undefined
}): Promise<WorkspaceCatalog> {
  // Chats without a project share one private daemon-managed workspace under the data directory.
  const chatsDirectory = join(input.dataDir, 'chats')
  if (createPlatform().snapshot().os === 'win32') windowsEnsurePrivateDirectorySync(chatsDirectory)
  else await mkdir(chatsDirectory, { recursive: true, mode: 0o700 })
  const chatsRoot = (await resolveWorkspaceDirectory(chatsDirectory)).path
  const { tables } = input
  const catalog = new WorkspaceCatalog(
    tables ? new WorkspaceIndex(tables.table('workspace_registry')) : new MemoryWorkspaceStore(),
    input.sessions,
    resolveWorkspaceDirectory,
    input.clock,
    tables ? new WorkspaceBindingIndex(tables.table('workspace_bindings')) : new MemoryWorkspaceBindings(),
    chatsRoot,
  )
  // The CLI/launcher supplied startup root is one of the workspace catalog's two authority sources. Register it
  // once before resource-control resolves its default workspace; ambient cwd never grants this.
  if (input.workspaceRoot) await catalog.add(input.workspaceRoot)
  await catalog.add(chatsRoot)
  return catalog
}
