import { Ajv2020 } from 'ajv/dist/2020.js'
import {
  type UiComponentDeclaration,
  UiComponentDeclaration as UiComponentDeclarationSchema,
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

const STEP_STATES = new Set(['pending', 'active', 'done', 'error'])
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg'])
const UI_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/
const SHA256 = /^[0-9a-f]{64}$/
const DATA_URL = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/
const UPLOAD = /^agnes-upload:\/\/([a-f0-9]{64})\/([a-f0-9]{64})\/([0-9]+)\/([a-f0-9-]{36})$/u

function closed(value: Record<string, JsonValue>, keys: readonly string[]): boolean {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}
function realDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= days[month - 1]!
}
/** Calendar date plus a time and a zone. Leap seconds are only 23:59:60. */
function realDateTime(value: string): boolean {
  const [date, time, extra] = value.split('T')
  if (!date || !time || extra !== undefined || !realDate(date)) return false
  const match = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(z|[+-]\d{2}:\d{2})$/i.exec(time)
  if (!match) return false
  const hour = Number(match[1])
  const minute = Number(match[2])
  const second = Number(match[3])
  if (hour > 23 || minute > 59) return false
  if (second > 60 || (second === 60 && (hour !== 23 || minute !== 59))) return false
  const zone = match[4]!
  if (zone.toLowerCase() === 'z') return true
  return Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4, 6)) <= 59
}
/** Present date strings must be real calendar values. Empty drafts stay incomplete, not refused. */
function formDatesOk(schema: unknown, data: JsonValue | undefined): boolean {
  if (schema === true || schema === false || !schema || typeof schema !== 'object' || Array.isArray(schema))
    return true
  const node = schema as Record<string, unknown>
  if (
    (node.format === 'date' || node.format === 'date-time') &&
    node.type !== 'object' &&
    node.type !== 'array'
  ) {
    if (data === undefined || data === null || data === '') return true
    if (typeof data !== 'string') return false
    return node.format === 'date' ? realDate(data) : realDateTime(data)
  }
  const properties = node.properties
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    if (uiObject(data)) {
      for (const [key, child] of Object.entries(properties)) {
        if (!formDatesOk(child, Object.hasOwn(data, key) ? data[key] : undefined)) return false
      }
    } else if (data !== undefined && data !== null && !Array.isArray(data)) return true
  }
  const items = node.items
  if (Array.isArray(data) && items && typeof items === 'object' && !Array.isArray(items))
    return data.every((item) => formDatesOk(items, item))
  return true
}
function validDetail(
  component: { fields: readonly { key: string }[]; statusKey?: string; secondaryKey?: string },
  data: JsonValue | undefined,
): boolean {
  if (!uiObject(data) || component.fields.length > X_AGNES_UI_LIMITS.detailFields) return false
  const keys = component.fields.map((field) => field.key)
  if (new Set(keys).size !== keys.length || keys.some((key) => !Object.hasOwn(data, key))) return false
  if (component.statusKey) {
    const status = data[component.statusKey]
    if (typeof status !== 'string' || status.length < 1 || status.length > 256) return false
  }
  if (component.secondaryKey) {
    const note = data[component.secondaryKey]
    if (typeof note !== 'string' || note.length < 1 || note.length > 1024) return false
  }
  return true
}
function validSteps(data: JsonValue | undefined): boolean {
  if (!Array.isArray(data) || data.length < 1 || data.length > X_AGNES_UI_LIMITS.steps) return false
  const ids = new Set<string>()
  for (const step of data) {
    if (!uiObject(step)) return false
    const id = step.id
    const label = step.label
    const state = step.state
    if (typeof id !== 'string' || !UI_KEY.test(id) || ids.has(id)) return false
    ids.add(id)
    if (typeof label !== 'string' || label.length < 1 || label.length > 256) return false
    if (typeof state !== 'string' || !STEP_STATES.has(state)) return false
    if (step.description !== undefined) {
      const description = step.description
      if (typeof description !== 'string' || description.length < 1 || description.length > 1024) return false
    }
  }
  return true
}
function validProgress(data: JsonValue | undefined): boolean {
  if (!uiObject(data)) return false
  const label = data.label
  const value = data.value
  const total = data.total
  if (typeof label !== 'string' || label.length < 1 || label.length > 256) return false
  if (typeof value !== 'number' || typeof total !== 'number') return false
  return Number.isFinite(value) && Number.isFinite(total) && value >= 0 && total > 0 && value <= total
}
/** Artifact identity, a content-addressed attachment, or a bounded png/jpeg data URL. No remote URLs. */
function validImage(data: JsonValue | undefined): boolean {
  if (!uiObject(data) || !closed(data, ['source']) || !uiObject(data.source)) return false
  const source = data.source
  if (source.kind === 'artifact') {
    const size = source.size
    return (
      closed(source, ['kind', 'sha256', 'size', 'mime']) &&
      typeof source.sha256 === 'string' &&
      SHA256.test(source.sha256) &&
      typeof size === 'number' &&
      Number.isSafeInteger(size) &&
      size >= 1 &&
      size <= X_AGNES_UI_LIMITS.imageArtifactBytes &&
      typeof source.mime === 'string' &&
      IMAGE_MIMES.has(source.mime)
    )
  }
  if (source.kind === 'attachment') {
    if (!closed(source, ['kind', 'uri']) || typeof source.uri !== 'string') return false
    const match = UPLOAD.exec(source.uri)
    if (!match) return false
    const size = Number(match[3])
    return Number.isSafeInteger(size) && size >= 1 && size <= X_AGNES_UI_LIMITS.imageArtifactBytes
  }
  if (source.kind === 'data-url') {
    const dataUrl = source.dataUrl
    return (
      closed(source, ['kind', 'dataUrl']) &&
      typeof dataUrl === 'string' &&
      DATA_URL.test(dataUrl) &&
      new TextEncoder().encode(dataUrl).byteLength <= X_AGNES_UI_LIMITS.imageDataUrlBytes
    )
  }
  return false
}
function validTabs(surface: UiSurface): boolean {
  const byId = new Map(surface.components.map((item) => [item.id, item]))
  const placed = new Set<string>()
  for (const component of surface.components) {
    if ('fallback' in component || component.kind !== 'tabs') continue
    if (component.tabs.length > X_AGNES_UI_LIMITS.tabs) return false
    const tabIds = new Set<string>()
    for (const tab of component.tabs) {
      if (tabIds.has(tab.id) || tab.componentIds.length > X_AGNES_UI_LIMITS.tabItems) return false
      tabIds.add(tab.id)
      const local = new Set<string>()
      for (const id of tab.componentIds) {
        const target = byId.get(id)
        if (!target || local.has(id) || placed.has(id) || id === component.id) return false
        if (!('fallback' in target) && target.kind === 'tabs') return false
        local.add(id)
        placed.add(id)
      }
    }
  }
  return true
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
    if (component.kind === 'button-group' || component.kind === 'tabs') continue
    if (!Object.hasOwn(surface.data, component.dataKey)) return false
    const data = surface.data[component.dataKey]
    if (component.kind === 'form') {
      if (
        !boundedUiJson(component.schema, 16384, X_AGNES_UI_LIMITS.schemaDepth) ||
        !safeUiSchema(component.schema) ||
        !formDatesOk(component.schema, data)
      )
        return false
    } else if (component.kind === 'text' || component.kind === 'status') {
      if (typeof data !== 'string') return false
    } else if (component.kind === 'detail-card') {
      if (!validDetail(component, data)) return false
    } else if (component.kind === 'steps') {
      if (!validSteps(data)) return false
    } else if (component.kind === 'progress') {
      if (!validProgress(data)) return false
    } else if (component.kind === 'image') {
      if (!validImage(data)) return false
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
  return validTabs(surface)
}

export { canAnswerSurface, numberedSurfaceInput, surfaceText } from './ui-surface-text.js'
