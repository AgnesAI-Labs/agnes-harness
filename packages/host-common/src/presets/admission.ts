import { DEFAULT_PERMISSION, type Permission } from './permission.js'

type Admission = {
  presets: { allowed: readonly string[] }
  permissions?: { allowed: readonly Permission[] }
}

/** Deployment permission grants are independent of recipe names. */
export function allowedPermissions(profile: Admission): readonly Permission[] {
  return profile.permissions?.allowed ?? [DEFAULT_PERMISSION]
}

export function presetNameAllowed(profile: Admission, name: string): boolean {
  return profile.presets.allowed.includes(name)
}

/**
 * The admission decision for one session: the recipe is allowed and so is the permission it runs
 * under. `permission` is the level the resolver settled on; it is absent for a recipe that fixes its
 * own table, which only the recipe check can speak for.
 */
export function selectionAllowed(profile: Admission, name: string, permission?: Permission): boolean {
  if (!presetNameAllowed(profile, name)) return false
  return permission === undefined || allowedPermissions(profile).includes(permission)
}
