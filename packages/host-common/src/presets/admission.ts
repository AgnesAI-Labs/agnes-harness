import { aliasedPermission, legacyPermission, type Permission } from './permission.js'

type Admission = {
  presets: { allowed: readonly string[] }
  /** Present on a profile written after the split; older profiles derive the same set from `presets`. */
  permissions?: { allowed: readonly Permission[] }
}

/**
 * Permission levels a deployment grants. A profile that lists them says so; an older one lists
 * permission-level preset names (and recipes, which always ran under the default level) in
 * `presets.allowed`, and that list grants exactly the levels it implied before the split.
 */
export function allowedPermissions(profile: Admission): readonly Permission[] {
  if (profile.permissions) return profile.permissions.allowed
  return [...new Set(profile.presets.allowed.map(legacyPermission))]
}

/**
 * Whether a preset name may be requested. A permission-level name is the `standard` recipe under that
 * level, so a profile that allows `standard` no longer needs to list the levels as presets.
 */
export function presetNameAllowed(profile: Admission, name: string): boolean {
  const allowed = profile.presets.allowed
  return allowed.includes(name) || (aliasedPermission(name) !== undefined && allowed.includes('standard'))
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
