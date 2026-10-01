import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  type DataRef,
  type JsonValue,
  MAX_AUTHOR_INLINE_BYTES,
  RuntimeAuthorCodecPolicy,
  type RuntimeError,
  type SchemaRef,
  type ValidationResult,
} from '@agnes/protocol/runtime'
import type { AuthorSchema } from './authoring.js'
import { declarationError } from './authoring-validation.js'
import type { Outcome } from './public-api.js'

const schemas = new WeakSet<object>()
function error(
  quota: boolean,
  detailCode = quota ? 'author_schema_budget' : 'author_schema_invalid',
): RuntimeError {
  return Object.freeze({
    code: quota ? 'quota' : 'invalid_input',
    detailCode,
    message: quota ? 'Author schema budget exceeded' : 'Value does not match the author schema',
    retryAdvice: Object.freeze({ kind: 'never' }),
    diagnosticId: 'author-schema-validation',
  })
}
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
}

/** Internal codec construction; public source constructors validate complete schema documents first. */
export function createAuthorSchema<T>(
  reference: SchemaRef,
  validate: (value: JsonValue) => ValidationResult<T>,
): AuthorSchema<T> {
  const ref = Object.freeze({ ...reference })
  const parse = (value: unknown): Outcome<T> => {
    const limits = RuntimeAuthorCodecPolicy.payload
    const safe = boundedCanonicalJson(value, {
      maxBytes: limits.maxCanonicalJsonBytes,
      maxDepth: limits.maxDepth,
      maxMembers: limits.maxMembers,
    })
    if (!safe.ok) return { ok: false, error: error(safe.errors.some((item) => item.code === 'RANGE')) }
    let result: ValidationResult<T>
    try {
      result = validate(safe.value.json)
    } catch {
      return { ok: false, error: error(false) }
    }
    if (!result.ok) return { ok: false, error: error(result.errors.some((item) => item.key === 'maxWork')) }
    freeze(result.value)
    return { ok: true, value: result.value }
  }
  const codec: AuthorSchema<T> = Object.freeze({
    ref,
    parse,
    encode: (value: T): Outcome<DataRef> => {
      const result = parse(value)
      if (!result.ok) return result
      const encoded = boundedCanonicalJson(result.value, {
        maxBytes: MAX_AUTHOR_INLINE_BYTES,
        maxDepth: RuntimeAuthorCodecPolicy.payload.maxDepth,
        maxMembers: RuntimeAuthorCodecPolicy.payload.maxMembers,
      })
      if (!encoded.ok)
        return {
          ok: false,
          error: error(
            encoded.errors.some((item) => item.code === 'RANGE'),
            'inline_data_bytes',
          ),
        }
      freeze(encoded.value.json)
      return {
        ok: true,
        value: Object.freeze({
          kind: 'inline',
          schema: ref,
          value: encoded.value.json,
          digest: canonicalJsonDigest(encoded.value.json),
          bytes: encoded.value.bytes,
        }),
      }
    },
  })
  schemas.add(codec)
  return codec
}

export function assertAuthorSchema<T>(schema: AuthorSchema<T>): void {
  if (!schemas.has(schema)) declarationError('author schemas must come from a generated schema module')
}
