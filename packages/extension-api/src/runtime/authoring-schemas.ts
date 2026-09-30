import { jcs } from '@agnes/protocol'
import type { DataRef, RuntimeError, RuntimeWireTypes, SchemaRef } from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import type { AuthorSchema } from './authoring.js'
import { copyJson, declarationError } from './authoring-validation.js'
import type { Outcome } from './public-api.js'

const schemas = new WeakSet<object>()
const invalid: RuntimeError = Object.freeze({
  code: 'invalid_input',
  detailCode: 'author_schema_invalid',
  message: 'Value does not match the registered author schema',
  retryAdvice: Object.freeze({ kind: 'never' }),
  diagnosticId: 'author-schema-validation',
})

function officialSchema<K extends keyof RuntimeWireTypes>(
  name: K,
  reference: SchemaRef,
): AuthorSchema<RuntimeWireTypes[K]> {
  const ref = copyJson(reference)
  const parse = (value: unknown): Outcome<RuntimeWireTypes[K]> => {
    try {
      const result = validateRuntime(name, copyJson(value))
      return result.ok ? { ok: true, value: result.value } : { ok: false, error: invalid }
    } catch {
      return { ok: false, error: invalid }
    }
  }
  const encode = (value: RuntimeWireTypes[K]): Outcome<DataRef> => {
    const result = parse(value)
    if (!result.ok) return result
    const decoded = validateRuntime('JsonValue', result.value)
    if (!decoded.ok) return { ok: false, error: invalid }
    const json = decoded.value
    return {
      ok: true,
      value: Object.freeze({
        kind: 'inline',
        schema: ref,
        value: json,
        digest: canonicalJsonDigest(json),
        bytes: new TextEncoder().encode(jcs(json)).byteLength,
      }),
    }
  }
  const schema = Object.freeze({ ref, parse, encode })
  schemas.add(schema)
  return schema
}

type RegisteredRuntimeName = Extract<keyof typeof RuntimeSchemaRefs, keyof RuntimeWireTypes>
type RegisteredAuthorSchemas = { readonly [K in RegisteredRuntimeName]: AuthorSchema<RuntimeWireTypes[K]> }
const bundle: Partial<Record<RegisteredRuntimeName, AuthorSchema<RuntimeWireTypes[RegisteredRuntimeName]>>> =
  {}
for (const name of Object.keys(RuntimeSchemaRefs) as RegisteredRuntimeName[])
  bundle[name] = officialSchema(name, RuntimeSchemaRefs[name])

/** Codecs for schema identities published by the official Runtime bundle. */
export const runtimeAuthorSchemas = Object.freeze(bundle) as RegisteredAuthorSchemas

export function assertAuthorSchema<T>(schema: AuthorSchema<T>): void {
  if (!schemas.has(schema)) declarationError('author schemas must come from a generated schema module')
}
