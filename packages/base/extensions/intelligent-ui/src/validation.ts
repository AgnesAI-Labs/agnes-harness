import type { IntelligentUiCatalog } from '@agnes/intelligent-ui-contract'
import {
  inspectJsonData,
  type JsonValue,
  jcs,
  rpcError,
  type UiSurface as Surface,
  type UiActionParams,
  uiDataBinding,
  validateAgainst,
} from '@agnes/protocol'
import { X_AGNES_UI_LIMITS } from '@agnes/protocol/gen/intelligent-ui'
import { componentDataValid, validIntelligentSurface } from '@agnes/protocol/intelligent-ui'
import type { TSchema } from '@sinclair/typebox'
import { Ajv2020 } from 'ajv/dist/2020.js'

import { validateActionParameterNames } from './action-parameters.js'
import { UI_DATA_CONTRACTS } from './data-contracts.js'
import { rejectUiInput, type UiInputIssue } from './input-rejection.js'

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
export function validateUiParameters(schema: TSchema, input: unknown): void {
  const checked = validateAgainst(schema, input)
  if (!checked.ok)
    rejectUiInput(
      checked.errors.map((issue) => ({
        path: issue.code === 'MISSING' && issue.key ? `${issue.path}/${issue.key}` : issue.path || '/',
        expected: issue.message,
      })),
    )
}
function inputSchema(schema: JsonValue, value: JsonValue, path: string): void {
  try {
    accepts(schema, value) // compile even when an incomplete instance is not valid
  } catch {
    rejectUiInput([
      {
        path,
        expected:
          'Valid local synchronous JSON Schema, <=16384 bytes, no remote refs, $id, $async or prototype keys.',
      },
    ])
  }
}
export function validateSurface(surface: Surface, ports: IntelligentUiCatalog): void {
  try {
    bounded(surface, X_AGNES_UI_LIMITS.surfaceBytes)
  } catch {
    rejectUiInput([
      {
        path: '/surface',
        expected: `JSON data <=${X_AGNES_UI_LIMITS.surfaceBytes} bytes and depth <=${X_AGNES_UI_LIMITS.jsonDepth}.`,
      },
    ])
  }
  const declarations = surface.components.some((item) => 'fallback' in item)
    ? (ports.components?.() ?? [])
    : []
  if (!validIntelligentSurface(surface as unknown, declarations)) {
    const issues: UiInputIssue[] = []
    for (const component of surface.components) {
      if (!('dataKey' in component)) continue
      const data = surface.data[component.dataKey]
      if (uiDataBinding(data) || componentDataValid(component, data, declarations)) continue
      issues.push({
        path: `/surface/data/${component.dataKey}`,
        expected:
          'fallback' in component
            ? 'Props matching one pinned declaration, its propsSchema/maxPropsBytes and exact fallback.'
            : UI_DATA_CONTRACTS[component.kind],
      })
    }
    rejectUiInput(
      issues.length
        ? issues
        : [
            {
              path: '/surface',
              expected:
                'Valid component data, unique component/action/tab ids, declared action and component references, local schemas and compatible source bindings.',
            },
          ],
    )
  }
  const actionIds = new Set<string>()
  const catalog = new Map(ports.tools().map((tool) => [tool.name, tool]))
  for (const [index, action] of surface.actions.entries()) {
    const path = `/surface/actions/${index}`
    if (
      actionIds.has(action.id) ||
      !catalog.has(action.tool) ||
      ['ui_render', 'ui_update', 'ui_close'].includes(action.tool)
    )
      rejectUiInput([
        {
          path: `${path}/tool`,
          expected:
            'A distinct action id referencing a declared business tool, not ui_render/ui_update/ui_close.',
        },
      ])
    actionIds.add(action.id)
    inputSchema(action.paramsSchema, {}, `${path}/paramsSchema`)
    for (const key of Object.keys(action.argsTemplate))
      if (dangerous.has(key))
        rejectUiInput([
          { path: `${path}/argsTemplate`, expected: 'JSON argument keys without prototype keys.' },
        ])
    const inputIds = formInputIds(surface, action.id)
    for (const [key, binding] of Object.entries(action.argsTemplate)) {
      if (!('from' in binding)) continue
      if (binding.from === 'input' && !inputIds.includes(binding.key))
        rejectUiInput([
          {
            path: `${path}/argsTemplate/${key}/key`,
            expected: `Unknown input key "${binding.key}" for action "${action.id}". Valid form component ids: ${inputIds.join(', ') || '(none)'}. Use component.id, not dataKey.`,
          },
        ])
      const dataKey = sourceDataKey(surface, binding)
      if (dataKey && uiDataBinding(surface.data[dataKey]) && !binding.pointer)
        rejectUiInput(
          [
            {
              path: `${path}/argsTemplate/${key}/pointer`,
              expected: 'A nonempty JSON pointer selecting a scalar source field.',
            },
          ],
          'UI_INVALID',
        )
    }
    validateActionParameterNames(
      catalog.get(action.tool)!.parameters as TSchema,
      action.argsTemplate,
      `${path}/argsTemplate`,
      action.tool,
    )
  }
  for (const [index, component] of surface.components.entries()) {
    if ('fallback' in component) continue
    if (component.kind === 'form')
      inputSchema(component.schema, surface.data[component.dataKey]!, `/surface/components/${index}/schema`)
  }
}
function formInputIds(surface: Surface, actionId: string): string[] {
  return surface.components
    .filter((item) => !('fallback' in item) && item.kind === 'form' && item.actionIds?.includes(actionId))
    .map((item) => item.id)
}
function sourceDataKey(surface: Surface, binding: { from: string; key: string }): string | undefined {
  if (binding.from === 'data') return binding.key
  if (binding.from !== 'row' && binding.from !== 'selection') return undefined
  const component = surface.components.find((item) => item.id === binding.key)
  if (!component || !('dataKey' in component)) return undefined
  return component.dataKey
}
function scalarJson(value: JsonValue | undefined): boolean {
  return (
    value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
  )
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
  declared: Surface,
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
      if (!Object.hasOwn(source, binding.key))
        throw new Error(
          `Missing UI action binding ${binding.from}.${binding.key} for action "${action.id}", argument "${key}". ${binding.from === 'input' ? `Valid form component ids: ${formInputIds(surface, action.id).join(', ') || '(none)'}. Use component.id, not dataKey; submit input under that id.` : `Available ${binding.from} keys: ${Object.keys(source).join(', ') || '(none)'}.`}`,
        )
      args[key] = pointer(source[binding.key]!, binding.pointer)
      const dataKey = sourceDataKey(declared, binding)
      if (dataKey && uiDataBinding(declared.data[dataKey])) {
        if (!binding.pointer || !scalarJson(args[key]))
          throw new Error('UI source binding must select a scalar field')
      }
    }
  }
  if (!accepts(action.paramsSchema, args)) throw new Error('Invalid UI action arguments')
  const tool = ports.tools().find((item) => item.name === action.tool)
  if (!tool) throw new Error(`UI action "${action.id}" tool "${action.tool}" is unavailable`)
  const checked = validateAgainst(tool.parameters as TSchema, args)
  if (!checked.ok)
    throw new Error(
      `UI action "${action.id}" arguments for tool "${action.tool}" are invalid: ${JSON.stringify(checked.errors)}`,
    )
  return json(args)
}
