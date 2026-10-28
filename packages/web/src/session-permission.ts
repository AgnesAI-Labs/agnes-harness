import type { RuntimeAdminSnapshot, SessionDefaults } from '@agnes/protocol'
import type { PermissionMode } from '@agnes/web-admin/permission-picker'

/**
 * A session has two independent choices: the preset (the recipe it runs) and the permission level
 * (what it may do). The composer's permission control picks the level and the agent options pick
 * the recipe.
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

/** The current recipe catalogue supplied by the backend. */
export function recipePresets<T extends { id: string }>(presets: readonly T[] | undefined): T[] {
  return [...(presets ?? [])]
}

/** The recipe a draft that names none runs: the administrator default, then the profile default. */
export function defaultRecipe(
  defaults: SessionDefaults | undefined,
  runtime: RuntimeAdminSnapshot | undefined,
): string | undefined {
  if (defaults?.preset) return defaults.preset
  const recipes = recipePresets(runtime?.presets)
  return (recipes.find((entry) => entry.isDefault) ?? recipes.find((entry) => entry.id === 'standard'))?.id
}

/** The levels the deployment explicitly allows. */
export function allowedPermissionLevels(runtime: RuntimeAdminSnapshot | undefined): PermissionLevel[] {
  return (runtime?.permissions ?? []).map((entry) => entry.id).filter(isPermissionLevel)
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
  /** The agent an application workbench starts by default; a draft with no explicit choice runs it. */
  agent?: string | undefined
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
  return chosenMode(input) ?? MODE[defaultPermissionLevel(input.defaults, input.runtime)]
}

export type NewSessionRequest = { agent: string } | { preset?: string; permission?: string }

/**
 * What `session.new` carries for the draft, or `undefined` when the selection cannot be requested
 * safely. A chosen (or remembered) level is sent as it is; an explicit recipe alone follows the
 * deployment's default level (`default`).
 */
export function newSessionRequest(input: DraftPermissionInput): NewSessionRequest | undefined {
  // An agent carries its own recipe and level, so `session.new` refuses it beside either.
  if (input.agent && !input.preset && !input.explicit) return { agent: input.agent }
  const preset = input.preset ?? defaultRecipe(input.defaults, input.runtime)
  const mode = chosenMode(input)
  if (mode && !allowedPermissionLevels(input.runtime).includes(LEVEL[mode])) return undefined
  return { ...(preset ? { preset } : {}), permission: mode ? LEVEL[mode] : 'default' }
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
  const policy = runtime?.security?.presetPolicies.find((entry) => entry.id === row.preset)?.approvalPolicy
  return policy === 'read-only' ? 'read-only' : policy === 'full-access' ? 'full-access' : undefined
}

/**
 * What the permission control shows for an open session: the backend's effective full-access flag. A read-only session stays read-only. Without a known level the previous
 * display stands, as before levels were reported.
 */
export function openSessionMode(
  level: PermissionLevel | undefined,
  yolo: boolean,
  previous: PermissionMode,
): PermissionMode {
  if (level === 'read-only') return 'view'
  if (yolo) return 'full'
  if (level) return 'workspace'
  return previous === 'view' ? 'view' : 'workspace'
}
