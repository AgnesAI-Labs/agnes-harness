import { ExtensionError, type ExtensionErrorCode } from '@agnes/extension-api'
import { inspectJsonData } from '@agnes/protocol'
import { Ajv2020 } from 'ajv/dist/2020.js'

// Cache pure validators by copied schema bytes, never by mutable author object or $id.
// Bounds cover both large schemas and many small registrations across retained generations.
const validators = new Map<string, (value: unknown) => boolean>()
let schemaBytes = 0
const MAX_SCHEMA_BYTES = 1_048_576

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
    const ajv = new Ajv2020({ strict: true, allErrors: false, validateFormats: true })
    const validate = ajv.compile(json.value)
    if ('$async' in validate && validate.$async) throw new Error('async schema')
    const check = (value: unknown) => validate(value) === true
    while (validators.size >= 64 || schemaBytes + key.length * 2 > MAX_SCHEMA_BYTES) {
      const oldest = validators.keys().next().value
      if (oldest === undefined) break
      validators.delete(oldest)
      schemaBytes -= oldest.length * 2
    }
    if (key.length * 2 <= MAX_SCHEMA_BYTES) {
      validators.set(key, check)
      schemaBytes += key.length * 2
    }
    return check
  } catch {
    throw new ExtensionError(code, 'invalid synchronous JSON schema')
  }
}
