import {
  CanonicalJsonError,
  type CanonicalJsonLimits,
  canonicalJsonSnapshot,
  scalarUtf8Bytes,
} from './canonical-json.js'
import type { JsonValue } from './json-data.js'
import type { ValidationResult } from './validate.js'

function validBudget(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}
function failure(error: unknown): ValidationResult<never> {
  const limit = error instanceof CanonicalJsonError ? error.limit : undefined
  return {
    ok: false,
    errors: [
      {
        path: '',
        code: limit ? 'RANGE' : 'TYPE',
        message: limit ? `JSON exceeds ${limit}` : 'invalid JSON data or byte budget',
        ...(limit ? { key: limit } : {}),
      },
    ],
  }
}
export function utf8ByteLength(value: string, maxBytes: number): ValidationResult<number> {
  if (typeof value !== 'string' || !validBudget(maxBytes)) return failure(undefined)
  try {
    return { ok: true, value: scalarUtf8Bytes(value, maxBytes) }
  } catch (error) {
    return failure(error)
  }
}
export function boundedCanonicalJson(
  value: unknown,
  limits: CanonicalJsonLimits,
): ValidationResult<{ json: JsonValue; canonical: string; bytes: number }> {
  if (!limits || typeof limits !== 'object') return failure(undefined)
  const keys = Reflect.ownKeys(limits)
  if (
    keys.length !== 3 ||
    keys.some((key) => typeof key !== 'string' || !['maxBytes', 'maxDepth', 'maxMembers'].includes(key))
  )
    return failure(undefined)
  const copied = Object.create(null) as CanonicalJsonLimits
  for (const key of ['maxBytes', 'maxDepth', 'maxMembers'] as const) {
    const property = Object.getOwnPropertyDescriptor(limits, key)
    if (!property || !Object.hasOwn(property, 'value') || !validBudget(property.value))
      return failure(undefined)
    copied[key] = property.value
  }
  try {
    return { ok: true, value: canonicalJsonSnapshot(value, copied) }
  } catch (error) {
    return failure(error)
  }
}
