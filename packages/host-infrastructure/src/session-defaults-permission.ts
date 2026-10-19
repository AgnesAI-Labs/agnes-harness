import type { SessionDefaults } from '@agnes/protocol'

/**
 * Before permission was its own default, an administrator picked a permission level by saving one of
 * the permission-level preset names as the default preset. Reading such a record yields the level as
 * `permission`; the next save writes it that way.
 */
export function permissionLevelDefaults(stored: SessionDefaults | undefined): SessionDefaults {
  const defaults = structuredClone(stored ?? {})
  const { preset, ...rest } = defaults
  if (preset !== 'read-only' && preset !== 'workspace-write' && preset !== 'full-access') return defaults
  return { ...rest, permission: defaults.permission ?? preset }
}
