import { HostError } from '../errors.js'
import type { PresetDoc } from './types.js'

/**
 * Permission is the second axis of a session recipe. A preset says what the session is (tools shown,
 * disclosure, prompt, model slots, budget); a permission says what it may do (tool policy, approval
 * rules, sandbox). The three levels ship as overlay documents merged after the preset.
 */
export const PERMISSIONS = ['read-only', 'workspace-write', 'full-access'] as const
export type Permission = (typeof PERMISSIONS)[number]

/** What a request that names a preset but no permission gets, exactly as before the split. */
export const DEFAULT_PERMISSION: Permission = 'workspace-write'

/** A client sends this to say "follow whatever the deployment default is" rather than a level. */
export const FOLLOW_DEFAULT_PERMISSION = 'default'

/** Overlay documents live in the preset catalogue under this reserved prefix and are never sessions. */
export const OVERLAY_PREFIX = 'permission-'
export const overlayName = (permission: Permission): string => `${OVERLAY_PREFIX}${permission}`

export const isPermission = (value: unknown): value is Permission =>
  (PERMISSIONS as readonly unknown[]).includes(value)

/**
 * Preset names that were really permission levels. Each is the `standard` recipe under that level and
 * stays resolvable forever; asking for it together with a different level is a contradiction.
 */
export function aliasedPermission(name: string): Permission | undefined {
  return isPermission(name) ? name : undefined
}

/**
 * The permission a request gets when it names only a legacy preset: an alias keeps its level, every
 * other recipe keeps the level it always ran under. A script or schedule written before the split
 * therefore never moves when an administrator later changes the default permission.
 */
export function legacyPermission(name: string): Permission {
  return aliasedPermission(name) ?? DEFAULT_PERMISSION
}

const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Fields a permission overlay may write, as `section.key`. `providers` is the one nested table. */
const OVERLAY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  providers: ['tool-policy'],
  approval: ['command_policy'],
  sandbox: ['level', 'on_unavailable', 'extra_paths', 'deny_paths', 'network_allow', 'loopback_serve'],
  subagent: ['isolation'],
}

/** The overlay fields a recipe must not write itself: the ones a profile never rewrites for it. */
const RECIPE_FORBIDDEN: readonly (readonly [string, string])[] = [
  ['approval', 'command_policy'],
  ['sandbox', 'level'],
  ['sandbox', 'on_unavailable'],
  ['sandbox', 'extra_paths'],
  ['sandbox', 'deny_paths'],
  ['sandbox', 'network_allow'],
  ['sandbox', 'loopback_serve'],
  ['subagent', 'isolation'],
]

/**
 * Keys an overlay writes outside the permission axis. An overlay that carried `sandbox.required` or
 * `approval.on_unavailable` could silently undo a recipe that demands isolation or parks approvals.
 */
export function overlayViolations(doc: PresetDoc): string[] {
  const bad: string[] = []
  for (const [section, value] of Object.entries(doc)) {
    if (section === 'name') continue
    const allowed = OVERLAY_FIELDS[section]
    if (!allowed || !isMap(value)) {
      bad.push(section)
      continue
    }
    for (const key of Object.keys(value)) if (!allowed.includes(key)) bad.push(`${section}.${key}`)
  }
  return bad
}

/**
 * Whether a recipe in an inheritance chain writes a permission-axis field itself. Such a recipe
 * fixes its own permission: layering an overlay on top could replace a stricter table it wrote.
 */
export function declaresPermissionFields(doc: PresetDoc): boolean {
  return RECIPE_FORBIDDEN.some(([section, key]) => {
    const value = doc[section]
    return isMap(value) && value[key] !== undefined
  })
}

export function conflictingPermission(name: string, alias: Permission, requested: Permission): HostError {
  return new HostError(
    'E_PRESET_UNSUPPORTED',
    `preset ${name} is the ${alias} permission and cannot be combined with ${requested}`,
    { detail: { source: name, capability: 'permission', alias, requested, reason: 'permission-axis' } },
  )
}
