import { inspectJsonData } from '@agnes/protocol'
import { Ajv2020 } from 'ajv/dist/2020.js'
import formats from 'ajv-formats'

/** JSON Schema 2020-12, with local references only. */
export type PluginConfigSchema = boolean | Readonly<Record<string, unknown>>
export type PluginConfigReload = 'live' | 'next-session'
export const DEFAULT_PLUGIN_CONFIG_RELOAD: PluginConfigReload = 'next-session'
export interface PluginConfigContract {
  readonly configSchema?: PluginConfigSchema
  readonly configReload?: PluginConfigReload
}
export type PluginConfigIssue = Readonly<{ path: string; code: string }>
export const PLUGIN_SECRET_REF_PATTERN = '^secret://[a-z0-9-]+/[a-z0-9._-]+$'

const schemaMaps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'])
const schemaLists = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])
const schemaFields = new Set([
  'items',
  'contains',
  'additionalProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'contentSchema',
])

/** Apply secret constraints at schema locations, including branches and referenced definitions. */
function secureSchema(schema: unknown): unknown {
  if (typeof schema === 'boolean') return schema
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('schema')
  const source = schema as Record<string, unknown>
  if (source.$async !== undefined) throw new Error('async')
  for (const key of ['$ref', '$dynamicRef'])
    if (source[key] !== undefined && (typeof source[key] !== 'string' || !source[key].startsWith('#')))
      throw new Error('external reference')
  const result = { ...source }
  for (const [key, value] of Object.entries(source)) {
    if (schemaMaps.has(key)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('schema map')
      result[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, secureSchema(child)]),
      )
    } else if (schemaLists.has(key)) {
      if (!Array.isArray(value)) throw new Error('schema list')
      result[key] = value.map(secureSchema)
    } else if (schemaFields.has(key)) result[key] = secureSchema(value)
  }
  if (source['x-secret'] === true || source.writeOnly === true || source.format === 'credential-reference') {
    if (
      source.default !== undefined &&
      (typeof source.default !== 'string' || !new RegExp(PLUGIN_SECRET_REF_PATTERN).test(source.default))
    )
      throw new Error('secret default')
    result.allOf = [
      ...((result.allOf as unknown[]) ?? []),
      { type: 'string', pattern: PLUGIN_SECRET_REF_PATTERN },
    ]
  }
  return result
}

/** Shared install/inline/save validator. No coercion, defaults, mutation, remote loads or value-bearing errors. */
export function compilePluginConfig(
  schema: PluginConfigSchema,
): (value: unknown) => readonly PluginConfigIssue[] {
  try {
    const json = inspectJsonData(schema, 1_048_576)
    if (!json.ok) throw new Error('schema')
    const ajv = new Ajv2020({
      strictSchema: true,
      strictTypes: false,
      strictTuples: false,
      strictRequired: false,
      allErrors: true,
      validateFormats: true,
      ownProperties: true,
    })
    const addFormats = formats as unknown as (instance: Ajv2020) => void
    addFormats(ajv)
    ajv.addFormat('credential-reference', new RegExp(PLUGIN_SECRET_REF_PATTERN))
    const secured = secureSchema(json.value)
    const extensions = new Set<string>()
    const collect = (value: unknown): void => {
      if (!value || typeof value !== 'object') return
      for (const [key, child] of Object.entries(value)) {
        if (key.startsWith('x-')) extensions.add(key)
        collect(child)
      }
    }
    collect(secured)
    for (const keyword of extensions) ajv.addKeyword(keyword)
    const schemaKey = 'urn:agnes:plugin-configuration'
    ajv.addSchema(secured as object, schemaKey)
    const validate = ajv.getSchema(schemaKey)
    if (!validate) throw new Error('schema')
    // Defaults are editable annotations, but may not smuggle invalid or plaintext secret values.
    const defaults = (node: unknown, pointer: string): void => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return
      const record = node as Record<string, unknown>
      if (Object.hasOwn(record, 'default')) {
        const check = ajv.getSchema(`${schemaKey}#${pointer}`)
        if (!check || !check(record.default)) throw new Error('invalid default')
      }
      const escaped = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1')
      for (const [key, value] of Object.entries(record)) {
        const path = `${pointer}/${escaped(key)}`
        if (schemaMaps.has(key) && value && typeof value === 'object')
          for (const [name, child] of Object.entries(value)) defaults(child, `${path}/${escaped(name)}`)
        else if (schemaLists.has(key) && Array.isArray(value))
          value.forEach((child, index) => defaults(child, `${path}/${index}`))
        else if (schemaFields.has(key)) defaults(value, path)
      }
    }
    defaults(secured, '')
    return (value) => {
      const json = inspectJsonData(value, 1_048_576)
      if (!json.ok) return [{ path: '', code: 'json' }]
      try {
        if (validate(json.value)) return []
        return (validate.errors ?? []).slice(0, 100).map((error) => ({
          path:
            error.instancePath +
            (['required', 'additionalProperties', 'dependentRequired'].includes(error.keyword)
              ? `/${String(error.params.missingProperty ?? error.params.additionalProperty)
                  .replace(/~/g, '~0')
                  .replace(/\//g, '~1')}`
              : ''),
          code: error.keyword,
        }))
      } catch {
        return [{ path: '', code: 'validation' }]
      }
    }
  } catch {
    throw new TypeError('Invalid synchronous local JSON Schema 2020-12 for plugin configuration')
  }
}

/** Audit never contains secret references or credential-shaped keys, including in JSON fallbacks. */
export function redactPluginConfig(value: unknown): unknown {
  if (typeof value === 'string' && value.startsWith('secret://')) return '[redacted]'
  if (Array.isArray(value)) return value.map(redactPluginConfig)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      /secret|password|token|credential|api.?key/i.test(key) ? '[redacted]' : redactPluginConfig(child),
    ]),
  )
}
