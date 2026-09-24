import {
  createSessionAdmissionPort,
  MemorySessionPrincipalOwnership,
  MemorySessionWorkspaces,
  MemoryWorkspaceStore,
  type SessionAdmissionPort,
  WorkspaceCatalog,
} from '@agnes/daemon/local'
import { type Host, type HostSession, resolveWorkspaceDirectory } from '@agnes/host'

export async function memoryAdmission(host: Host, cwd: string) {
  const workspaces = new WorkspaceCatalog(
    new MemoryWorkspaceStore(),
    new MemorySessionWorkspaces(),
    resolveWorkspaceDirectory,
  )
  await workspaces.add(cwd)
  return createSessionAdmissionPort({
    ownership: new MemorySessionPrincipalOwnership(),
    workspaces,
    host,
    principalId: 'local',
  })
}

/** Reopen with the same catalog binding import used. cwd-only Host minting is a different authority. */
export async function openAdmittedSession(
  host: Host,
  admission: SessionAdmissionPort,
  key: string,
  cwd: string,
): Promise<HostSession> {
  const reserved = await admission.reserve(key, cwd)
  const session = await host.createSession({
    key,
    cwd: reserved.binding.canonicalRoot,
    binding: reserved.binding,
  })
  admission.activate(key, reserved.reservedNew)
  return session
}
