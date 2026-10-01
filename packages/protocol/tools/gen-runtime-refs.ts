import { createHash } from 'node:crypto'
import { jcs } from '../src/jcs.js'
import { runtimeSchemaDocument } from '../src/runtime/schema-document.js'
import type { JsonSchemaDoc } from './gen-core.js'
import { normalizeRuntimeCatalog } from './gen-runtime-catalog.js'

export { runtimeSchemaDocument } from '../src/runtime/schema-document.js'

type Json = Record<string, unknown>
type SchemaReference = { typeId: string; revision: number; digest: string }
type MethodReferences = Record<string, Record<string, { input: SchemaReference; output: SchemaReference }>>

export function generateRuntimeReferences(
  graph: JsonSchemaDoc,
  metadata: JsonSchemaDoc,
): {
  RuntimeSchemaRefs: Record<string, SchemaReference>
  RuntimeMethodSchemaRefs: MethodReferences
} {
  const revisions = metadata['x-schema-revisions'] === undefined ? {} : metadata['x-schema-revisions']
  if (!revisions || typeof revisions !== 'object' || Array.isArray(revisions))
    throw new Error('invalid runtime schema revisions')
  for (const [definition, revision] of Object.entries(revisions)) {
    if (
      !Object.hasOwn(graph.$defs ?? {}, definition) ||
      typeof revision !== 'number' ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      Object.is(revision, -0)
    )
      throw new Error(`invalid runtime schema revision ${definition}`)
  }
  const identities = new Map<string, SchemaReference>()
  const digests = new Map<string, string>()
  const reference = (definition: unknown, typeId: unknown): SchemaReference => {
    if (typeof definition !== 'string' || typeof typeId !== 'string' || !typeId.endsWith('@1'))
      throw new Error('runtime schema registration requires a definition and explicit @1 typeId')
    if (!/^[A-Za-z_$][\w$]*$/.test(definition) || !/^[^\s@]+@1$/.test(typeId))
      throw new Error(`invalid runtime schema registration ${definition}`)
    let digest = digests.get(definition)
    if (!digest) {
      digest = createHash('sha256')
        .update(jcs(runtimeSchemaDocument(graph, definition)), 'utf8')
        .digest('hex')
      digests.set(definition, digest)
    }
    const revision = (revisions as Record<string, number>)[definition] ?? 1
    const ref: SchemaReference = { typeId, revision, digest }
    const previous = identities.get(typeId)
    if (previous && (previous.revision !== ref.revision || previous.digest !== ref.digest))
      throw new Error(`conflicting runtime schema identity ${typeId}`)
    identities.set(typeId, ref)
    return ref
  }
  const registered = metadata['x-schema-ids']
  if (!registered || typeof registered !== 'object' || Array.isArray(registered))
    throw new Error('missing explicit runtime schema registrations')
  const RuntimeSchemaRefs = Object.fromEntries(
    Object.entries(registered).map(([name, typeId]) => [name, reference(name, typeId)]),
  )
  const catalog = normalizeRuntimeCatalog(metadata, new Set(Object.keys(graph.$defs ?? {})))
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog))
    throw new Error('missing runtime method schema registrations')
  const RuntimeMethodSchemaRefs: MethodReferences = {}
  for (const [contract, value] of Object.entries(catalog)) {
    const methods = (value as Json).methods
    if (!methods || typeof methods !== 'object' || Array.isArray(methods))
      throw new Error(`invalid runtime method table ${contract}`)
    const references: MethodReferences[string] = {}
    for (const [method, raw] of Object.entries(methods)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`invalid method ${method}`)
      const entry = raw as Json
      if (entry.local === true) continue
      references[method] = {
        input: reference(entry.input, entry.inputTypeId),
        output: reference(entry.output, entry.outputTypeId),
      }
    }
    RuntimeMethodSchemaRefs[contract] = references
  }
  return { RuntimeSchemaRefs, RuntimeMethodSchemaRefs }
}

export function emitRuntimeReferences(graph: JsonSchemaDoc, metadata: JsonSchemaDoc): string {
  const tables = generateRuntimeReferences(graph, metadata)
  const freeze = `function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
`
  return (
    '// generated from schema/runtime by tools/gen-runtime.ts — do not edit\n' +
    freeze +
    Object.entries(tables)
      .map(([name, value]) => `export const ${name} = freeze(${JSON.stringify(value, null, 2)} as const)\n`)
      .join('')
  )
}
