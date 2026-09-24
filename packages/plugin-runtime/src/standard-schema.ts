import type { StaticDecode, TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import type { StandardSchemaV1 } from '@standard-schema/spec'

function pathOf(path: string): readonly PropertyKey[] | undefined {
  if (!path) return undefined
  return path
    .split('/')
    .slice(1)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
}

/** Adapt a TypeBox schema to the Cordis standard-schema contract. */
export function typeBoxStandardSchema<S extends TSchema>(
  schema: S,
): StandardSchemaV1<unknown, StaticDecode<S>> {
  return Object.freeze({
    '~standard': Object.freeze({
      version: 1 as const,
      vendor: 'typebox',
      validate(value: unknown): StandardSchemaV1.Result<StaticDecode<S>> {
        try {
          return { value: Value.Decode(schema, value) }
        } catch (error) {
          try {
            const issues = [...Value.Errors(schema, value)].map((issue) => ({
              message: issue.message,
              ...(pathOf(issue.path) ? { path: pathOf(issue.path) } : {}),
            }))
            if (issues.length) return { issues }
          } catch {
            // Transform schemas can reject in Decode before the generic error iterator is available.
          }
          return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }
        }
      },
    }),
  })
}
