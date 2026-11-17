import {
  type Enforcement,
  type RoleAuthority,
  type RoleDelegation,
  readRoleDelegation,
  type SessionImpl,
} from '@agnes/core'
import type { PresetDoc } from '@agnes/host-common/presets/types'
import { isWindowsWriteBoundary } from '@agnes/host-infrastructure/windows-acl/policy'
import type { CreateSessionOptions } from './session.js'

/** Restore the trusted captured policy before any workspace authority is opened. */
export async function restoreRolePolicy(
  storage: SessionImpl['d']['log']['storage'],
  options: CreateSessionOptions,
): Promise<CreateSessionOptions> {
  const key = options.key ?? options.binding?.sessionKey
  if (!key) return options
  const captured = await readRoleDelegation(storage, key)
  return captured ? { ...options, roleDelegation: captured } : options
}

/**
 * What a role child must keep of its parent's command boundary. A file fence is not an OS boundary:
 * confinement is preserved unless the Host already admitted this local file-only parent through the
 * explicit unconfined fallback. A local parent under the Windows write restriction passes that
 * restriction on instead of a full-isolation requirement, which Windows cannot meet: the child
 * runs under at least the same restriction, and its own stronger requirements still refuse it.
 */
export function roleSandboxConstraint(input: {
  sandbox: Readonly<{ local: boolean; allowsUnconfined?: boolean }>
  enforcement: Enforcement
  parentSandboxRequired: boolean
}): Pick<RoleDelegation, 'sandboxRequired' | 'windowsWriteRestricted'> {
  const { sandbox, enforcement } = input
  const unconfined =
    sandbox.local &&
    sandbox.allowsUnconfined === true &&
    enforcement.level === 'partial' &&
    enforcement.boundary === undefined &&
    enforcement.scope.length === 1 &&
    enforcement.scope[0] === 'file'
  const windowsWriteRestricted =
    !input.parentSandboxRequired &&
    sandbox.local &&
    enforcement.level === 'partial' &&
    isWindowsWriteBoundary(enforcement.boundary)
  if (windowsWriteRestricted) return { sandboxRequired: false, windowsWriteRestricted: true }
  return {
    sandboxRequired: input.parentSandboxRequired || (enforcement.level !== 'none' && !unconfined),
  }
}

/** The sandbox receives the snapshot's stricter access and isolation posture. */
export function roleWorkspacePreset(preset: PresetDoc, authority?: RoleAuthority): PresetDoc {
  if (!authority) return preset
  return {
    ...preset,
    providers: {
      ...((preset.providers as object) ?? {}),
      'tool-policy': { provider: authority.permission === 'read-only' ? 'read-only' : 'default' },
    },
    ...(authority.sandboxRequired
      ? {
          sandbox: {
            ...((preset.sandbox as object) ?? {}),
            level: 'L1',
            required: true,
            on_unavailable: 'deny',
          },
        }
      : authority.windowsWriteRestricted
        ? { sandbox: windowsRestrictedSandbox(preset.sandbox) }
        : {}),
  }
}

/**
 * The role's own sandbox, opted into the Windows write restriction its parent ran under. An L1
 * request keeps its own `on_unavailable`; a lower one becomes the conditional L1 request the
 * official presets use. Every other setting stays the role's, so a stronger requirement still refuses.
 */
function windowsRestrictedSandbox(sandbox: unknown): Record<string, unknown> {
  const own = (sandbox as Record<string, unknown> | undefined) ?? {}
  return {
    ...own,
    level: 'L1',
    ...(own.level === 'L1' ? {} : { on_unavailable: 'allow-if-unimplemented' }),
    windows_mode: 'write-restricted',
  }
}
