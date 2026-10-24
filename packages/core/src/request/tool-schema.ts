import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import type { ToolDef } from '@agnes/extension-api'
import { sanitize, sanitizeJson } from './derive.js'
import type { ToolSchema } from './mint.js'

// Only the registry can populate this memo, after detaching and deeply freezing the input schema.
// Auto-disclosure changes metadata, so key by that immutable schema and compare both text fields.
const immutable = new WeakSet<object>()
const prepared = new WeakMap<object, { name: string; description: string; schema: ToolSchema }>()

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) freeze(child)
  }
  return value
}

function scrub(tool: Pick<ToolDef, 'name' | 'description' | 'parameters' | 'modelParameters'>): ToolSchema {
  return {
    name: sanitize(tool.name),
    description: sanitize(tool.description),
    parameters: sanitizeJson(tool.modelParameters ?? tool.parameters),
  }
}

/** Called only with the registry's own validated, detached definition. No permission is memoized. */
export function prepareToolSchema(tool: ToolDef): void {
  const schema = freeze(scrub(tool))
  immutable.add(schema)
  prepared.set(tool.modelParameters ?? tool.parameters, {
    name: tool.name,
    description: tool.description,
    schema,
  })
}

export function modelToolSchema({ name, description, parameters, modelParameters }: ToolDef): ToolSchema {
  const cached = prepared.get(modelParameters ?? parameters)
  return cached?.name === name && cached.description === description
    ? cached.schema
    : scrub({ name, description, parameters: modelParameters ?? parameters })
}

// Retain only the last disclosure for each leading schema. A long-lived catalog must not
// accumulate every possible tool subset/permutation while its schemas remain reachable.
const hashes = new WeakMap<ToolSchema, { tools: readonly ToolSchema[]; hash: string }>()

/** Reuse the ordered disclosure hash only while every registry-owned scrubbed schema is identical. */
export function toolSchemaHash(tools: readonly ToolSchema[]): string {
  const compute = () => sha256Hex(canonicalJson(tools).normalize('NFC'))
  const first = tools[0]
  if (!first || !tools.every((tool) => immutable.has(tool))) return compute()
  const cached = hashes.get(first)
  if (cached?.tools.length === tools.length && tools.every((tool, i) => tool === cached.tools[i]))
    return cached.hash
  const hash = compute()
  hashes.set(first, { tools: [...tools], hash })
  return hash
}
