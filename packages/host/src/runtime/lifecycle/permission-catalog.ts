import { allowedPermissions } from '@agnes/host-common/presets/admission'
import { DEFAULT_PERMISSION } from '@agnes/host-common/presets/permission'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'

/** The permission levels a deployment allows, with the one new sessions start under marked. */
export function sessionPermissionCatalog(
  profile: Pick<ResolvedProfile, 'presets' | 'permissions'>,
): { id: string; isDefault: boolean }[] {
  const fallback = profile.permissions?.default ?? DEFAULT_PERMISSION
  return allowedPermissions(profile).map((id) => ({ id, isDefault: id === fallback }))
}
