import { Ajv2020 } from 'ajv/dist/2020.js'
import {
  UiComponentDeclaration as UiComponentDeclarationSchema,
  type UiComponentDeclaration,
} from '../gen/ts/extension-manifest.js'
import { UiSurface, X_AGNES_UI_LIMITS } from '../gen/ts/intelligent-ui.js'
import type { JsonValue } from '../gen/ts/session-v1.js'
import { validateAgainst } from './validate.js'

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

/** Local synchronous schemas only; no remote references or mutable registry identities. */
export function validUiComponentDeclaration(value: unknown): value is UiComponentDeclaration {
  if (!boundedUiJson(value, 24576)) return false
  const parsed = validateAgainst<UiComponentDeclaration>(UiComponentDeclarationSchema, value)
  if (!parsed.ok || !safeUiSchema(parsed.value.propsSchema)) return false
  try {
    const ajv = new Ajv2020({
      strict: true,
      strictTypes: false,
      strictTuples: false,
      strictRequired: false,
      validateFormats: false,
      ownProperties: true,
    })
    ajv.compile(parsed.value.propsSchema)
    return true
  } catch {
    return false
  }
}
function safeUiSchema(schema: unknown): boolean {
  if (!boundedUiJson(schema, 16384, X_AGNES_UI_LIMITS.schemaDepth)) return false
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return true
    return Object.entries(value).every(
      ([key, child]) =>
        !['__proto__', 'prototype', 'constructor', '$async', '$id', '$dynamicRef', '$recursiveRef'].includes(
          key,
        ) &&
        (key !== '$ref' || (typeof child === 'string' && child.startsWith('#/'))) &&
        visit(child),
    )
  }
  return visit(schema)
}
/** Fail closed for backend writes. Only pinned manifest declarations admit custom kinds. */
export function validIntelligentSurface(
  value: unknown,
  declarations: readonly UiComponentDeclaration[] = [],
): value is UiSurface {
  return validSurface(value, declarations)
}
/** Display-only validation of server facts: missing renderers must still allow text fallback. */
export function validIntelligentSurfaceProjection(value: unknown): value is UiSurface {
  return validSurface(value)
}
function validSurface(value: unknown, declarations?: readonly UiComponentDeclaration[]): value is UiSurface {
  if (!boundedUiJson(value, X_AGNES_UI_LIMITS.surfaceBytes)) return false
  const result = validateAgainst<UiSurface>(UiSurface, value)
  if (!result.ok) return false
  const surface = result.value
  const ids = new Set(surface.components.map((item) => item.id))
  const actions = new Set(surface.actions.map((item) => item.id))
  if (ids.size !== surface.components.length || actions.size !== surface.actions.length) return false
  for (const action of surface.actions) {
    if (
      !boundedUiJson(action.paramsSchema, 16384, X_AGNES_UI_LIMITS.schemaDepth) ||
      !safeUiSchema(action.paramsSchema)
    )
      return false
    if (
      Object.keys(action.argsTemplate).some((key) => ['__proto__', 'prototype', 'constructor'].includes(key))
    )
      return false
  }
  for (const component of surface.components) {
    if ('fallback' in component) {
      if (
        component.actionIds.some((id) => !actions.has(id)) ||
        !Object.hasOwn(surface.data, component.dataKey)
      )
        return false
      const props = surface.data[component.dataKey]
      if (!boundedUiJson(props, 16384)) return false
      if (declarations !== undefined) {
        const matches = declarations.filter((item) => item.kind === component.kind)
        if (matches.length !== 1) return false
        const declaration = matches[0]!
        if (
          !validUiComponentDeclaration(declaration) ||
          declaration.fallback !== component.fallback ||
          !boundedUiJson(props, declaration.maxPropsBytes)
        )
          return false
        try {
          const ajv = new Ajv2020({
            strict: false,
            validateFormats: false,
            ownProperties: true,
            addUsedSchema: false,
          })
          if (!ajv.compile(declaration.propsSchema)(props)) return false
        } catch {
          return false
        }
      }
      continue
    }
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
      if (
        !boundedUiJson(component.schema, 16384, X_AGNES_UI_LIMITS.schemaDepth) ||
        !safeUiSchema(component.schema)
      )
        return false
    } else if (component.kind === 'text' || component.kind === 'status') {
      if (typeof data !== 'string') return false
    } else {
      if (
        !Array.isArray(data) ||
        data.length >
          (component.kind === 'table' ? X_AGNES_UI_LIMITS.tableRows : X_AGNES_UI_LIMITS.chartPoints) ||
        !data.every(uiObject)
      )
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

export { canAnswerSurface, numberedSurfaceInput, surfaceText } from './ui-surface-text.js'
