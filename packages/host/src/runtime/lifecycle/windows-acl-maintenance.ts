// Maintenance of the Windows ACL grants and of the sessions bound to a workspace, outside any Host:
// a Host would hold leases on the grants it inspects. Inspecting changes nothing; repairing and
// confirming a workspace happen only when the caller asks for them.
import type {
  WindowsAclRepairRequest,
  WindowsAclReport,
  WindowsExecutionAuthority,
} from '@agnes/host-infrastructure/windows-acl/authority'
import { createWindowsAclMaintenanceAuthority } from '@agnes/host-infrastructure/windows-acl/host-platform'
import { SessionSandboxStore } from '@agnes/host-providers/profile/sandbox-state'
import type { WindowsObjectIdentity } from '@agnes/system-node/windows-acl'

export type { WindowsAclRepairRequest, WindowsAclReport }

export type WindowsAclMaintenance = Readonly<{
  /** What AGH recorded for the root against the permissions it has now; read-only. */
  inspect(root: string): Promise<WindowsAclReport>
  /** Removes exactly AGH's own increments of the inspected grant, or refuses with the reason. */
  repair(request: WindowsAclRepairRequest): Promise<WindowsAclReport>
  /** Sessions saved at this root whose directory there is now another object. */
  replacedWorkspaces(root: string): Promise<readonly string[]>
  /** Records the user's confirmation that the directory now at the root is the session's workspace. */
  confirmWorkspace(root: string, sessionKey: string): Promise<void>
  close(): Promise<void>
}>

const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const sameIdentity = (a: WindowsObjectIdentity | undefined, b: WindowsObjectIdentity) =>
  a?.volumeId === b.volumeId && a.fileId === b.fileId

export function windowsAclMaintenance(input: {
  authority: Pick<WindowsExecutionAuthority, 'inspect' | 'repair' | 'dispose'>
  store: Pick<SessionSandboxStore, 'windowsWorkspaces' | 'confirmWindowsWorkspace'>
  canonicalPath(path: string): Promise<string>
  rootIdentity(path: string): Promise<WindowsObjectIdentity>
}): WindowsAclMaintenance {
  const { authority, store } = input
  // Windows paths compare without case, as the Host bound them.
  const bindingsAt = async (root: string) => {
    const canonical = await input.canonicalPath(root)
    return {
      canonical,
      bindings: store.windowsWorkspaces().filter((item) => samePath(item.workspaceRoot, canonical)),
    }
  }
  return Object.freeze({
    inspect: (root: string) => authority.inspect(root),
    repair: (request: WindowsAclRepairRequest) => authority.repair(request),
    replacedWorkspaces: async (root: string) => {
      const { canonical, bindings } = await bindingsAt(root)
      if (bindings.length === 0) return []
      const identity = await input.rootIdentity(canonical)
      return bindings
        .filter((item) => item.rootIdentity !== undefined && !sameIdentity(item.rootIdentity, identity))
        .map((item) => item.sessionKey)
    },
    confirmWorkspace: async (root: string, sessionKey: string) => {
      const { canonical, bindings } = await bindingsAt(root)
      const binding = bindings.find((item) => item.sessionKey === sessionKey)
      if (!binding)
        throw Object.assign(new Error('E_SANDBOX_WORKSPACE: the session is not bound to this workspace'), {
          code: 'E_SANDBOX_WORKSPACE',
        })
      store.confirmWindowsWorkspace(sessionKey, {
        workspaceRoot: binding.workspaceRoot,
        rootIdentity: await input.rootIdentity(canonical),
      })
    },
    close: () => authority.dispose(),
  })
}

/** The production maintenance of a local Windows account; only Windows has the native primitives. */
export async function openWindowsAclMaintenance(input: {
  profileDir: string
  localAppData: string
  pid: number
}): Promise<WindowsAclMaintenance> {
  const { authority, platform } = await createWindowsAclMaintenanceAuthority(input)
  return windowsAclMaintenance({
    authority,
    store: new SessionSandboxStore(input.profileDir),
    canonicalPath: platform.canonicalPath,
    rootIdentity: platform.rootIdentity,
  })
}
