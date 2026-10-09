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
      l1: {
        level: l1.level,
        scope: [...l1.scope],
        ...(l1.reason ? { reason: l1.reason.slice(0, 1024) } : {}),
      },
    },
    presetPolicies: profile.presets.allowed.map((id) => {
      const doc = resolvePreset(id, presets, { limits: profile.limits }).doc
      const sandbox = normalizeSandboxStaticConfig(doc)
      const approval = doc.approval
      const approvalPolicy =
        approval &&
        typeof approval === 'object' &&
        'policy' in approval &&
        typeof approval.policy === 'string'
          ? approval.policy
          : 'default'
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
        path: workspace?.root ?? session.d.cwd,
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
