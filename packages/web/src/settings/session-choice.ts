import type { RuntimeAdminSnapshot, SessionDefaults } from '@agnes/protocol'
import type { PermissionMode } from '../permission-picker.js'

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
