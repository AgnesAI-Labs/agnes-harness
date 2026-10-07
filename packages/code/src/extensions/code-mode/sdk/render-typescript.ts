import type { ToolDef } from '@agnes/extension-api'

/** Render public parameter schemas as TypeScript declarations, retaining required object fields. */
function annotation(value: unknown, depth = 0): string {
  if (!value || typeof value !== 'object' || depth > 32) return 'unknown'
  const s = value as Record<string, unknown>
  if (Object.hasOwn(s, 'const')) return JSON.stringify(s.const)
  if (Array.isArray(s.enum)) return s.enum.map((v) => JSON.stringify(v)).join(' | ') || 'never'
  const union = s.anyOf ?? s.oneOf
  if (Array.isArray(union)) return union.map((v) => annotation(v, depth + 1)).join(' | ') || 'unknown'
  if (Array.isArray(s.type)) return s.type.map((type) => annotation({ ...s, type }, depth + 1)).join(' | ')
  switch (s.type) {
    case 'string':
      return 'string'
    case 'integer':
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'null':
      return 'null'
    case 'array':
      return 'Array<' + annotation(s.items, depth + 1) + '>'
    case 'object': {
      if (!s.properties || typeof s.properties !== 'object') return 'Record<string, unknown>'
      const required = new Set(Array.isArray(s.required) ? s.required : [])
      return (
        '{ ' +
        Object.entries(s.properties)
          .map(
            ([name, schema]) =>
              JSON.stringify(name) + (required.has(name) ? ': ' : '?: ') + annotation(schema, depth + 1),
          )
          .join('; ') +
        ' }'
      )
    }
    default:
      return 'unknown'
  }
}

export function renderTypeScript(defs: readonly ToolDef[]): string {
  return (
    'declare const tools: {\n' +
    defs
      .filter((t) => t.name !== 'run_code' && !t.meta.deferLoading)
      .map((t) => JSON.stringify(t.name) + ': (args: ' + annotation(t.parameters) + ') => Promise<unknown>;')
      .join('\n') +
    '\n};\n// Await every call. Each cell is a fresh process; top-level await and return are supported.'
  )
}
