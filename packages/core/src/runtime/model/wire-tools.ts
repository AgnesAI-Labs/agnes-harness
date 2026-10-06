import type { Outcome } from '@agnes/extension-api/runtime'
import type { RequestBody } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'

/** A schema document in the closed resolved-graph form: one root reference plus every reachable definition. */
export type ToolSchemaDocument = Readonly<{
  $schema: string
  $ref: string
  $defs: Readonly<Record<string, Wire.JsonValue>>
}>

/** The resolved form of one catalog tool; the runtime does not resolve a schema reference itself yet. */
export type ResolvedTool = Readonly<{ name: string; description: string; document: ToolSchemaDocument }>
export type ResolvedTools = readonly ResolvedTool[]

type ToolSchema = RequestBody['tools'][number]
type Message = RequestBody['messages'][number]
type Refusal = Extract<Outcome<never>, { ok: false }>

export const TOOL_CALL_BODY_TYPE = 'agh.context/tool-call-body@1'
export const TOOL_RESULT_BODY_TYPE = 'agh.context/tool-result-body@1'

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_TOOLS = 128
const MAX_PARAMETER_BYTES = 262144
const MAX_DESCRIPTION = 4096
const APIS = new Set(['openai-completions', 'anthropic-messages'])
const KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'anyOf',
  'enum',
  'const',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'description',
  'title',
])
/** The one recursive definition that is rewritten, as an exact equivalence, to "any JSON value". */
const JSON_VALUE: Wire.JsonValue = {
  anyOf: [
    { type: 'null' },
    { type: 'boolean' },
    { type: 'number' },
    { type: 'string' },
    { type: 'array', items: { $ref: '#/$defs/JsonValue' }, maxItems: 10000, minItems: 0 },
    { type: 'object', additionalProperties: { $ref: '#/$defs/JsonValue' } },
  ],
}

const refuse = (detailCode: string): Refusal => ({
  ok: false,
  error: {
    code: 'incompatible',
    detailCode,
    message: 'Model request cannot be expressed on the wire',
    retryAdvice: { kind: 'never' },
    diagnosticId: 'model-wire-request',
  },
})

const isObject = (value: unknown): value is { readonly [key: string]: Wire.JsonValue } =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

class Refused extends Error {
  constructor(readonly detailCode: string) {
    super(detailCode)
  }
}

function inline(
  node: Wire.JsonValue,
  defs: Readonly<Record<string, Wire.JsonValue>>,
  stack: readonly string[],
): Wire.JsonValue {
  if (!isObject(node)) throw new Refused('model_wire_tool_schema')
  if (node.$ref !== undefined) {
    const ref = node.$ref
    const name = typeof ref === 'string' && /^#\/\$defs\/[A-Za-z_$][\w$]*$/.test(ref) ? ref.slice(8) : null
    if (name === null || Object.keys(node).length !== 1 || !Object.hasOwn(defs, name))
      throw new Refused('model_wire_tool_schema')
    const target = defs[name] as Wire.JsonValue
    if (name === 'JsonValue' && canonicalJsonDigest(target) === canonicalJsonDigest(JSON_VALUE)) return {}
    if (stack.includes(name)) throw new Refused('model_wire_tool_schema_recursive')
    return inline(target, defs, [...stack, name])
  }
  const out: Record<string, Wire.JsonValue> = {}
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('x-')) continue
    if (!KEYWORDS.has(key)) throw new Refused('model_wire_tool_schema')
    if (key === 'properties') {
      if (!isObject(value)) throw new Refused('model_wire_tool_schema')
      out[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, inline(v, defs, stack)]))
    } else if (key === 'items') out[key] = inline(value, defs, stack)
    else if (key === 'additionalProperties') out[key] = isObject(value) ? inline(value, defs, stack) : value
    else if (key === 'anyOf') {
      if (!Array.isArray(value)) throw new Refused('model_wire_tool_schema')
      out[key] = value.map((branch) => inline(branch, defs, stack))
    } else out[key] = value
  }
  return out
}

function parameters(document: ToolSchemaDocument, digest: string): Wire.JsonValue {
  if (
    !isObject(document) ||
    typeof document.$ref !== 'string' ||
    !isObject(document.$defs) ||
    canonicalJsonDigest(document as unknown as Wire.JsonValue) !== digest
  )
    throw new Refused('model_wire_tool_schema')
  const root = document.$ref.match(/^#\/\$defs\/([A-Za-z_$][\w$]*)$/)?.[1]
  if (root === undefined || !Object.hasOwn(document.$defs, root)) throw new Refused('model_wire_tool_schema')
  const flat = inline({ $ref: document.$ref }, document.$defs, [])
  if (!isObject(flat) || flat.type !== 'object') throw new Refused('model_wire_tool_schema')
  if (utf8(flat) > MAX_PARAMETER_BYTES) throw new Refused('model_wire_tools_oversize')
  return flat
}

const utf8 = (value: Wire.JsonValue): number => new TextEncoder().encode(JSON.stringify(value)).length

/** Maps the catalog, in its own order, to wire tool schemas; the resolved input must pair one to one by index. */
export function resolveToolSchemas(
  catalog: Wire.ToolCatalog,
  resolved: ResolvedTools,
  prepared: Pick<Wire.PreparedModelRequest, 'target'>,
  capture: Readonly<{ route: { api: string }; model: { toolCallFormats: readonly string[] } }>,
): Outcome<ToolSchema[]> {
  if (resolved.length !== catalog.tools.length) return refuse('model_wire_tools')
  if (catalog.tools.length > MAX_TOOLS) return refuse('model_wire_tools_oversize')
  if (!prepared.target.features.tools) return refuse('model_wire_tool_feature')
  if (!capture.model.toolCallFormats.includes('native') || !APIS.has(capture.route.api))
    return refuse('model_wire_tool_format')
  const seen = new Set<string>()
  const tools: ToolSchema[] = []
  for (const [index, definition] of catalog.tools.entries()) {
    const entry = resolved[index]
    if (entry === undefined || entry.name !== definition.name) return refuse('model_wire_tool_schema')
    const unique = definition.name.normalize('NFC')
    if (!NAME.test(definition.name) || seen.has(unique)) return refuse('model_wire_tool_name')
    seen.add(unique)
    if (
      typeof entry.description !== 'string' ||
      entry.description.length === 0 ||
      entry.description.length > MAX_DESCRIPTION
    )
      return refuse('model_wire_tool_description')
    try {
      tools.push({
        name: definition.name,
        description: entry.description,
        parameters: parameters(entry.document, definition.inputSchema.digest),
      })
    } catch (error) {
      if (error instanceof Refused) return refuse(error.detailCode)
      throw error
    }
  }
  return { ok: true, value: tools }
}

type Call = { toolUseId: string; name: string; args: Wire.JsonValue; ordinal: number }
type Result = {
  toolUseId: string
  content: Extract<Message, { role: 'tool_result' }>['content']
  isError: boolean
}

function bodyOf(item: Wire.ContextItem, typeId: string): { readonly [key: string]: Wire.JsonValue } | null {
  const { body } = item
  return body.kind === 'inline' && body.schema.typeId === typeId && isObject(body.value) ? body.value : null
}

function callOf(item: Wire.ContextItem): Call | string {
  const body = bodyOf(item, TOOL_CALL_BODY_TYPE)
  if (body === null) return 'model_wire_item'
  if (item.trust !== 'derived') return 'model_wire_item'
  const keys = Object.keys(body).sort().join(',')
  const { toolUseId, name, args, ordinal } = body
  if (
    keys !== 'args,name,ordinal,toolUseId' ||
    typeof name !== 'string' ||
    !NAME.test(name) ||
    typeof ordinal !== 'number' ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0 ||
    args === undefined
  )
    return 'model_wire_tool_history'
  if (typeof toolUseId !== 'string' || !TOOL_USE_ID.test(toolUseId)) return 'model_wire_tool_id'
  return { toolUseId, name, args, ordinal }
}

function resultOf(item: Wire.ContextItem): Result | string {
  const body = bodyOf(item, TOOL_RESULT_BODY_TYPE)
  if (body === null) return 'model_wire_item'
  if (item.trust !== 'external' && item.trust !== 'derived') return 'model_wire_item'
  const { toolUseId, content, isError } = body
  if (
    Object.keys(body).sort().join(',') !== 'content,isError,toolUseId' ||
    typeof isError !== 'boolean' ||
    !Array.isArray(content) ||
    !content.every((block) => isObject(block) && block.type === 'text' && typeof block.text === 'string')
  )
    return 'model_wire_tool_history'
  if (typeof toolUseId !== 'string' || !TOOL_USE_ID.test(toolUseId)) return 'model_wire_tool_id'
  return { toolUseId, content: content as Result['content'], isError }
}

/**
 * Renders paired tool history. Consecutive calls become one assistant message in ordinal order and the run of
 * results that must follow answers exactly those calls, in the same order. Anything else is refused by name.
 */
export function renderToolHistory(
  items: readonly Wire.ContextItem[],
  at: number,
  generation: Wire.PreparedModelRequest['generation'],
  capture: Readonly<{ model: { thinkingReplay: string } }>,
): Outcome<{ messages: Message[]; next: number }> {
  const first = items[at] as Wire.ContextItem
  const messages: Message[] = []
  if (first.kind === 'tool-result') {
    const orphan = resultOf(first)
    return refuse(typeof orphan === 'string' ? orphan : 'model_wire_tool_pair')
  }
  if (generation.thinking !== null && capture.model.thinkingReplay === 'native')
    return refuse('model_wire_tool_thinking')
  const calls: Call[] = []
  let next = at
  while (items[next]?.kind === 'tool-call') {
    const item = items[next] as Wire.ContextItem
    const call = callOf(item)
    if (typeof call === 'string') return refuse(call)
    if (item.toolPairRef !== call.toolUseId) return refuse('model_wire_tool_pair')
    if (calls.some((other) => other.toolUseId === call.toolUseId || other.ordinal === call.ordinal))
      return refuse('model_wire_tool_pair')
    calls.push(call)
    next += 1
  }
  calls.sort((a, b) => a.ordinal - b.ordinal)
  const results = new Map<string, Result>()
  while (items[next]?.kind === 'tool-result') {
    const item = items[next] as Wire.ContextItem
    const result = resultOf(item)
    if (typeof result === 'string') return refuse(result)
    if (item.toolPairRef !== result.toolUseId || results.has(result.toolUseId))
      return refuse('model_wire_tool_pair')
    results.set(result.toolUseId, result)
    next += 1
  }
  if (results.size !== calls.length || calls.some((call) => !results.has(call.toolUseId)))
    return refuse('model_wire_tool_pair')
  messages.push({ role: 'assistant', content: [], toolCalls: calls })
  for (const call of calls) {
    const { content, isError } = results.get(call.toolUseId) as Result
    messages.push({ role: 'tool_result', toolUseId: call.toolUseId, content, isError })
  }
  return { ok: true, value: { messages, next } }
}
