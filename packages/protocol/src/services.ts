import type { TSchema } from '@sinclair/typebox'
import { ExtensionCallParams, ExtensionCallResult } from '../gen/ts/agnes-v1.js'
import { ExtensionCallError, ServiceCapability } from '../gen/ts/extension-service.js'
import { jcs } from './jcs.js'
import { type ValidationResult, validateAgainst } from './validate.js'

// Reuse the protocol's strict serializer before TypeBox recursion; never invoke accessors/toJSON.
const jsonBytes = (value: unknown): number => new TextEncoder().encode(jcs(value)).byteLength
function check<T>(schema: TSchema, value: unknown): ValidationResult<T> {
  try {
    jsonBytes(value)
    return validateAgainst<T>(schema, value)
  } catch {
    return { ok: false, errors: [{ path: '', code: 'TYPE', message: 'expected strict JSON data' }] }
  }
}
export const validateServiceCapability = (value: unknown): ValidationResult<ServiceCapability> =>
  check(ServiceCapability, value)
export const validateExtensionCallError = (value: unknown): ValidationResult<ExtensionCallError> =>
  check(ExtensionCallError, value)
export function validateExtensionCall(
  side: 'params' | 'result',
  value: unknown,
): ValidationResult<ExtensionCallParams | ExtensionCallResult> {
  const checked = check<ExtensionCallParams | ExtensionCallResult>(
    side === 'params' ? ExtensionCallParams : ExtensionCallResult,
    value,
  )
  if (!checked.ok) return checked
  const key = side === 'params' ? 'input' : 'output'
  const data = (checked.value as unknown as Record<string, unknown>)[key]
  if (jsonBytes(data) > 1048576)
    return { ok: false, errors: [{ path: `/${key}`, code: 'RANGE', message: 'JSON exceeds 1 MiB' }] }
  return checked
}
