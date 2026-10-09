import type { TSchema } from '@sinclair/typebox'

/** Type.Module.Import carries every module definition. Keep the transitive closure of this root. */
export function reachableParameters<T extends TSchema>(schema: T): T {
  const definitions = schema.$defs as Record<string, unknown> | undefined
  if (!definitions) return schema
  const reachable: Record<string, unknown> = {}
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    const row = value as Record<string, unknown>
    if (typeof row.$ref === 'string') {
      const key = row.$ref.startsWith('#/$defs/') ? row.$ref.slice('#/$defs/'.length) : row.$ref
      if (Object.hasOwn(definitions, key) && !Object.hasOwn(reachable, key)) {
        reachable[key] = definitions[key]
        visit(definitions[key])
      }
    }
    for (const [key, item] of Object.entries(row)) if (key !== '$defs') visit(item)
  }
  visit(schema)
  return { ...schema, $defs: reachable }
}
