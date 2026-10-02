import { boundedCanonicalJson } from '../../protocol-validation/src/byte-budget.js'
import type { JsonValue } from '../../protocol-validation/src/json-data.js'
import { AUTHOR_SCHEMA_LIMITS, SCHEMA_NAME, schemaObject } from '../src/runtime/author-schema-subset.js'
import type { SchemaDefinition } from '../src/runtime/schema-document.js'

const draft = 'https://json-schema.org/draft/2020-12/schema'
function fail(): never {
  throw new TypeError('Author schema generation failed: invalid source document')
}

/** Visit schema positions only; const/enum payloads and property names are data. */
export function mapAuthorSchemaPositions(
  node: SchemaDefinition,
  visit: (node: SchemaDefinition) => SchemaDefinition,
): SchemaDefinition {
  const result = { ...node }
  for (const field of ['properties', '$defs']) {
    if (schemaObject(node[field]))
      result[field] = Object.fromEntries(
        Object.entries(node[field]).map(([name, child]) => [
          name,
          schemaObject(child) ? mapAuthorSchemaPositions(child, visit) : child,
        ]),
      )
  }
  for (const field of ['items', 'additionalProperties']) {
    if (schemaObject(node[field])) result[field] = mapAuthorSchemaPositions(node[field], visit)
  }
  if (Array.isArray(node.anyOf))
    result.anyOf = node.anyOf.map((child) =>
      schemaObject(child) ? mapAuthorSchemaPositions(child, visit) : child,
    )
  return visit(result)
}

/** Offline representation conversion. The resolved graph still passes the strict runtime subset. */
export function normalizeAuthorSchemaDocument(input: unknown, name: string): Record<string, JsonValue> {
  const safe = boundedCanonicalJson(input, {
    maxBytes: AUTHOR_SCHEMA_LIMITS.documentBytes,
    maxDepth: 128,
    maxMembers: 100000,
  })
  if (!safe.ok || !schemaObject(safe.value.json) || !SCHEMA_NAME.test(name)) fail()
  const raw = safe.value.json
  if (raw.$schema !== draft) fail()
  for (const annotation of ['title', 'description'])
    if (Object.hasOwn(raw, annotation) && typeof raw[annotation] !== 'string') fail()
  let document: SchemaDefinition
  if (Object.hasOwn(raw, '$ref') || Object.hasOwn(raw, '$defs')) {
    if (
      typeof raw.$ref !== 'string' ||
      !/^#\/\$defs\/[A-Za-z_$][A-Za-z0-9_$]*$/.test(raw.$ref) ||
      !schemaObject(raw.$defs) ||
      Object.keys(raw).some((field) => !['$schema', '$ref', '$defs', 'title', 'description'].includes(field))
    )
      fail()
    document = raw
  } else {
    if (Object.hasOwn(raw, '$id') && (typeof raw.$id !== 'string' || !raw.$id || /\s/.test(raw.$id))) fail()
    const { $schema: _schema, $id: _id, ...definition } = raw
    document = { $schema: draft, $ref: `#/$defs/${name}`, $defs: { [name]: definition } }
  }
  return mapAuthorSchemaPositions(document, (node) =>
    node.type === 'object' && !Object.hasOwn(node, 'required') ? { ...node, required: [] } : node,
  ) as Record<string, JsonValue>
}
