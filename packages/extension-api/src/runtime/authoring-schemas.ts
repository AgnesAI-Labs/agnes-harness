import type { RuntimeWireTypes, SchemaRef } from '@agnes/protocol/runtime'
import { RuntimeSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import type { AuthorSchema } from './authoring.js'
import { createAuthorSchema } from './authoring-schema-core.js'

export { assertAuthorSchema } from './authoring-schema-core.js'

function officialSchema<K extends keyof RuntimeWireTypes>(
  name: K,
  reference: SchemaRef,
): AuthorSchema<RuntimeWireTypes[K]> {
  return createAuthorSchema(reference, (value) => validateRuntime(name, value))
}

type RegisteredRuntimeName = Extract<keyof typeof RuntimeSchemaRefs, keyof RuntimeWireTypes>
type RegisteredAuthorSchemas = { readonly [K in RegisteredRuntimeName]: AuthorSchema<RuntimeWireTypes[K]> }
const bundle: Partial<Record<RegisteredRuntimeName, AuthorSchema<RuntimeWireTypes[RegisteredRuntimeName]>>> =
  {}
for (const name of Object.keys(RuntimeSchemaRefs) as RegisteredRuntimeName[])
  bundle[name] = officialSchema(name, RuntimeSchemaRefs[name])

/** Codecs for schema identities published by the official Runtime bundle. */
export const runtimeAuthorSchemas = Object.freeze(bundle) as RegisteredAuthorSchemas
