/** The part of JSON Schema the service input schemas use: what the Host checks before it calls a handler. */
type Schema = {
  type?: string
  enum?: unknown[]
  const?: unknown
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  properties?: Record<string, Schema>
  required?: string[]
  additionalProperties?: boolean
}

/** The problems of `value` against `schema`; empty when the Host would accept it. */
export function problems(schema: Schema, value: unknown, path = 'input'): string[] {
  if (schema.const !== undefined && value !== schema.const) return [`${path}: not ${String(schema.const)}`]
  if (schema.enum && !schema.enum.includes(value)) return [`${path}: not one of ${schema.enum.join(', ')}`]
  const typed = (type: string) =>
    type === 'integer' ? Number.isInteger(value) : type === 'object' ? !!value && typeof value === 'object' && !Array.isArray(value) : typeof value === type
  if (schema.type && !typed(schema.type)) return [`${path}: not a ${schema.type}`]
  const found: string[] = []
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) found.push(`${path}: below ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) found.push(`${path}: above ${schema.maximum}`)
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) found.push(`${path}: too short`)
    if (schema.maxLength !== undefined && value.length > schema.maxLength) found.push(`${path}: too long`)
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) found.push(`${path}: does not match the pattern`)
  }
  if (schema.type === 'object') {
    const object = value as Record<string, unknown>
    for (const key of schema.required ?? []) if (!(key in object)) found.push(`${path}.${key}: missing`)
    for (const [key, item] of Object.entries(object)) {
      const known = schema.properties?.[key]
      if (known) found.push(...problems(known, item, `${path}.${key}`))
      else if (schema.additionalProperties === false) found.push(`${path}.${key}: unknown`)
    }
  }
  return found
}
