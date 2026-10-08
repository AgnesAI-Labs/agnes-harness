import type { ProjectionDef as KernelProjection } from '@agnes/core'
import { ExtensionError, type ProjectionCapability, type ProjectionDef } from '@agnes/extension-api'
import { inspectJsonData, type JsonValue } from '@agnes/protocol'
import { frozenJson as frozen } from './frozen-json.js'
import { compileExtensionSchema } from './json-schema.js'
/** One adapter into the existing Core runtime; no second cache or quarantine. */
export function adaptProjection<S extends JsonValue>(
  extId: string,
  def: ProjectionDef<S>,
  cap: ProjectionCapability,
): KernelProjection<JsonValue> {
  let init: () => S, apply: ProjectionDef<S>['apply'], view: ProjectionDef<S>['view']
  try {
    if (
      def.name !== cap.name ||
      !Number.isSafeInteger(def.stateVersion) ||
      def.stateVersion < 1 ||
      typeof def.init !== 'function' ||
      typeof def.apply !== 'function' ||
      (def.view !== undefined && typeof def.view !== 'function')
    )
      throw new Error('definition')
    init = def.init.bind(def)
    apply = def.apply.bind(def)
    view = def.view?.bind(def)
  } catch {
    throw new ExtensionError('E_PROJECTION_DEF', 'invalid projection definition')
  }
  const validate = compileExtensionSchema(def.stateSchema, 'E_PROJECTION_DEF')
  const eventTypes = new Set(cap.inputEventTypes)
  const check = (value: unknown, state: boolean): JsonValue => {
    if (value instanceof Promise) void value.catch(() => undefined)
    const data = inspectJsonData(value, cap.maxStateBytes)
    if (!data.ok || (state && !validate(data.value)))
      throw new ExtensionError('E_PROJECTION_STATE', 'projection unavailable')
    return frozen(data.value)
  }
  return {
    key: `${extId}/${cap.name}`,
    stateVersion: def.stateVersion,
    init: () => check(init(), true),
    apply(state, event) {
      if (!eventTypes.has(event.type)) return state
      const data = inspectJsonData(event, Number.MAX_SAFE_INTEGER)
      if (!data.ok) throw new ExtensionError('E_PROJECTION_STATE', 'projection unavailable')
      const next = apply(state as S, frozen(data.value) as unknown as Parameters<typeof apply>[1])
      return next === state ? state : check(next, true)
    },
    ...(view ? { view: (state: JsonValue) => check(view(state as S), false) } : {}),
  }
}
