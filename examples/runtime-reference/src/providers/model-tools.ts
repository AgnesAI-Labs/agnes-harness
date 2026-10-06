import type { RequestBody } from '@agnes/protocol'
import { canonicalJsonDigest, type JsonValue, type PreparedModelRequest } from '@agnes/protocol/runtime'

/*
 * The reference's own reading of a resolved tool catalog and of paired tool history. It shares no code with
 * the default; it is a rule table over the same public contract, and the differential test compares the two.
 */

type ToolSchema = RequestBody['tools'][number]
type WireMessage = RequestBody['messages'][number]
type Item = PreparedModelRequest['view']['items'][number]
type Capture = Readonly<{
  route: Record<string, JsonValue>
  model: { toolCallFormats: readonly string[]; thinkingReplay: string }
}>
type Fail = (detail: string) => never
type Obj = { readonly [key: string]: JsonValue }

/** One catalog tool as the resolver answers it: its name, its description and its schema document. */
export type ReferenceResolvedTool = Readonly<{ name: string; description: string; document: unknown }>
export type ReferenceResolvedTools = readonly ReferenceResolvedTool[]

const digestOf = (value: unknown) => canonicalJsonDigest(value as never)
const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The descriptions are not in the catalog, so they are bound inside the wire identity of the digest preimage. */
export const withDescriptions = (wire: object, tools: ReferenceResolvedTools | null): object =>
  tools === null ? wire : { ...wire, toolDescriptionsDigest: digestOf(tools.map((tool) => tool.description)) }

const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const USE_ID = /^[A-Za-z0-9_-]{1,64}$/
const ALLOWED = new Set(
  (
    'type properties required additionalProperties items anyOf enum const minLength maxLength minimum maximum ' +
    'exclusiveMinimum exclusiveMaximum minItems maxItems minProperties maxProperties description title'
  ).split(' '),
)
const ANY_JSON: JsonValue = {
  anyOf: [
    { type: 'null' },
    { type: 'boolean' },
    { type: 'number' },
    { type: 'string' },
    { type: 'array', items: { $ref: '#/$defs/JsonValue' }, maxItems: 10000, minItems: 0 },
    { type: 'object', additionalProperties: { $ref: '#/$defs/JsonValue' } },
  ],
}
const REF = /^#\/\$defs\/([A-Za-z_$][\w$]*)$/

function flatten(node: unknown, defs: Obj, path: readonly string[], fail: Fail): JsonValue {
  if (!isObj(node)) return fail('model_wire_tool_schema')
  if ('$ref' in node) {
    const target = typeof node.$ref === 'string' ? REF.exec(node.$ref)?.[1] : undefined
    if (target === undefined || Object.keys(node).length !== 1 || !Object.hasOwn(defs, target))
      return fail('model_wire_tool_schema')
    const body = defs[target]
    if (target === 'JsonValue' && digestOf(body) === digestOf(ANY_JSON)) return {}
    if (path.includes(target)) return fail('model_wire_tool_schema_recursive')
    return flatten(body, defs, [...path, target], fail)
  }
  const out: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('x-')) continue
    if (!ALLOWED.has(key)) return fail('model_wire_tool_schema')
    const below = (child: unknown) => flatten(child, defs, path, fail)
    if (key === 'properties') {
      if (!isObj(value)) return fail('model_wire_tool_schema')
      out[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, below(child)]))
    } else if (key === 'items') out[key] = below(value)
    else if (key === 'additionalProperties') out[key] = isObj(value) ? below(value) : value
    else if (key === 'anyOf') {
      if (!Array.isArray(value)) return fail('model_wire_tool_schema')
      out[key] = value.map(below)
    } else out[key] = value
  }
  return out
}

function parametersOf(document: unknown, bound: string, fail: Fail): JsonValue {
  if (!isObj(document) || typeof document.$ref !== 'string' || !isObj(document.$defs))
    return fail('model_wire_tool_schema')
  if (digestOf(document) !== bound) return fail('model_wire_tool_schema')
  const root = REF.exec(document.$ref)?.[1]
  if (root === undefined || !Object.hasOwn(document.$defs, root)) return fail('model_wire_tool_schema')
  const flat = flatten({ $ref: document.$ref }, document.$defs, [], fail)
  if (!isObj(flat) || flat.type !== 'object') return fail('model_wire_tool_schema')
  return new TextEncoder().encode(JSON.stringify(flat)).length > 262144
    ? fail('model_wire_tools_oversize')
    : flat
}

/** The wire tools for a catalog, in catalog order; the answer must pair with the catalog one to one. */
export function toolSchemasOf(
  catalog: PreparedModelRequest['toolCatalog'] & object,
  answer: ReferenceResolvedTools,
  prepared: PreparedModelRequest,
  capture: Capture,
  fail: Fail,
): ToolSchema[] {
  const gates: Array<[string, boolean]> = [
    ['model_wire_tools', answer.length !== catalog.tools.length],
    ['model_wire_tools_oversize', catalog.tools.length > 128],
    ['model_wire_tool_feature', !prepared.target.features.tools],
    [
      'model_wire_tool_format',
      !capture.model.toolCallFormats.includes('native') ||
        !['openai-completions', 'anthropic-messages'].includes(String(capture.route.api)),
    ],
  ]
  for (const [detail, applies] of gates) if (applies) fail(detail)
  const names = new Set<string>()
  return catalog.tools.map((definition, at) => {
    const entry = answer[at]
    if (entry === undefined || entry.name !== definition.name) return fail('model_wire_tool_schema')
    const folded = definition.name.normalize('NFC')
    if (!TOOL_NAME.test(definition.name) || names.has(folded)) return fail('model_wire_tool_name')
    names.add(folded)
    const text = entry.description
    if (typeof text !== 'string' || text.length === 0 || text.length > 4096)
      return fail('model_wire_tool_description')
    return {
      name: definition.name,
      description: text,
      parameters: parametersOf(entry.document, definition.inputSchema.digest, fail),
    }
  })
}

const bodyOf = (item: Item, typeId: string): Obj | null =>
  item.body.kind === 'inline' && item.body.schema.typeId === typeId && isObj(item.body.value)
    ? item.body.value
    : null
const sameKeys = (value: Obj, keys: string) => Object.keys(value).sort().join(',') === keys

type Call = { toolUseId: string; name: string; args: JsonValue; ordinal: number }
type Back = { toolUseId: string; content: JsonValue[]; isError: boolean }

function callOf(item: Item): Call | string {
  const body = bodyOf(item, 'agh.context/tool-call-body@1')
  if (body === null || item.trust !== 'derived') return 'model_wire_item'
  const { toolUseId, name, args, ordinal } = body
  if (
    !sameKeys(body, 'args,name,ordinal,toolUseId') ||
    typeof name !== 'string' ||
    !TOOL_NAME.test(name) ||
    typeof ordinal !== 'number' ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0
  )
    return 'model_wire_tool_history'
  if (typeof toolUseId !== 'string' || !USE_ID.test(toolUseId)) return 'model_wire_tool_id'
  return { toolUseId, name, args: args as JsonValue, ordinal }
}

function backOf(item: Item): Back | string {
  const body = bodyOf(item, 'agh.context/tool-result-body@1')
  if (body === null || (item.trust !== 'external' && item.trust !== 'derived')) return 'model_wire_item'
  const { toolUseId, content, isError } = body
  if (
    !sameKeys(body, 'content,isError,toolUseId') ||
    typeof isError !== 'boolean' ||
    !Array.isArray(content) ||
    !content.every((block) => isObj(block) && block.type === 'text' && typeof block.text === 'string')
  )
    return 'model_wire_tool_history'
  if (typeof toolUseId !== 'string' || !USE_ID.test(toolUseId)) return 'model_wire_tool_id'
  return { toolUseId, content, isError }
}

/** The calls from `start` and the results that answer them; returns the messages and where the run ends. */
export function toolHistoryOf(
  items: readonly Item[],
  start: number,
  prepared: PreparedModelRequest,
  capture: Capture,
  fail: Fail,
): { messages: WireMessage[]; end: number } {
  const first = items[start] as Item
  if (first.kind === 'tool-result') {
    const orphan = backOf(first)
    return fail(typeof orphan === 'string' ? orphan : 'model_wire_tool_pair')
  }
  if (prepared.generation.thinking !== null && capture.model.thinkingReplay === 'native')
    return fail('model_wire_tool_thinking')
  const calls: Call[] = []
  let at = start
  for (; items[at]?.kind === 'tool-call'; at += 1) {
    const item = items[at] as Item
    const call = callOf(item)
    if (typeof call === 'string') return fail(call)
    if (
      item.toolPairRef !== call.toolUseId ||
      calls.some((other) => other.toolUseId === call.toolUseId || other.ordinal === call.ordinal)
    )
      return fail('model_wire_tool_pair')
    calls.push(call)
  }
  calls.sort((a, b) => a.ordinal - b.ordinal)
  const answers = new Map<string, Back>()
  for (; items[at]?.kind === 'tool-result'; at += 1) {
    const item = items[at] as Item
    const back = backOf(item)
    if (typeof back === 'string') return fail(back)
    if (item.toolPairRef !== back.toolUseId || answers.has(back.toolUseId))
      return fail('model_wire_tool_pair')
    answers.set(back.toolUseId, back)
  }
  if (answers.size !== calls.length || calls.some((call) => !answers.has(call.toolUseId)))
    return fail('model_wire_tool_pair')
  const messages: WireMessage[] = [{ role: 'assistant', content: [], toolCalls: calls }]
  for (const call of calls) {
    const { toolUseId, content, isError } = answers.get(call.toolUseId) as Back
    messages.push({ role: 'tool_result', toolUseId, content, isError } as WireMessage)
  }
  return { messages, end: at }
}
