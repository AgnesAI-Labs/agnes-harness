import { lstat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { openDaemonScheduleDb } from '@agnes/base/schedule'
import type { SessionWorkspacePort } from '@agnes/daemon-foundation/storage/lister'
import {
  type LegacyScheduleSnapshot,
  ManagedChatAuthority,
  type ManagedChatRoots,
} from '@agnes/daemon-foundation/storage/managed-chat-authority'
import type { Tables } from '@agnes/daemon-foundation/storage/table'
import {
  MemoryWorkspaceBindings,
  MemoryWorkspaceStore,
  WorkspaceBindingIndex,
  WorkspaceCatalog,
  WorkspaceIndex,
} from '@agnes/daemon-foundation/storage/workspaces'
import { resolveDocumentsDirectory, resolveWorkspaceDirectory } from '@agnes/host'
import { ManagedChatRootError, prepareManagedChatRoot } from './managed-chat-root.js'

/** Configured daemon/worker private boundaries; never infer the installation from process HOME. */
export function managedChatPrivateRoots(input: {
  ownerHome: string
  dataDir: string
  profileDir: string
  profileFile: string
  secretsDirectory?: string
}): string[] {
  // The worker policy derives these leaves from its actual profile directory, even for an
  // unconventional profile location. Include that same policy surface as well as the full owner home.
  const workerHome = dirname(dirname(input.profileDir))
  return [
    ...new Set([
      input.ownerHome,
      input.dataDir,
      input.profileDir,
      dirname(input.profileFile),
      ...['secrets', 'auth', 'profiles', 'daemon', 'memory'].map((leaf) => join(workerHome, leaf)),
      ...(input.secretsDirectory ? [input.secretsDirectory] : []),
    ]),
  ]
}

/** Server-owned snapshot; callers invoke this before schedule mutation and dispatch are opened. */
export function readLegacyChatSchedules(tables: Pick<Tables, 'table'> | undefined): LegacyScheduleSnapshot[] {
  const db = tables ? openDaemonScheduleDb(tables.table('schedules')) : undefined
  if (!db?.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schedules'")) return []
  return db
    .all<{ id: string; target: string | null; revision: number }>(
      "SELECT id,target,revision FROM schedules WHERE status != 'archived'",
    )
    .flatMap((row) => {
      if (!row.target) return []
      const target: unknown = JSON.parse(row.target)
      return target &&
        typeof target === 'object' &&
        'kind' in target &&
        target.kind === 'new-session' &&
        'cwd' in target &&
        typeof target.cwd === 'string'
        ? [{ scheduleId: row.id, targetRoot: target.cwd, revision: row.revision }]
        : []
    })
}

/** Opens provenance before admitting sessions or schedule mutations. Current-root failure is isolated. */
export async function openWorkspaceCatalog(input: {
  dataDir: string
  ownerHome: string
  privateRoots?: readonly string[]
  tables: Pick<Tables, 'table'> | undefined
  sessions: SessionWorkspacePort
  clock: () => number
  workspaceRoot: string | undefined
  legacySchedules?: readonly LegacyScheduleSnapshot[]
  documentsDirectory?: () => Promise<string>
}): Promise<WorkspaceCatalog> {
  const { tables } = input
  const protectedRoots = [
    input.ownerHome,
    input.dataDir,
    ...(input.privateRoots ?? []),
    join(homedir(), '.ssh'),
  ]
  const bindings = tables
    ? new WorkspaceBindingIndex(tables.table('workspace_bindings'))
    : new MemoryWorkspaceBindings()
  const snapshot = bindings.keys().flatMap((key) => {
    const binding = bindings.get(key)
    return binding ? [binding] : []
  })
  const requestedLegacy = join(input.dataDir, 'chats')
  // Do not create a missing historical directory, even when a binding still points to it.
  let legacyRoot = requestedLegacy
  try {
    legacyRoot = await realpath(requestedLegacy)
  } catch {
    /* Stale historical rows remain unavailable. */
  }
  const hasHistory =
    snapshot.some((binding) => binding.canonicalRoot === legacyRoot) ||
    input.legacySchedules?.some((schedule) => schedule.targetRoot === legacyRoot)
  const roots: ManagedChatRoots = { ...(hasHistory ? { legacy: legacyRoot } : {}) }
  const authority = new ManagedChatAuthority(tables?.table('managed_chat_authority'), bindings, legacyRoot)
  let legacyDirectoryIdentity: string | null = null
  try {
    const info = await lstat(legacyRoot, { bigint: true })
    if (info.isDirectory() && !info.isSymbolicLink() && (await realpath(legacyRoot)) === legacyRoot)
      legacyDirectoryIdentity = `${info.dev}:${info.ino}`
  } catch {
    /* Missing history remains unavailable. */
  }
  await authority.initialize({
    bindings: snapshot,
    schedules: input.legacySchedules ?? [],
    legacyDirectoryIdentity,
  })
  try {
    roots.current = (
      await prepareManagedChatRoot({
        dataDir: input.dataDir,
        privateRoots: protectedRoots,
        documentsDirectory:
          input.documentsDirectory ?? (() => resolveDocumentsDirectory(AbortSignal.timeout(6000))),
      })
    ).root
  } catch (error) {
    roots.currentError = { code: (error as { code?: string }).code ?? 'MANAGED_CHAT_ROOT_UNAVAILABLE' }
    if (error instanceof ManagedChatRootError && error.registeredRoot)
      roots.current = error.registeredRoot.root
  }
  const resolve = async (path: string) => {
    if (roots.currentError && path === roots.current)
      throw new Error('registered current chats root failed verification')
    if (path === legacyRoot) {
      const info = await lstat(path, { bigint: true })
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (await realpath(path)) !== legacyRoot ||
        `${info.dev}:${info.ino}` !== authority.legacyDirectoryIdentity
      )
        throw new Error('legacy chats root no longer matches its registered directory')
    }
    const directory = await resolveWorkspaceDirectory(path)
    if (roots.currentError && directory.path === roots.current)
      throw new Error('registered current chats root failed verification')
    return directory
  }
  const catalog = new WorkspaceCatalog(
    tables ? new WorkspaceIndex(tables.table('workspace_registry')) : new MemoryWorkspaceStore(),
    input.sessions,
    resolve,
    input.clock,
    bindings,
    roots,
    { protectedRoots },
    authority,
  )
  if (input.workspaceRoot) await catalog.add(input.workspaceRoot)
  if (roots.current && !roots.currentError) await catalog.add(roots.current)
  if (roots.legacy) {
    try {
      await catalog.add(roots.legacy)
    } catch {
      /* Keep the original registry and bindings; list reports unavailable. */
    }
  }
  return catalog
}
