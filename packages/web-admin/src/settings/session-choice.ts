import type { RuntimeAdminSnapshot, SessionDefaults } from '@agnes/protocol'
import type { PermissionMode } from '../permission-picker.js'

type Entry = { id: string; isDefault: boolean }
export type PermissionLevel = NonNullable<SessionDefaults['permission']>
/** What a session may do. */
export const PERMISSION_LEVELS: readonly PermissionLevel[] = ['read-only', 'workspace-write', 'full-access']
export const isPermissionLevel = (value: unknown): value is PermissionLevel =>
  PERMISSION_LEVELS.includes(value as PermissionLevel)
/** Current recipe catalogue supplied by the backend. */
export const recipePresets = (presets: readonly Entry[]): Entry[] => [...presets]
export const allowedPermissions = (permissions: readonly Entry[] | undefined): PermissionLevel[] =>
  (permissions ?? []).map((entry) => entry.id).filter(isPermissionLevel)

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
  if (policy === 'read-only') return 'view'
  if (policy === 'full-access') return 'full'
  if (policy === 'default') return 'workspace'
  return undefined
}
