import { type AdminContext } from '../types.js'

const OPERATION_STORAGE_PREFIX = 'agnes-plugin-operation-ids:'
export type PreviewMode = 'install' | 'update'
export type TrackedOperation = Readonly<{
  operationId: string
  mode?: PreviewMode
  packageId?: string
}>
export function operationStorageKey(context: AdminContext): string {
  return `${OPERATION_STORAGE_PREFIX}${context.authScope ?? `legacy.${context.clientId}`}:${context.profile}`
}

export function operationRecords(context: AdminContext): TrackedOperation[] {
  try {
    const stored = JSON.parse(sessionStorage.getItem(operationStorageKey(context)) ?? '[]')
    if (!Array.isArray(stored)) return []
    return stored.flatMap((value): TrackedOperation[] => {
      if (typeof value === 'string') return [{ operationId: value }]
      if (!value || typeof value !== 'object') return []
      const record = value as Record<string, unknown>
      if (typeof record.operationId !== 'string') return []
      return [
        {
          operationId: record.operationId,
          ...(record.mode === 'install' || record.mode === 'update' ? { mode: record.mode } : {}),
          ...(typeof record.packageId === 'string' ? { packageId: record.packageId } : {}),
        },
      ]
    })
  } catch {
    return []
  }
}
