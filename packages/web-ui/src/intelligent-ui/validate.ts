import { UiSurface, X_AGNES_UI_LIMITS, type JsonValue } from '@agnes/protocol/gen/intelligent-ui'
import { validateAgainst } from '@agnes/protocol-validation'

export function boundedUiJson(
  value: unknown,
  bytes: number,
  depth: number = X_AGNES_UI_LIMITS.jsonDepth,
): boolean {
  const visit = (item: unknown, level: number): boolean => {
    if (level > depth) return false
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return true
    if (typeof item === 'number') return Number.isFinite(item)
    if (Array.isArray(item)) return item.every((child) => visit(child, level + 1))
    if (!item || typeof item !== 'object') return false
    return Object.values(item).every((child) => visit(child, level + 1))
  }
  try {
    return visit(value, 0) && new TextEncoder().encode(JSON.stringify(value)).length <= bytes
  } catch {
    return false
  }
}

export const uiObject = (value: JsonValue | undefined): value is Record<string, JsonValue> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Fail closed for the entire surface, including relationships and display data bounds. */
export function validIntelligentSurface(value: unknown): value is UiSurface {
  if (!boundedUiJson(value, X_AGNES_UI_LIMITS.surfaceBytes)) return false
  const result = validateAgainst<UiSurface>(UiSurface, value)
  if (!result.ok) return false
  const surface = result.value
  const ids = new Set(surface.components.map((item) => item.id))
  const actions = new Set(surface.actions.map((item) => item.id))
  if (ids.size !== surface.components.length || actions.size !== surface.actions.length) return false
  const schemaSafe = (schema: unknown): boolean => {
    if (!schema || typeof schema !== 'object') return true
    return Object.entries(schema).every(
      ([key, child]) =>
        (key !== '$ref' || (typeof child === 'string' && child.startsWith('#'))) && schemaSafe(child),
    )
  }
  for (const action of surface.actions) if (!schemaSafe(action.paramsSchema)) return false
  for (const component of surface.components) {
    const refs =
      component.kind === 'table'
        ? component.rowActionIds
        : component.kind === 'form' || component.kind === 'button-group'
          ? component.actionIds
          : []
    if (refs?.some((id) => !actions.has(id))) return false
    if (component.kind === 'button-group') continue
    if (!Object.hasOwn(surface.data, component.dataKey)) return false
    const data = surface.data[component.dataKey]
    if (component.kind === 'form') {
      if (!schemaSafe(component.schema)) return false
    } else if (component.kind === 'text' || component.kind === 'status') {
      if (typeof data !== 'string') return false
    } else {
      if (!Array.isArray(data) || data.length > X_AGNES_UI_LIMITS.tableRows || !data.every(uiObject))
        return false
      if (component.kind === 'table') {
        const rows = new Set<string>()
        for (const row of data) {
          if (!uiObject(row)) return false
          const id = row[component.rowKey]
          if (typeof id !== 'string' || !id.length || id.length > 128 || rows.has(id)) return false
          rows.add(id)
          if (component.columns.some((column) => !Object.hasOwn(row, column.key))) return false
        }
      } else {
        if (component.chartType === 'pie' && component.series.length !== 1) return false
        for (const row of data) {
          if (!uiObject(row) || typeof row[component.categoryKey] !== 'string') return false
          for (const series of component.series) {
            const n = row[series.key]
            if (typeof n !== 'number' || !Number.isFinite(n) || (component.chartType === 'pie' && n < 0))
              return false
          }
        }
      }
    }
  }
  return true
}
