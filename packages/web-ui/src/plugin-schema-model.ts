/** Renderer projections never alter the complete configuration value. Validation stays server-owned. */
export type PluginSchema = boolean | Readonly<Record<string, unknown>>
export type PluginFormKind =
  | 'object'
  | 'array'
  | 'variant'
  | 'enum'
  | 'string'
  | 'boolean'
  | 'number'
  | 'null'
  | 'json'
export const PLUGIN_FORM_MAX_DEPTH = 6
const supported = new Set([
  '$schema',
  '$id',
  '$defs',
  'definitions',
  '$ref',
  '$comment',
  'title',
  'description',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
  'x-secret',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'oneOf',
  'anyOf',
  'format',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
])
export const pointerKey = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1')
export const childPath = (path: string, key: string | number) => `${path}/${pointerKey(String(key))}`
export const isSchemaObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export function resolvePluginSchema(root: PluginSchema, schema: PluginSchema): PluginSchema {
  let current = schema
  const seen = new Set<string>()
  while (isSchemaObject(current) && typeof current.$ref === 'string') {
    const ref = current.$ref
    if (seen.has(ref) || !ref.startsWith('#') || !isSchemaObject(root)) return current
    seen.add(ref)
    let target: unknown = root
    let keys: string[]
    try {
      const fragment = decodeURIComponent(ref.slice(1))
      if (fragment && !fragment.startsWith('/')) return current
      keys = (fragment ? fragment.slice(1).split('/') : []).map((key) =>
        key.replace(/~1/g, '/').replace(/~0/g, '~'),
      )
    } catch {
      return current
    }
    for (const key of keys) {
      if (!isSchemaObject(target) || !Object.hasOwn(target, key)) return current
      target = target[key]
    }
    if (typeof target !== 'boolean' && !isSchemaObject(target)) return current
    // Assertion siblings are intersections, not overwrites. Use JSON rather than misrepresent them.
    if (
      Object.keys(current).some(
        (key) =>
          ![
            '$ref',
            '$defs',
            'definitions',
            '$schema',
            '$id',
            '$comment',
            'title',
            'description',
            'default',
          ].includes(key),
      )
    )
      return current
    const { $ref: _ref, ...annotations } = current
    current = isSchemaObject(target) ? { ...target, ...annotations } : target
  }
  return current
}

export function pluginFormKind(schema: PluginSchema, depth: number): PluginFormKind {
  if (depth >= PLUGIN_FORM_MAX_DEPTH || !isSchemaObject(schema)) return 'json'
  // Nested identifiers change reference scope; the server resolves them exactly.
  if (depth > 0 && schema.$id !== undefined) return 'json'
  if (Array.isArray(schema.type)) return 'json'
  if (Object.keys(schema).some((key) => !supported.has(key)) || schema.$ref) return 'json'
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    // Combined assertions need the lossless editor rather than a misleading branch-only form.
    const annotations = new Set([
      'oneOf',
      'anyOf',
      '$schema',
      '$id',
      '$defs',
      'definitions',
      '$comment',
      'title',
      'description',
      'default',
      'examples',
      'deprecated',
      'readOnly',
    ])
    if ((schema.oneOf && schema.anyOf) || Object.keys(schema).some((key) => !annotations.has(key)))
      return 'json'
    return 'variant'
  }
  if (Array.isArray(schema.enum) || Object.hasOwn(schema, 'const')) return 'enum'
  if (schema.type === 'object' || schema.properties) return 'object'
  if (schema.type === 'array' && !Array.isArray(schema.items)) return 'array'
  if (['string', 'boolean', 'null'].includes(String(schema.type))) return schema.type as PluginFormKind
  if (schema.type === 'number' || schema.type === 'integer') return 'number'
  return 'json'
}

export function pluginSchemaDefault(root: PluginSchema, schema: PluginSchema, depth = 0): unknown {
  const resolved = resolvePluginSchema(root, schema)
  if (!isSchemaObject(resolved) || depth >= PLUGIN_FORM_MAX_DEPTH) return null
  if (Object.hasOwn(resolved, 'default')) return structuredClone(resolved.default)
  if (Object.hasOwn(resolved, 'const')) return structuredClone(resolved.const)
  if (Array.isArray(resolved.enum)) return resolved.enum[0] ?? null
  if (resolved.type === 'object' || resolved.properties) {
    return Object.fromEntries(
      Object.entries(isSchemaObject(resolved.properties) ? resolved.properties : {}).flatMap(
        ([key, child]) => {
          const node = resolvePluginSchema(root, child as PluginSchema)
          return isSchemaObject(node) &&
            (Object.hasOwn(node, 'default') || (resolved.required as string[] | undefined)?.includes(key))
            ? [[key, pluginSchemaDefault(root, node, depth + 1)]]
            : []
        },
      ),
    )
  }
  if (resolved.type === 'array') return []
  if (resolved.type === 'boolean') return false
  if (resolved.type === 'number' || resolved.type === 'integer') return resolved.minimum ?? 0
  if (resolved.type === 'string')
    return resolved['x-secret'] === true ||
      resolved.writeOnly === true ||
      resolved.format === 'credential-reference'
      ? 'secret://'
      : ''
  const variants = resolved.oneOf ?? resolved.anyOf
  return Array.isArray(variants) && variants[0] !== undefined
    ? pluginSchemaDefault(root, variants[0], depth + 1)
    : null
}

/** Pick a discriminator-compatible branch for display; the server checks exact oneOf/anyOf semantics. */
export function pluginVariantIndex(variants: readonly PluginSchema[], value: unknown): number {
  const index = variants.findIndex((schema) => {
    if (!isSchemaObject(schema)) return false
    if (Object.hasOwn(schema, 'const')) return JSON.stringify(schema.const) === JSON.stringify(value)
    if (Array.isArray(schema.enum))
      return schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))
    if (isSchemaObject(schema.properties) && isSchemaObject(value)) {
      const literals = Object.entries(schema.properties).filter(
        ([, node]) => isSchemaObject(node) && Object.hasOwn(node, 'const'),
      )
      if (literals.length)
        return literals.every(
          ([key, node]) =>
            JSON.stringify((node as Record<string, unknown>).const) === JSON.stringify(value[key]),
        )
    }
    return schema.type === (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value)
  })
  return Math.max(0, index)
}
