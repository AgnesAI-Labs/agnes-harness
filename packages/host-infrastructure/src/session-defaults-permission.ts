import { HostError } from '@agnes/host-common/errors'
import { isPermission } from '@agnes/host-common/presets/permission'
import type { SessionDefaults } from '@agnes/protocol'

/** Saved defaults use the current recipe and permission fields without conversion. */
export function permissionLevelDefaults(stored: SessionDefaults | undefined): SessionDefaults {
  if (isPermission(stored?.preset))
    throw new HostError(
      'E_PRESET_UNSUPPORTED',
      'Retired permission-as-preset default; select a new, empty AGH_HOME (clean home).',
      { detail: { reason: 'clean-home-required' } },
    )
  return structuredClone(stored ?? {})
}
