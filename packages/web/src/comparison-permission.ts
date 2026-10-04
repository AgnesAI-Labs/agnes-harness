import type { ComparisonSnapshot } from '@agnes/protocol'
import type { ComparisonCreation, ComparisonEntry, ComparisonPendingInput } from './comparison-entry.js'
import type { PermissionMode, PermissionOption } from './permission-picker.js'

export const COMPARISON_PERMISSION_OPTIONS: readonly PermissionOption[] = [
  { id: 'view', label: '自动拒绝审批', description: '需审批的操作自动拒绝；不等同于文件系统只读隔离' },
  { id: 'workspace', label: '手动审批', description: '需审批的操作等待确认；两侧保持对比目录隔离' },
  {
    id: 'full',
    label: '自动审批（保持隔离）',
    description: '跳过交互审批；保留对比目录隔离、安全禁令和系统权限',
  },
]

export type PermissionInput = ComparisonPendingInput & { permissionMode?: PermissionMode }
export type PermissionCreation = Omit<ComparisonCreation, 'firstInput'> & { firstInput?: PermissionInput }
type PermissionEntry = Omit<ComparisonEntry, 'pending' | 'creation'> & {
  pending?: PermissionInput
  creation?: PermissionCreation
}

export function comparisonPermissionLabel(mode: PermissionMode | undefined): string {
  return COMPARISON_PERMISSION_OPTIONS.find((option) => option.id === mode)?.label ?? '权限模式未记录'
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
