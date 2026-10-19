import { HostError } from '@agnes/host-common/errors'
import {
  FOLLOW_DEFAULT_PERMISSION,
  isPermission,
  type Permission,
} from '@agnes/host-common/presets/permission'

/**
 * The options a stored session reopens with: the recipe it is on now, and the level it started under.
 * The recorded level is a soft default, so a session that switched to a recipe fixing its own
 * permission table (and passed the sandbox comparison) still opens. Asking for another level than the
 * recorded one is a conflict, as it is for the recipe, and not silently ignored.
 */
export function reopenSelection<T extends { permission?: string; defaultPermission?: Permission }>(
  o: T,
  persisted: string,
  recorded: unknown,
): T {
  if (isPermission(o.permission) && isPermission(recorded) && o.permission !== recorded)
    throw new HostError('E_PRESET_UNSUPPORTED', 'session already exists under another permission', {
      detail: { capability: 'permission', recorded, requested: o.permission },
    })
  const { permission: _requested, defaultPermission: _default, ...unrecorded } = o
  return {
    ...unrecorded,
    preset: persisted,
    ...(isPermission(recorded) ? { permission: FOLLOW_DEFAULT_PERMISSION, defaultPermission: recorded } : {}),
  } as unknown as T
}
