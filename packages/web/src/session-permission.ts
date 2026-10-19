import type { RuntimeAdminSnapshot, SessionDefaults } from '@agnes/protocol'
import type { PermissionMode } from '@agnes/web-admin/permission-picker'
import { effectiveSessionPreset, permissionForSessionPreset } from '@agnes/web-admin/settings/session-choice'

/**
 * A session has two independent choices: the preset (the recipe it runs) and the permission level
 * (what it may do). The composer's permission control picks the level and the agent options pick
 * the recipe. The three level names also exist as legacy preset aliases; the Web never offers them
 * as recipes.
 */
export type PermissionLevel = 'read-only' | 'workspace-write' | 'full-access'
export const PERMISSION_LEVELS: readonly PermissionLevel[] = ['read-only', 'workspace-write', 'full-access']
const LEVEL: Record<PermissionMode, PermissionLevel> = {
  view: 'read-only',
  workspace: 'workspace-write',
  full: 'full-access',
}
const MODE: Record<PermissionLevel, PermissionMode> = {
  'read-only': 'view',
  'workspace-write': 'workspace',
  'full-access': 'full',
}

export const isPermissionLevel = (value: unknown): value is PermissionLevel =>
  PERMISSION_LEVELS.includes(value as PermissionLevel)
export const permissionLevel = (mode: PermissionMode): PermissionLevel => LEVEL[mode]
export const permissionModeOf = (level: PermissionLevel): PermissionMode => MODE[level]

/** The recipes a user may pick: the catalog without the legacy permission-level aliases. */
export function recipePresets<T extends { id: string }>(presets: readonly T[] | undefined): T[] {
  return (presets ?? []).filter((entry) => !isPermissionLevel(entry.id))
}

/** The recipe a draft that names none runs: the administrator default, then the profile default. */
export function defaultRecipe(
  defaults: SessionDefaults | undefined,
  runtime: RuntimeAdminSnapshot | undefined,
): string | undefined {
  if (defaults?.preset && !isPermissionLevel(defaults.preset)) return defaults.preset
  const recipes = recipePresets(runtime?.presets)
  return (recipes.find((entry) => entry.isDefault) ?? recipes.find((entry) => entry.id === 'standard'))?.id
}

/** An older Host lists no permission levels; it then speaks only the legacy preset names. */
const levelsListed = (runtime: RuntimeAdminSnapshot | undefined): boolean =>
  Array.isArray(runtime?.permissions)

/** The levels a new session may start under. An older Host offers read-only only as a preset. */
export function allowedPermissionLevels(runtime: RuntimeAdminSnapshot | undefined): PermissionLevel[] {
  if (levelsListed(runtime))
    return (runtime?.permissions ?? []).map((entry) => entry.id).filter(isPermissionLevel)
  return PERMISSION_LEVELS.filter(
    (level) => level !== 'read-only' || runtime?.presets.some((entry) => entry.id === level) === true,
  )
}

/** The level a new session gets when the request names none. */
export function defaultPermissionLevel(
  defaults: SessionDefaults | undefined,
  runtime: RuntimeAdminSnapshot | undefined,
): PermissionLevel {
  if (isPermissionLevel(defaults?.permission)) return defaults.permission
  const flagged = runtime?.permissions?.find((entry) => entry.isDefault)?.id
  return isPermissionLevel(flagged) ? flagged : 'workspace-write'
}

export type DraftPermissionInput = {
  /** The level chosen in this draft's permission control. */
  explicit: PermissionMode | undefined
  /** The level remembered from an earlier choice in this browser. */
  remembered: PermissionMode | undefined
  /** The recipe chosen in this draft's agent options. */
  preset: string | undefined
  defaults: SessionDefaults | undefined
  runtime: RuntimeAdminSnapshot | undefined
}

/** A remembered level the deployment no longer allows is not a choice: the default applies. */
function chosenMode(input: DraftPermissionInput): PermissionMode | undefined {
  if (input.explicit) return input.explicit
  const remembered = input.remembered
  return remembered && allowedPermissionLevels(input.runtime).includes(LEVEL[remembered])
    ? remembered
    : undefined
}

/** The level the draft's permission control shows. */
export function draftPermissionMode(input: DraftPermissionInput): PermissionMode {
  if (levelsListed(input.runtime))
    return chosenMode(input) ?? MODE[defaultPermissionLevel(input.defaults, input.runtime)]
  // An older Host derives the level from the preset the session will run.
  return (
    input.explicit ??
    permissionForSessionPreset(
      effectiveSessionPreset(input.preset, input.defaults, input.runtime),
      input.runtime,
    ) ??
    input.remembered ??
    'workspace'
  )
}

export type NewSessionRequest = { preset?: string; permission?: string }

/**
 * What `session.new` carries for the draft, or `undefined` when the selection cannot be requested
 * safely. A chosen (or remembered) level is sent as it is; an explicit recipe alone follows the
 * deployment's default level (`default`); a draft that changed nothing names neither.
 */
export function newSessionRequest(input: DraftPermissionInput): NewSessionRequest | undefined {
  const { preset, runtime } = input
  if (levelsListed(runtime)) {
    const mode = chosenMode(input)
    if (mode) {
      if (!allowedPermissionLevels(runtime).includes(LEVEL[mode])) return undefined
      return { ...(preset ? { preset } : {}), permission: LEVEL[mode] }
    }
    return preset ? { preset, permission: 'default' } : {}
  }
  // An older Host rejects `permission`: a chosen level travels as its legacy preset name, which a
  // recipe cannot accompany. Approval changes follow through the yolo switch after creation.
  const level = LEVEL[draftPermissionMode(input)]
  const sent =
    preset ?? (input.explicit && runtime?.presets.some((entry) => entry.id === level) ? level : undefined)
  // Read-only must come from the preset itself: nothing after creation narrows the sandbox.
  if (
    level === 'read-only' &&
    permissionForSessionPreset(effectiveSessionPreset(sent, input.defaults, runtime), runtime) !== 'view'
  )
    return undefined
  return sent ? { preset: sent } : {}
}

type SessionRow = { sessionId: string; permission?: string; preset?: string | null } | undefined

/** The level an existing session runs under, as its list row or the Host reports it. */
export function sessionPermissionLevel(
  row: SessionRow,
  runtime: RuntimeAdminSnapshot | undefined,
): PermissionLevel | undefined {
  if (!row) return undefined
  if (isPermissionLevel(row.permission)) return row.permission
  const status = runtime?.security?.workspaces.find((entry) => entry.sessionId === row.sessionId)?.permission
  if (isPermissionLevel(status)) return status
  if (isPermissionLevel(row.preset)) return row.preset
  // Older sessions: the recipe's own policy is the only record of the level.
  const policy = runtime?.security?.presetPolicies.find((entry) => entry.id === row.preset)?.approvalPolicy
  return policy === 'read-only' ? 'read-only' : policy === 'full-access' ? 'full-access' : undefined
}

/**
 * What the permission control shows for an open session: its level, widened to full access while
 * the yolo switch is on. A read-only session stays read-only. Without a known level the previous
 * display stands, as before levels were reported.
 */
export function openSessionMode(
  level: PermissionLevel | undefined,
  yolo: boolean,
  previous: PermissionMode,
): PermissionMode {
  if (level === 'read-only') return 'view'
  if (yolo || level === 'full-access') return 'full'
  if (level) return 'workspace'
  return previous === 'view' ? 'view' : 'workspace'
}
