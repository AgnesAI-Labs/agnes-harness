import { FormatRegistry, type TSchema } from '@sinclair/typebox'
import { Value, type ValueError, ValueErrorType } from '@sinclair/typebox/value'
export type ValidationError = {
  path: string
  message: string
  code: 'UNKNOWN_KEY' | 'MISSING' | 'TYPE' | 'ENUM' | 'PATTERN' | 'RANGE' | 'OTHER'
  key?: string
}
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: ValidationError[] }

function classify(e: ValueError): ValidationError {
  const key = e.path.split('/').pop() || undefined
  // Measured against TypeBox 0.34.33: for ObjectRequiredProperty, `e.path` points at the missing key
  // itself (a missing `enforcement` gives e.path '/enforcement'). The shape we report is the other
  // way round — `path` is the parent object path (`/data`, not `/data/enforcement`) and the key name
  // is reported separately as `key`. So strip the key segment off the path to get the parent, and
  // keep the key name on its own field.
  if (e.type === ValueErrorType.ObjectRequiredProperty) {
    const path = key ? e.path.slice(0, e.path.length - key.length - 1) : e.path
    return { path, message: e.message, code: 'MISSING', ...(key ? { key } : {}) }
  }
  const base = { path: e.path, message: e.message, ...(key ? { key } : {}) }
  switch (e.type) {
    case ValueErrorType.ObjectAdditionalProperties:
      return { ...base, code: 'UNKNOWN_KEY' }
    case ValueErrorType.Union:
    case ValueErrorType.Literal:
      return { ...base, code: 'ENUM' }
    case ValueErrorType.StringPattern:
    // A format violation (e.g. a `ts` field that is not a valid date-time string) is classified as
    // PATTERN rather than getting its own FORMAT code: both mean "the string's content has the wrong
    // shape", and reusing one of the five existing codes is a smaller change than widening the
    // ValidationError.code union. Callers such as toRpcError do not need to tell "bad regex" from
    // "bad format" — both should surface as the same kind of INVALID_PARAMS hint.
    case ValueErrorType.StringFormat:
      return { ...base, code: 'PATTERN' }
    // An unregistered format cannot actually occur — generateModule fails fast on one — so this is
    // defence only: it falls through to `default` and lands on OTHER rather than being handled here.
    case ValueErrorType.StringMinLength:
    case ValueErrorType.StringMaxLength:
    case ValueErrorType.NumberMinimum:
    case ValueErrorType.NumberMaximum:
    // Type.Integer has its own error types, separate from Type.Number's. Without these four an
    // integer out of range fell through to `default` and was reported as OTHER, i.e. INVALID with
    // no hint at all - and integer bounds are the most common constraint in these schemas
    // (`minimum: 1` on every seq, `minimum: 0` on every count).
    case ValueErrorType.IntegerMinimum:
    case ValueErrorType.IntegerMaximum:
    case ValueErrorType.IntegerExclusiveMinimum:
    case ValueErrorType.IntegerExclusiveMaximum:
    case ValueErrorType.NumberExclusiveMinimum:
    case ValueErrorType.NumberExclusiveMaximum:
    case ValueErrorType.ArrayMinItems:
    case ValueErrorType.ArrayMaxItems:
      return { ...base, code: 'RANGE' }
    // Null belongs with the other primitive type mismatches. Without it, an observe hook returning
    // an object where the schema says null was reported as OTHER, i.e. INVALID with no hint.
    case ValueErrorType.Null:
    case ValueErrorType.String:
    case ValueErrorType.Number:
    case ValueErrorType.Integer:
    case ValueErrorType.Boolean:
    case ValueErrorType.Object:
    case ValueErrorType.Array:
      return { ...base, code: 'TYPE' }
    default:
      return { ...base, code: 'OTHER' }
  }
}

/** Reuse the generated schema's registered date-time rule for scalar host configuration. */
export function isDateTime(value: unknown): value is string {
  return typeof value === 'string' && (FormatRegistry.Get('date-time')?.(value) ?? false)
}

export function validateAgainst<T>(schema: TSchema, x: unknown, pathPrefix = ''): ValidationResult<T> {
  if (Value.Check(schema, x)) return { ok: true, value: x as T }
  const errors = [...Value.Errors(schema, x)].map(classify).map((e) => ({ ...e, path: pathPrefix + e.path }))
  return {
    ok: false,
    errors: errors.length ? errors : [{ path: pathPrefix, message: 'invalid', code: 'OTHER' }],
  }
}
