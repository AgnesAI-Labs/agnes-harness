import type { JsonValue } from '@agnes/protocol'
import type { TSchema } from '@earendil-works/pi-ai'

/** Providers require an explicit object root even for a TypeBox Module.Import. */
export function toolParameters(name: string, parameters: JsonValue): TSchema {
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!object(parameters)) throw new TypeError(`Tool ${name}: parameters root must be type "object"`)
  const definitions = parameters.$defs
  let root: Record<string, unknown> = parameters
  const visited = new Set<string>()
  while (typeof root.$ref === 'string') {
    const key = root.$ref.startsWith('#/$defs/')
      ? root.$ref.slice('#/$defs/'.length).replace(/~1/g, '/').replace(/~0/g, '~')
      : root.$ref
    if (visited.has(key) || !object(definitions) || !Object.hasOwn(definitions, key)) break
    const definition = definitions[key]
    if (!object(definition)) break
    visited.add(key)
    const { $ref: _, ...siblings } = root
    root = { ...siblings, ...definition, $defs: definitions }
  }
  if (root.$ref !== undefined || root.type !== 'object')
    throw new TypeError(
      `Tool ${name}: parameters root must resolve to type "object" (local $defs references only)`,
    )
  return root as unknown as TSchema
}
