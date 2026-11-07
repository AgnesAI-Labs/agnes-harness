import { isHostError } from '@agnes/host-common/errors'
import { allowedPermissions } from '@agnes/host-common/presets/admission'
import { overlayName, type Permission } from '@agnes/host-common/presets/permission'
import { presetProvider } from '@agnes/host-common/presets/provider'
import { resolvePreset } from '@agnes/host-common/presets/resolve'
import type { PresetDoc } from '@agnes/host-common/presets/types'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import type { PlatformBackend } from '@agnes/host-infrastructure/adapters/platform'
import type { SessionWorkspaceRuntimeTable } from '@agnes/host-infrastructure/session-workspace-runtime'
import { RELEASE_DEFAULTS } from '@agnes/package-manager'
import type { RuntimeSecurityStatus } from '@agnes/protocol'
import { requestedSandboxConfig } from '../assemble/workspace-readiness.js'
import { windowsPolicyBoundary } from '../assemble/workspace-windows-acl.js'
import type { HostSession } from './host.js'

type WorkspaceStatus = RuntimeSecurityStatus['workspaces'][number]

/** What a session's commands may change, read from its tool policy the way its sandbox config is. */
const sessionAccess = (session: HostSession): NonNullable<WorkspaceStatus['access']> => {
  const policy = session.preset.approval.policy
  return policy === 'read-only' ? 'read-only' : policy === 'full-access' ? 'full-access' : 'workspace-write'
}

/** What a recipe, or a recipe under one permission level, grants: sandbox, approval policy, network. */
function securityPolicy(
  id: string,
  presets: Record<string, PresetDoc>,
  profile: ResolvedProfile,
  adapters: Readonly<{ platform: { os: string }; transport?: unknown }>,
  permission?: Permission,
) {
  const providerId = profile.sandbox?.provider ?? 'local'
  // A permission level is shown on the standard recipe; a recipe is shown under its own level.
  const doc = resolvePreset(permission ? 'standard' : id, presets, {
    limits: profile.limits,
    ...(permission ? { permission } : {}),
  }).doc
  // The config a session on this Host runs under, including a loopback request it cannot serve.
  const sandbox = requestedSandboxConfig(doc, adapters, providerId === RELEASE_DEFAULTS.sandboxProvider)
  // On a local Windows Host the opted-in levels run under the partial contract: reads and network open.
  const boundary = windowsPolicyBoundary(sandbox, providerId, RELEASE_DEFAULTS.sandboxProvider)
  return {
    id,
    level: sandbox.level,
    required: sandbox.required,
    onUnavailable: sandbox.onUnavailable,
    approvalPolicy: presetProvider(doc, 'tool-policy') ?? 'default',
    networkMode:
      sandbox.level === 'L0' || boundary
        ? ('unrestricted' as const)
        : sandbox.loopbackServe
          ? ('loopback-serve' as const)
          : sandbox.networkAllow.length
            ? ('allow-list' as const)
            : ('deny' as const),
    ...(boundary ? { boundary: { ...boundary } } : {}),
  }
}

export function adminSecurityStatus(
  profile: ResolvedProfile,
  platform: PlatformBackend,
  presets: Record<string, PresetDoc>,
  sessions: Iterable<HostSession>,
  workspaces: SessionWorkspaceRuntimeTable,
  /** The Host's remote transport, when commands run on another machine. */
  transport?: unknown,
): RuntimeSecurityStatus {
  const l1 = platform.capability('sandbox.l1')
  // The same Host facts the workspace runtime derives its sandbox config from.
  const target = { platform, ...(transport === undefined ? {} : { transport }) }
  return {
    platform: {
      os: platform.os,
      // Before a workspace binds, l1 holds a placeholder, not a failed probe: report it as unknown.
      l1: platform.sandboxProbed()
        ? {
            level: l1.level,
            scope: [...l1.scope],
            ...(l1.reason ? { reason: l1.reason.slice(0, 1024) } : {}),
          }
        : { level: 'unprobed', scope: [] },
    },
    presetPolicies: profile.presets.allowed.map((id) => securityPolicy(id, presets, profile, target)),
    // A catalogue without the permission documents (a hand-built one) has nothing to describe.
    permissionPolicies: allowedPermissions(profile)
      .filter((permission) => presets[overlayName(permission)] !== undefined)
      .flatMap((permission) => {
        try {
          return [securityPolicy(permission, presets, profile, target, permission)]
        } catch (error) {
          // Fixed-policy recipes and required isolation can refuse an overlay. Reporting that
          // unavailable choice must not fail the status read or relax session admission.
          if (isHostError(error, 'E_PRESET_UNSUPPORTED') && error.detail?.reason === 'permission-axis')
            return []
          throw error
        }
      }),
    workspaces: [...sessions].map((session) => {
      const workspace = workspaces.securityStatus(session.key)
      return {
        sessionId: session.key,
        path: workspace?.root ?? session.workspaceRoot,
        preset: session.preset.name,
        ...(session.preset.permission ? { permission: session.preset.permission } : {}),
        access: sessionAccess(session),
        provider: profile.sandbox?.provider ?? 'local',
        state: workspace?.state ?? 'unavailable',
        ...(workspace?.policyDigest ? { policyDigest: workspace.policyDigest } : {}),
        ...(workspace?.enforcement
          ? {
              enforcement: {
                level: workspace.enforcement.level,
                scope: [...workspace.enforcement.scope],
                ...(workspace.enforcement.boundary
                  ? { boundary: { ...workspace.enforcement.boundary } }
                  : {}),
              },
            }
          : {}),
      }
    }),
  }
}

const L1_STRENGTH = { unavailable: 0, partial: 1, full: 2 } as const

/**
 * One status for a Host made of several Hosts. Each Host measures the sandbox on its own platform
 * backend when it binds a workspace, so the Host that answers for the profile (the initial or head
 * one) may never have probed while the Host running a session has. The platform answer is therefore
 * the weakest measured one across all of them, and `unprobed` only when none has measured yet;
 * workspaces are those of the given Hosts.
 */
export function combinedSecurityStatus(
  head: RuntimeSecurityStatus,
  hosts: readonly RuntimeSecurityStatus[],
): RuntimeSecurityStatus {
  let l1 = head.platform.l1
  for (const status of [head, ...hosts]) {
    const candidate = status.platform.l1
    if (candidate.level === 'unprobed') continue
    if (l1.level === 'unprobed' || L1_STRENGTH[candidate.level] < L1_STRENGTH[l1.level]) l1 = candidate
  }
  return {
    ...head,
    platform: { ...head.platform, l1 },
    workspaces: hosts.flatMap((status) => status.workspaces),
  }
}
