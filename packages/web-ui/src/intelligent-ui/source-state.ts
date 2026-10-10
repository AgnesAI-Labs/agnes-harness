import { validateAgainst } from '@agnes/protocol'
import {
  type JsonValue,
  type UiAction,
  type UiComponent,
  type UiSourceStatus,
  type UiSurface,
  UiSurface as UiSurfaceSchema,
  X_AGNES_UI_LIMITS,
} from '@agnes/protocol/gen/intelligent-ui'
import {
  boundedUiJson,
  componentDataValid,
  uiDataBinding,
  uiObject,
  validIntelligentSurfaceProjection,
} from '@agnes/protocol/intelligent-ui'

/** A binding is not display data. An invalid `$source` object is not a literal either. */
export function unresolvedBinding(value: JsonValue | undefined): boolean {
  return uiDataBinding(value) || (uiObject(value) && Object.hasOwn(value, '$source'))
}

export function sourceBacked(data: JsonValue | undefined, status: UiSourceStatus | undefined): boolean {
  return status !== undefined || unresolvedBinding(data)
}

/**
 * Resolved rows still have to pass the existing structural check before paint.
 * A binding, a pending or failed source, or a shape miss degrades this component only.
 */
export function componentSourceState(
  component: UiComponent,
  data: JsonValue | undefined,
  status: UiSourceStatus | undefined,
): 'ready' | 'loading' | 'error' {
  if (!('dataKey' in component)) return 'ready'
  if (status?.status === 'pending') return 'loading'
  if (status?.status === 'error' || unresolvedBinding(data)) return 'error'
  try {
    if (!componentDataValid(component, data)) return 'error'
  } catch {
    return 'error'
  }
  return 'ready'
}

export function componentSourceCode(
  component: UiComponent,
  data: JsonValue | undefined,
  status: UiSourceStatus | undefined,
): string | undefined {
  if (componentSourceState(component, data, status) !== 'error') return undefined
  if (status?.code) return status.code
  if (data !== undefined && !unresolvedBinding(data)) return 'UI_SOURCE_SHAPE'
  return undefined
}

export function degradedDataKeys(
  surface: UiSurface,
  sources?: Readonly<Record<string, UiSourceStatus>>,
): Set<string> {
  const keys = new Set<string>()
  for (const component of surface.components) {
    if (!('dataKey' in component)) continue
    const data = surface.data[component.dataKey]
    if (componentSourceState(component, data, sources?.[component.dataKey]) !== 'ready')
      keys.add(component.dataKey)
  }
  return keys
}

/** An action that reads a degraded source must not be offered as current data. */
export function actionNeedsDegradedData(
  action: UiAction,
  surface: UiSurface,
  degraded: ReadonlySet<string>,
): boolean {
  for (const binding of Object.values(action.argsTemplate)) {
    if (!('from' in binding)) continue
    if (binding.from === 'data' && degraded.has(binding.key)) return true
    if (binding.from !== 'selection' && binding.from !== 'row') continue
    const component = surface.components.find((item) => item.id === binding.key)
    if (component && 'dataKey' in component && degraded.has(component.dataKey)) return true
  }
  return false
}

/**
 * A source result that fails the row, series, or object check does not reject the surface.
 * Any other projection failure still does. The failed key is replaced only in this probe.
 */
export function displayableIntelligentSurface(
  surface: unknown,
  sources?: Readonly<Record<string, UiSourceStatus>>,
): surface is UiSurface {
  if (validIntelligentSurfaceProjection(surface)) return true
  if (!boundedUiJson(surface, X_AGNES_UI_LIMITS.surfaceBytes)) return false
  const parsed = validateAgainst<UiSurface>(UiSurfaceSchema, surface)
  if (!parsed.ok) return false
  const patched = structuredClone(parsed.value)
  let changed = false
  for (const [key, value] of Object.entries(patched.data)) {
    const status = sources?.[key]
    const binding = unresolvedBinding(value)
    if (!status && !binding) continue
    const users = patched.components.filter((item) => 'dataKey' in item && item.dataKey === key)
    let shapeOk = users.length > 0
    for (const component of users) {
      try {
        if (!componentDataValid(component, value)) shapeOk = false
      } catch {
        shapeOk = false
      }
    }
    if (binding || !shapeOk) {
      patched.data[key] = { $source: 'source/unavailable', params: {} }
      changed = true
    }
  }
  return changed && validIntelligentSurfaceProjection(patched)
}
