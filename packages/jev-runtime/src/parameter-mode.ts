/** Conservative parameter classification from the current schema and host declaration. */

import type { JsonValue, ToolDescriptor } from './types.js'

const EMPTY_OBJECT_KEYS = new Set([
  'type',
  'properties',
  'patternProperties',
  'required',
  'additionalProperties',
  'minProperties',
  'maxProperties',
  'title',
  'description',
  '$schema',
  '$id',
  '$anchor',
  '$comment',
  '$defs',
  'definitions',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
])

function object(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function emptyObject(value: JsonValue | undefined): boolean {
  const fields = object(value)
  return value === undefined || (fields !== undefined && Object.keys(fields).length === 0)
}

/**
 * Identify tools whose only caller invocation is the canonical empty object.
 * @param tool - Current trusted definition; defaults do not imply a no-argument API.
 * @returns The declared mode, or no_arguments only for an unambiguous closed empty object schema.
 * @throws Error when a no-argument declaration contradicts named, required or unresolved schema inputs.
 */
export function parameterMode(tool: ToolDescriptor): 'no_arguments' | 'parameterized' {
  if (tool.parameterMode === 'parameterized') return 'parameterized'
  const schema = object(tool.parameters)
  const simpleEmpty =
    schema !== undefined &&
    (schema.type === undefined || schema.type === 'object') &&
    emptyObject(schema.properties) &&
    emptyObject(schema.patternProperties) &&
    (schema.required === undefined || (Array.isArray(schema.required) && schema.required.length === 0)) &&
    (schema.minProperties === undefined || schema.minProperties === 0) &&
    (schema.maxProperties === undefined ||
      (typeof schema.maxProperties === 'number' &&
        Number.isInteger(schema.maxProperties) &&
        schema.maxProperties >= 0)) &&
    Object.keys(schema).every((key) => EMPTY_OBJECT_KEYS.has(key)) &&
    emptyObject(tool.defaults)
  if (tool.parameterMode === 'no_arguments') {
    if (!simpleEmpty) throw new Error(`Invalid no_arguments declaration for ${tool.name}`)
    return 'no_arguments'
  }
  return simpleEmpty && schema.type === 'object' && schema.additionalProperties === false
    ? 'no_arguments'
    : 'parameterized'
}
