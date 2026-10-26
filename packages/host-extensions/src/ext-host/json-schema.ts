import { ExtensionError, type ExtensionErrorCode } from '@agnes/extension-api'
import { inspectJsonData } from '@agnes/protocol'
import { Ajv2020 } from 'ajv/dist/2020.js'

// Validators depend only on copied schema bytes, never row identity, grants or invocation data.
// Keep separate Ajv instances ($id/ref namespaces) while bounding retained schemas and generated code.
const validators = new Map<string, (value: unknown) => boolean>()
let schemaBytes = 0
const OPTIONS = { strict: true, allErrors: false, validateFormats: true } as const
// Checking a schema against the draft 2020-12 meta-schema compiles that meta-schema first, once per
// Ajv instance. Every distinct schema gets its own instance, so doing the check there repeated the
// meta-schema compile for each one, about 100 ms of every worker start. One shared instance does
// the check; it only reads the schema, so no $id or $ref of it enters a shared namespace.
let metaSchemas: Ajv2020 | undefined
const MAX_SCHEMAS = 64
const MAX_SCHEMA_BYTES = 4 * 1024 * 1024

/** No remote loader, async validators, coercion, defaults or mutation of author values. */
export function compileExtensionSchema(
  schema: unknown,
  code: ExtensionErrorCode,
): (value: unknown) => boolean {
  try {
    const json = inspectJsonData(schema, 1048576)
    if (!json.ok || !json.value || typeof json.value !== 'object' || Array.isArray(json.value))
      throw new Error('schema')
    const key = JSON.stringify(json.value)
    const cached = validators.get(key)
    if (cached) return cached
    metaSchemas ??= new Ajv2020(OPTIONS)
    if (metaSchemas.validateSchema(json.value) !== true) throw new Error('schema')
    const ajv = new Ajv2020({ ...OPTIONS, validateSchema: false })
    const validate = ajv.compile(json.value)
    if ('$async' in validate && validate.$async) throw new Error('async schema')
    const check = (value: unknown) => validate(value) === true
    while (validators.size >= MAX_SCHEMAS || schemaBytes + key.length * 2 > MAX_SCHEMA_BYTES) {
      const oldest = validators.keys().next().value
      if (oldest === undefined) break
      validators.delete(oldest)
      schemaBytes -= oldest.length * 2
    }
    validators.set(key, check)
    schemaBytes += key.length * 2
    return check
  } catch {
    throw new ExtensionError(code, 'invalid synchronous JSON schema')
  }
}
