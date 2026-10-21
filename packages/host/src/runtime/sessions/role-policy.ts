import { type RoleDelegation, readRoleDelegation, type SessionImpl } from '@agnes/core'
import type { PresetDoc } from '@agnes/host-common/presets/types'
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

/** The sandbox receives the snapshot's stricter access and isolation posture. */
export function roleWorkspacePreset(preset: PresetDoc, captured?: RoleDelegation): PresetDoc {
  if (!captured) return preset
  return {
    ...preset,
    providers: {
      ...((preset.providers as object) ?? {}),
      'tool-policy': { provider: captured.permission === 'read-only' ? 'read-only' : 'default' },
    },
    ...(captured.sandboxRequired
      ? {
          sandbox: {
            ...((preset.sandbox as object) ?? {}),
            level: 'L1',
            required: true,
            on_unavailable: 'deny',
          },
        }
      : {}),
  }
}
