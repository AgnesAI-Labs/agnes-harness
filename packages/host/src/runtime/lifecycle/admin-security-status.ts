import { presetProvider } from '@agnes/host-common/presets/provider'
import { resolvePreset } from '@agnes/host-common/presets/resolve'
import type { PresetDoc } from '@agnes/host-common/presets/types'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { normalizeSandboxStaticConfig } from '@agnes/host-common/workspace-policy'
import type { PlatformBackend } from '@agnes/host-infrastructure/adapters/platform'
import type { SessionWorkspaceRuntimeTable } from '@agnes/host-infrastructure/session-workspace-runtime'
import type { RuntimeSecurityStatus } from '@agnes/protocol'
import type { HostSession } from './host.js'

export function adminSecurityStatus(
  profile: ResolvedProfile,
  platform: PlatformBackend,
  presets: Record<string, PresetDoc>,
  sessions: Iterable<HostSession>,
  workspaces: SessionWorkspaceRuntimeTable,
): RuntimeSecurityStatus {
  const l1 = platform.capability('sandbox.l1')
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
    presetPolicies: profile.presets.allowed.map((id) => {
      const doc = resolvePreset(id, presets, { limits: profile.limits }).doc
      const sandbox = normalizeSandboxStaticConfig(doc)
      const approvalPolicy = presetProvider(doc, 'tool-policy') ?? 'default'
      return {
        id,
        level: sandbox.level,
        required: sandbox.required,
        onUnavailable: sandbox.onUnavailable,
        approvalPolicy,
        networkMode:
          sandbox.level === 'L0'
            ? ('unrestricted' as const)
            : sandbox.networkAllow.length
              ? ('allow-list' as const)
              : ('deny' as const),
      }
    }),
    workspaces: [...sessions].map((session) => {
      const workspace = workspaces.securityStatus(session.key)
      return {
        sessionId: session.key,
        path: workspace?.root ?? session.workspaceRoot,
        preset: session.preset.name,
        provider: profile.sandbox?.provider ?? 'local',
        state: workspace?.state ?? 'unavailable',
        ...(workspace?.policyDigest ? { policyDigest: workspace.policyDigest } : {}),
        ...(workspace?.enforcement
          ? {
              enforcement: {
                level: workspace.enforcement.level,
                scope: [...workspace.enforcement.scope],
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
