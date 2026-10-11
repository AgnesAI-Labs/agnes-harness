import { TOOL_PARAMETERS_MAX_BYTES } from '@agnes/extension-api'
import { inspectJsonData } from '@agnes/protocol'
import { Kind, type TSchema, Type, TypeRegistry } from '@sinclair/typebox'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats'

const MCP_SCHEMA_KIND = 'AgnesMcpJsonSchema'
const validator = Symbol.for('agnes.mcp.jsonSchemaValidator')
type McpSchema = TSchema & { [validator]: (value: unknown) => boolean }
// ajv-formats is CommonJS at runtime while its declarations expose a default export. Keeping the
// import static lets the packaged single-file build include it; the cast only bridges that CJS/ESM
// type mismatch and does not change the callable runtime value.
const addFormats = addFormatsModule as unknown as FormatsPlugin

// TypeBox remains the core validation entry point. This private kind delegates complete remote JSON
// Schema validation to Ajv, while its symbol metadata stays out of provider JSON and wire hashes.
TypeRegistry.Set(MCP_SCHEMA_KIND, (schema, value) => {
  const validate = (schema as McpSchema)[validator]
  return typeof validate === 'function' && validate(value)
})

export function normalizeRemoteInputSchema(value: unknown): Record<string, unknown> {
  const inspected = inspectJsonData(value, TOOL_PARAMETERS_MAX_BYTES)
  if (
    !inspected.ok ||
    typeof inspected.value !== 'object' ||
    inspected.value === null ||
    Array.isArray(inspected.value)
  )
    throw new Error('remote input schema is not bounded JSON object data')
  const schema = inspected.value as Record<string, unknown>
  const objectKeywords = [
    'properties',
    'patternProperties',
    'additionalProperties',
    'required',
    'minProperties',
    'maxProperties',
    'propertyNames',
    'dependentRequired',
    'dependentSchemas',
  ]
  if (
    schema.type === undefined &&
    (Object.keys(schema).length === 0 || objectKeywords.some((key) => Object.hasOwn(schema, key)))
  )
    return { ...schema, type: 'object' }
  if (schema.type !== 'object') throw new Error('invalid synchronous MCP JSON schema')
  return schema
}

export function remoteInputSchema(value: unknown): TSchema {
  const schema = normalizeRemoteInputSchema(value)
  try {
    // Match the Host's strict synchronous extension schema policy without coercion or mutation.
    const ajv = new Ajv2020({ strict: true, allErrors: false, validateFormats: true })
    addFormats(ajv, ['uri'])
    const validate = ajv.compile(schema)
    if ('$async' in validate && validate.$async) throw new Error('async schema')
    return Type.Unsafe({
      ...schema,
      [Kind]: MCP_SCHEMA_KIND,
      [validator]: (input: unknown) => validate(input) === true,
    })
  } catch {
    throw new Error('invalid synchronous MCP JSON schema')
  }
}
