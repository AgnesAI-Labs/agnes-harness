import type { RuntimeAdminSnapshot, SessionDefaults } from '@agnes/protocol'
import type { PermissionMode } from '../permission-picker.js'

type Entry = { id: string; isDefault: boolean }
export type PermissionLevel = NonNullable<SessionDefaults['permission']>
/** What a session may do; the same three names still resolve as legacy preset aliases. */
export const PERMISSION_LEVELS: readonly PermissionLevel[] = ['read-only', 'workspace-write', 'full-access']
export const isPermissionLevel = (value: unknown): value is PermissionLevel =>
  PERMISSION_LEVELS.includes(value as PermissionLevel)
/** Presets that are recipes (tool set, mode): the catalog without the legacy permission-level aliases. */
export const recipePresets = (presets: readonly Entry[]): Entry[] =>
  presets.filter((preset) => !isPermissionLevel(preset.id))
/**
 * Permission levels a deployment allows. An older Host lists none; it allowed a level only when its
 * presets named it.
 */
export const allowedPermissions = (
  permissions: readonly Entry[] | undefined,
  presets: readonly Entry[],
): PermissionLevel[] => (permissions ?? presets).map((entry) => entry.id).filter(isPermissionLevel)
/**
 * Saved defaults with a legacy permission name in `preset` read as that permission (the Host
 * normalises on read; this keeps an older store from being written back as a preset).
 */
export function splitSessionDefaults(defaults: SessionDefaults): SessionDefaults {
  if (!isPermissionLevel(defaults.preset)) return defaults
  const { preset, ...rest } = defaults
  return { ...rest, permission: rest.permission ?? preset }
}

export function effectiveSessionPreset(
  explicit: string | undefined,
  defaults: SessionDefaults | undefined,
  runtime: RuntimeAdminSnapshot | undefined,
): string | undefined {
  return explicit ?? defaults?.preset ?? runtime?.presets.find((preset) => preset.isDefault)?.id
}
export function permissionForSessionPreset(
  preset: string | undefined,
  runtime: RuntimeAdminSnapshot | undefined,
): PermissionMode | undefined {
  const policy = runtime?.security?.presetPolicies.find((entry) => entry.id === preset)?.approvalPolicy
  if (preset === 'read-only' || policy === 'read-only') return 'view'
  if (preset === 'full-access' || policy === 'full-access') return 'full'
  if (preset === 'workspace-write' || preset === 'standard' || policy === 'default') return 'workspace'
  return undefined
}
