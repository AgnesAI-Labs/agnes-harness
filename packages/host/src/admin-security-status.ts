import type { RuntimeSecurityStatus } from '@agnes/protocol'
import type { PlatformBackend } from './adapters/platform.js'
import type { HostSession } from './host.js'
import { resolvePreset } from './presets/resolve.js'
import type { PresetDoc } from './presets/types.js'
import type { ResolvedProfile } from './profile/types.js'
import type { SessionWorkspaceRuntimeTable } from './session-workspace-runtime.js'
import { normalizeSandboxStaticConfig } from './workspace-policy.js'

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
