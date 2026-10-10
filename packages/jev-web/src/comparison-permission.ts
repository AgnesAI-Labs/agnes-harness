import type { ComparisonSnapshot } from '@agnes/protocol'
import type { PermissionMode, PermissionOption } from '@agnes/web-session-ui/permission-picker'
import type { ComparisonCreation, ComparisonEntry, ComparisonPendingInput } from './comparison-entry.js'
import type { Translate } from './jev-locale.js'

/** Labels and descriptions are locale keys; translate them through `t` before rendering. */
export const COMPARISON_PERMISSION_OPTIONS: readonly PermissionOption[] = [
  { id: 'view', label: 'perm.view.label', description: 'perm.view.description' },
  { id: 'workspace', label: 'perm.workspace.label', description: 'perm.workspace.description' },
  { id: 'full', label: 'perm.full.label', description: 'perm.full.description' },
]

export type PermissionInput = ComparisonPendingInput & { permissionMode?: PermissionMode }
export type PermissionCreation = Omit<ComparisonCreation, 'firstInput'> & { firstInput?: PermissionInput }
type PermissionEntry = Omit<ComparisonEntry, 'pending' | 'creation'> & {
  pending?: PermissionInput
  creation?: PermissionCreation
}

export function comparisonPermissionLabel(mode: PermissionMode | undefined, t: Translate): string {
  const option = COMPARISON_PERMISSION_OPTIONS.find((option) => option.id === mode)
  return option === undefined ? t('perm.label.missing') : t(option.label)
}

/** Legacy preparation is only a fallback for the current selection, never evidence for a historical round. */
export function comparisonPermissionMode(
  snapshot: Pick<ComparisonSnapshot, 'prepared'> & { permissionMode?: PermissionMode },
): PermissionMode {
  return (
    snapshot.permissionMode ??
    (snapshot.prepared?.left?.configuration.effective.permission?.yolo === true &&
    snapshot.prepared?.right?.configuration.effective.permission?.yolo === true
      ? 'full'
      : 'workspace')
  )
}

/** A retry retains the exact selected mode, including omission in older saved inputs. */
export function comparisonPermissionEntry(entry: ComparisonEntry | undefined): PermissionEntry | undefined {
  if (!entry) return undefined
  const value = entry as PermissionEntry
  for (const item of [value.pending, value.creation?.firstInput, value.creation?.params]) {
    if (!item || !('permissionMode' in item)) continue
    if (!COMPARISON_PERMISSION_OPTIONS.some((option) => option.id === item.permissionMode))
      throw new Error('保存的对比权限模式无法读取；请核对原请求，不能更换权限重试。')
  }
  return value
}
