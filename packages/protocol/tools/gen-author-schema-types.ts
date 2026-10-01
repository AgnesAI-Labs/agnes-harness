import type { SchemaDefinition, SchemaDocument } from '../src/runtime/schema-document.js'

function literal(value: unknown): string {
  return JSON.stringify(value)
}
function type(node: SchemaDefinition): string {
  if (typeof node.$ref === 'string') return node.$ref.slice(8)
  if (Object.hasOwn(node, 'const')) return literal(node.const)
  if (Array.isArray(node.enum)) return node.enum.map(literal).join(' | ')
  if (Array.isArray(node.anyOf))
    return node.anyOf.map((branch) => `(${type(branch as SchemaDefinition)})`).join(' | ')
  if (node.type === 'null' || node.type === 'boolean' || node.type === 'string') return node.type
  if (node.type === 'integer' || node.type === 'number') return 'number'
  if (node.type === 'array') return `ReadonlyArray<${type(node.items as SchemaDefinition)}>`
  if (node.type === 'object') {
    if (node.additionalProperties !== false)
      return `Readonly<Record<string, ${type(node.additionalProperties as SchemaDefinition)}>>`
    const required = new Set(node.required as string[])
    return `{ ${Object.entries(node.properties as Record<string, SchemaDefinition>)
      .map(
        ([key, child]) => `readonly ${JSON.stringify(key)}${required.has(key) ? '' : '?'}: ${type(child)};`,
      )
      .join(' ')} }`
  }
  throw new TypeError('Unsupported author schema type')
}
export function generateAuthorSchemaModule(name: string, source: unknown, document: SchemaDocument): string {
  const definitions = Object.entries(document.$defs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return [
    '// Generated from package JSON Schema sources; do not edit.',
    "import { defineGeneratedAuthorSchema as __createGeneratedSchema__ } from '@agnes/extension-api/runtime'",
    ...definitions.map(([key, node]) => `type ${key} = ${type(node)}`),
    `export type ${name}Value = ${document.$ref.slice(8)}`,
    `export const ${name}Schema = __createGeneratedSchema__<${name}Value>(${JSON.stringify(source)})`,
    '',
  ].join('\n')
}
