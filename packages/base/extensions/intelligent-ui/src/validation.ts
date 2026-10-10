import type { IntelligentUiCatalog } from '@agnes/intelligent-ui-contract'
import {
  inspectJsonData,
  type JsonValue,
  jcs,
  rpcError,
  type UiSurface as Surface,
  type UiActionParams,
  validateAgainst,
} from '@agnes/protocol'
import { X_AGNES_UI_LIMITS } from '@agnes/protocol/gen/intelligent-ui'
import { validIntelligentSurface } from '@agnes/protocol/intelligent-ui'
import type { TSchema } from '@sinclair/typebox'
import { Ajv2020 } from 'ajv/dist/2020.js'

const ajv = new Ajv2020({ strict: false, allErrors: false, validateFormats: false, addUsedSchema: false })
export const json = (value: unknown): JsonValue => JSON.parse(jcs(value))
export function bounded(value: unknown, bytes: number, depth: number = X_AGNES_UI_LIMITS.jsonDepth): void {
  if (!inspectJsonData(value, bytes).ok) throw rpcError('INVALID_PARAMS', { reason: 'UI payload limit' })
  const walk = (v: unknown, n: number) => {
    if (n > depth) throw rpcError('INVALID_PARAMS', { reason: 'UI nesting limit' })
    if (v && typeof v === 'object') for (const child of Object.values(v)) walk(child, n + 1)
  }
  walk(value, 0)
}
const dangerous = new Set(['__proto__', 'prototype', 'constructor'])
function safeSchema(schema: JsonValue): void {
  bounded(schema, 16384, X_AGNES_UI_LIMITS.schemaDepth)
  const walk = (value: JsonValue) => {
    if (Array.isArray(value)) return value.forEach(walk)
    if (value && typeof value === 'object')
      for (const [key, child] of Object.entries(value)) {
        if (
          dangerous.has(key) ||
          key === '$async' ||
          key === '$id' ||
          (key === '$ref' && (typeof child !== 'string' || !child.startsWith('#/')))
        )
          throw new Error('UI schema must be local, synchronous JSON data')
        walk(child)
      }
  }
  walk(schema)
}
export function accepts(schema: JsonValue, value: JsonValue): boolean {
  safeSchema(schema)
  try {
    return !!ajv.compile(schema as any)(value)
  } catch {
    throw new Error('Invalid UI JSON Schema')
  }
}
export function validateSurface(surface: Surface, ports: IntelligentUiCatalog): void {
  bounded(surface, X_AGNES_UI_LIMITS.surfaceBytes)
  const declarations = surface.components.some((item) => 'fallback' in item)
    ? (ports.components?.() ?? [])
    : []
  if (!validIntelligentSurface(surface, declarations)) throw rpcError('INVALID_PARAMS')
  const actionIds = new Set<string>()
  const catalog = new Map(ports.tools().map((tool) => [tool.name, tool]))
  for (const action of surface.actions) {
    if (
      actionIds.has(action.id) ||
      !catalog.has(action.tool) ||
      ['ui_render', 'ui_update', 'ui_close'].includes(action.tool)
    )
      throw rpcError('INVALID_PARAMS', {
        reason: 'UI action must reference a distinct declared business tool',
      })
    actionIds.add(action.id)
    safeSchema(action.paramsSchema)
    accepts(action.paramsSchema, {}) // compile even when an empty instance is not valid
    for (const key of Object.keys(action.argsTemplate))
      if (dangerous.has(key)) throw rpcError('INVALID_PARAMS')
  }
  for (const component of surface.components) {
    if ('fallback' in component) continue
    if (component.kind === 'form') {
      safeSchema(component.schema)
      accepts(component.schema, surface.data[component.dataKey]!) // incomplete defaults are allowed
    }
  }
}
function pointer(root: JsonValue, path = ''): JsonValue {
  if (!path) return root
  if (!path.startsWith('/')) throw new Error('Invalid JSON pointer')
  let value = root
  for (const part of path.slice(1).split('/')) {
    if (/~(?![01])/.test(part)) throw new Error('Invalid JSON pointer escape')
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~')
    if (dangerous.has(key) || !value || typeof value !== 'object' || !Object.hasOwn(value, key))
      throw new Error('Missing binding')
    value = (value as Record<string, JsonValue>)[key]!
  }
  return value
}
export function bindArguments(
  surface: Surface,
  request: UiActionParams,
  ports: IntelligentUiCatalog,
): JsonValue {
  const action = surface.actions.find((item) => item.id === request.actionId)
  if (!action) throw new Error('Unknown UI action')
  if (action.confirm && request.confirmed !== true) throw new Error('Confirmation required')
  const inputs: Record<string, JsonValue> = {},
    rows: Record<string, JsonValue> = {},
    selected: Record<string, JsonValue> = {}
  for (const [id, value] of Object.entries(request.input)) {
    const component = surface.components.find((item) => item.id === id)
    if (
      !component ||
      'fallback' in component ||
      component.kind !== 'form' ||
      !component.actionIds?.includes(action.id) ||
      !accepts(component.schema, value)
    )
      throw new Error('Invalid form input')
    inputs[id] = value
  }
  for (const [id, keys] of Object.entries(request.selection)) {
    const component = surface.components.find((item) => item.id === id)
    if (
      !component ||
      'fallback' in component ||
      component.kind !== 'table' ||
      component.selection === 'none' ||
      (component.selection === 'single' && keys.length > 1)
    )
      throw new Error('Invalid table selection')
    const data = surface.data[component.dataKey] as Record<string, JsonValue>[]
    selected[id] = keys.map((key) => {
      const row = data.find((item) => item[component.rowKey] === key)
      if (!row) throw new Error('Unknown selected row')
      return row
    })
  }
  if (request.row) {
    const component = surface.components.find((item) => item.id === request.row!.tableId)
    if (
      !component ||
      'fallback' in component ||
      component.kind !== 'table' ||
      !component.rowActionIds?.includes(action.id)
    )
      throw new Error('Invalid row action')
    const row = (surface.data[component.dataKey] as Record<string, JsonValue>[]).find(
      (item) => item[component.rowKey] === request.row!.rowId,
    )
    if (!row) throw new Error('Unknown action row')
    rows[component.id] = row
  }
  const args: Record<string, JsonValue> = Object.create(null)
  for (const [key, binding] of Object.entries(action.argsTemplate)) {
    if ('literal' in binding) args[key] = binding.literal
    else {
      const source = { data: surface.data, input: inputs, row: rows, selection: selected }[binding.from]
      if (!Object.hasOwn(source, binding.key)) throw new Error('Missing UI action binding')
      args[key] = pointer(source[binding.key]!, binding.pointer)
    }
  }
  if (!accepts(action.paramsSchema, args)) throw new Error('Invalid UI action arguments')
  const tool = ports.tools().find((item) => item.name === action.tool)
  if (!tool || !validateAgainst(tool.parameters as TSchema, args).ok)
    throw new Error('Tool unavailable or arguments invalid')
  return json(args)
}
