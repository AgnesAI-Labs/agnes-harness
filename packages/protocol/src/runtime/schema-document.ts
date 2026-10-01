export type SchemaDefinition = Record<string, unknown>
export type SchemaDocument = {
  $schema: string
  $ref: string
  $defs: Record<string, SchemaDefinition>
}

/** The canonical document contains the root and every reachable definition. */
export function runtimeSchemaDocument(
  graph: { $defs?: Record<string, SchemaDefinition> },
  root: string,
): SchemaDocument {
  const selected = new Set([root])
  const definitions = graph.$defs ?? {}
  const scan = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) scan(item)
      return
    }
    const object = value as SchemaDefinition
    if (object.$ref !== undefined) {
      if (typeof object.$ref !== 'string' || !/^#\/\$defs\/[A-Za-z_$][\w$]*$/.test(object.$ref))
        throw new Error(`unresolved digest schema reference ${String(object.$ref)}`)
      selected.add(object.$ref.slice(8))
    }
    for (const [key, item] of Object.entries(object)) {
      if (['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'].includes(key)) {
        if (item && typeof item === 'object' && !Array.isArray(item))
          for (const child of Object.values(item)) scan(child)
      } else if (!['const', 'enum', 'examples', 'default', 'required'].includes(key)) scan(item)
    }
  }
  for (const name of selected) {
    if (!Object.hasOwn(definitions, name)) throw new Error(`unresolved digest definition ${name}`)
    scan(definitions[name])
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: `#/$defs/${root}`,
    $defs: Object.fromEntries(
      [...selected].sort().map((name) => [name, definitions[name] as SchemaDefinition]),
    ),
  }
}
