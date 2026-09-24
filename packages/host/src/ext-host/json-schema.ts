import { ExtensionError, type ExtensionErrorCode } from '@agnes/extension-api'
import { inspectJsonData } from '@agnes/protocol'
import { Ajv2020 } from 'ajv/dist/2020.js'

/** No remote loader, async validators, coercion, defaults or mutation of author values. */
export function compileExtensionSchema(
  schema: unknown,
  code: ExtensionErrorCode,
): (value: unknown) => boolean {
  try {
    const json = inspectJsonData(schema, 1048576)
    if (!json.ok || !json.value || typeof json.value !== 'object' || Array.isArray(json.value))
      throw new Error('schema')
    const ajv = new Ajv2020({ strict: true, allErrors: false, validateFormats: true })
    const validate = ajv.compile(json.value)
    if ('$async' in validate && validate.$async) throw new Error('async schema')
    return (value) => validate(value) === true
  } catch {
    throw new ExtensionError(code, 'invalid synchronous JSON schema')
  }
}
