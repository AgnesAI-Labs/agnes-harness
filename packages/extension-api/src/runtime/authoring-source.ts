import {
  type GeneratedAuthorSchemaSource,
  type ValidationResult,
  validateOwnedAuthorSchemaSource,
} from '@agnes/protocol/runtime'
import type { AuthorSchema } from './authoring.js'
import { createAuthorSchema } from './authoring-schema-core.js'

export type { GeneratedAuthorSchemaSource } from '@agnes/protocol/runtime'

/** Creates a source-bound codec; package provenance is verified separately before publication. */
export function defineGeneratedAuthorSchema<T>(source: GeneratedAuthorSchemaSource): AuthorSchema<T> {
  const checked = validateOwnedAuthorSchemaSource(source)
  return createAuthorSchema<T>(checked.ref, (value) => checked.validate(value) as ValidationResult<T>)
}
