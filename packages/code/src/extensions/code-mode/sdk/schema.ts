import type { ToolDef } from '@agnes/extension-api'

type Schema = ToolDef['parameters']
type Node = Record<string, unknown>
const node = (value: unknown): Node =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Node) : {}
export const pyString = (value: string): string => JSON.stringify(value)
const literal = (value: unknown): string | undefined => {
  if (value === null) return 'None'
  if (typeof value === 'string') return pyString(value)
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  return undefined
}
export class SchemaRenderer {
  readonly declarations: string[] = []
  private serial = 0
  constructor(private readonly named = true) {}
  annotation(value: unknown, depth = 0): string {
    if (depth > 32) return 'Any'
    const s = node(value)
    if (Object.hasOwn(s, 'const')) {
      const text = literal(s.const)
      return text === undefined ? 'Any' : text === 'None' ? text : `Literal[${text}]`
    }
    if (Array.isArray(s.enum)) {
      const texts = s.enum.map(literal)
      return texts.length && texts.every((v) => v !== undefined)
        ? `Literal[${[...new Set(texts)].join(', ')}]`
        : 'Any'
    }
    if (Array.isArray(s.anyOf)) {
      if (s.anyOf.length && s.anyOf.every((part) => Object.hasOwn(node(part), 'const'))) {
        return this.annotation({ enum: s.anyOf.map((part) => node(part).const) }, depth + 1)
      }
      const parts = [...new Set(s.anyOf.map((part) => this.annotation(part, depth + 1)))]
      return parts.length ? parts.join(' | ') : 'Any'
    }
    if (Array.isArray(s.type))
      return this.annotation({ anyOf: s.type.map((type) => ({ ...s, type })) }, depth + 1)
    switch (s.type) {
      case 'string':
        return 'str'
      case 'integer':
        return 'int'
      case 'number':
        return 'float'
      case 'boolean':
        return 'bool'
      case 'null':
        return 'None'
      case 'array':
        return `list[${this.annotation(s.items, depth + 1)}]`
      case 'object': {
        if (!this.named || !s.properties) return 'dict[str, Any]'
        const name = `_AgnesShape${++this.serial}`
        const required = new Set(Array.isArray(s.required) ? s.required : [])
        const fields = Object.entries(node(s.properties))
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(
            ([key, schema]) =>
              `${pyString(key)}: ${required.has(key) ? 'Required' : 'NotRequired'}[${this.annotation(schema, depth + 1)}]`,
          )
        this.declarations.push(`${name} = TypedDict(${pyString(name)}, {${fields.join(', ')}})`)
        return name
      }
      default:
        return 'Any'
    }
  }
}
export function annotate(schema: Schema): string {
  return new SchemaRenderer(false).annotation(schema)
}
