import type { DecisionBackend, JsonValue, ModelSettlement, PreparedModelCall } from '@agnes/jev-runtime'
import { durableJson, freezeJson } from './model-json.js'

export interface DecisionRequest {
  readonly model: string
  readonly state: JsonValue
  readonly questions: Readonly<Record<string, JsonValue>>
}

/** Host transport owns credentials, HTTP limits and cancellation; it must make one attempt. */
export interface DecisionTransport {
  invoke(request: DecisionRequest, signal: AbortSignal): Promise<ModelSettlement>
}

export interface DecisionConnection {
  readonly backend: 'jev' | 'laya'
  readonly endpoint: string
  readonly model: string
  /** Optional Host price evidence; evaluated and frozen before the durable request barrier. */
  readonly pricing?: () => JsonValue
  readonly transport: DecisionTransport
}

/** Render Jev's wire view only; ledger rule facts and language inputs stay structured. */
function jevRules(state: JsonValue): JsonValue {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return state
  const rules = state.rules
  if (!Array.isArray(rules) || !rules.length) return state
  const blocks: string[] = []
  for (const rule of rules) {
    if (
      rule === null ||
      typeof rule !== 'object' ||
      Array.isArray(rule) ||
      Object.keys(rule).sort().join(',') !== 'scope,source,text' ||
      typeof rule.source !== 'string' ||
      typeof rule.scope !== 'string' ||
      typeof rule.text !== 'string' ||
      /[\r\n]/u.test(rule.source + rule.scope)
    )
      return state
    blocks.push(`Source: ${rule.source}\nScope: ${rule.scope}\n${rule.text}`)
  }
  return { ...state, rules: blocks.join('\n\n') }
}

/** Keep the skill catalog's full descriptions and metadata, compacting known entries only. */
function jevState(input: JsonValue): JsonValue {
  const state = jevRules(input)
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return state
  const resources = state.resources
  if (resources === null || typeof resources !== 'object' || Array.isArray(resources)) return state
  const skills = resources.skills
  if (skills === null || typeof skills !== 'object' || Array.isArray(skills)) return state
  if (!Array.isArray(skills.items) || !skills.items.length) return state
  const entries: [string, string][] = []
  for (const item of skills.items) {
    if (
      item === null ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).sort().join(',') !== 'description,name' ||
      typeof item.name !== 'string' ||
      typeof item.description !== 'string'
    )
      return state
    entries.push([item.name, item.description])
  }
  const items = Object.fromEntries(entries)
  const names = Object.keys(items)
  if (names.length !== entries.length || names.some((name, index) => name !== entries[index]?.[0]))
    return state
  return { ...state, resources: { ...resources, skills: { ...skills, items } } }
}

const CONTEXT = 'Apply the shared decision guidance in state.rules.'
const OPERATION_REFERENCE = "Each criterion's operation names its definition in state.operations."
const OPTION_REFERENCE = 'Each option name identifies its complete definition in state.operations.'
const PARAMETER_EXIT =
  'Keep this operation and have the language helper author all arguments when no offered complete call fits.'

function objectValue(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/** Recognize the complete compiler-owned question shape before changing any visible field. */
function jevQuestions(
  state: JsonValue,
  questions: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  const definitions = objectValue(objectValue(state)?.operations)
  if (!definitions) return questions
  const result = { ...questions }
  const purposeHead = objectValue(questions.purpose)
  const purposes = purposeHead?.type === 'choice' ? objectValue(purposeHead.criteria) : undefined
  for (const purpose of ['INSPECT', 'ACT', 'VERIFY']) {
    const id = `operation_${purpose}`
    const head = objectValue(questions[id])
    const criteria = objectValue(head?.criteria)
    const info = objectValue(purposes?.[purpose])
    if (
      !head ||
      Object.keys(head).sort().join(',') !== 'criteria,instructions,type' ||
      head.type !== 'choice' ||
      !criteria ||
      !Object.keys(criteria).length ||
      typeof info?.description !== 'string' ||
      Object.keys(info).sort().join(',') !== 'description,operations' ||
      JSON.stringify(info.operations) !== JSON.stringify(Object.keys(criteria))
    )
      continue
    const instructions = `Assume the immediate purpose is ${purpose}: ${info.description} ${OPERATION_REFERENCE} Select the operation whose result serves that purpose for the active request. ${CONTEXT}`
    if (
      head.instructions !== instructions ||
      instructions.indexOf(OPERATION_REFERENCE) !== instructions.lastIndexOf(OPERATION_REFERENCE) ||
      Object.entries(criteria).some(([name, value]) => {
        const reference = objectValue(value)
        const definition = objectValue(definitions[name])
        return (
          !reference ||
          Object.keys(reference).join(',') !== 'operation' ||
          reference.operation !== name ||
          typeof definition?.description !== 'string' ||
          !Array.isArray(definition.purposes) ||
          !definition.purposes.includes(purpose)
        )
      })
    )
      continue
    result[id] = {
      ...head,
      criteria: Object.fromEntries(Object.keys(criteria).map((name) => [name, null])),
      instructions: instructions.replace(OPERATION_REFERENCE, OPTION_REFERENCE),
    }
  }
  for (const [id, value] of Object.entries(questions)) {
    if (!id.startsWith('binding_')) continue
    const operation = id.slice('binding_'.length)
    const head = objectValue(value)
    const criteria = objectValue(head?.criteria)
    const definition = objectValue(definitions[operation])
    const instructions = `Assume the next operation is ${JSON.stringify(operation)}. Select one offered complete invocation that fits the active request and evidence, or LLM_PARAMETERS to author all its arguments. Do not choose a different operation. Offered calls are finite, not exhaustive. A known path locates a possible read but does not establish contents. ${CONTEXT}`
    if (
      !head ||
      Object.keys(head).sort().join(',') !== 'criteria,instructions,type' ||
      head.type !== 'choice' ||
      head.instructions !== instructions ||
      typeof definition?.description !== 'string' ||
      definition?.parameterMode !== 'parameterized' ||
      !criteria ||
      Object.keys(criteria).length < 2
    )
      continue
    const compacted: [string, string][] = []
    for (const [index, [key, text]] of Object.entries(criteria).entries()) {
      if (key !== (index === 0 ? 'LLM_PARAMETERS' : `c${index}`)) break
      const body = bindingBody(text, operation, index === 0)
      if (body === undefined) break
      compacted.push([key, body])
    }
    if (compacted.length === Object.keys(criteria).length)
      result[id] = { ...head, criteria: Object.fromEntries(compacted) }
  }
  return result
}

function bindingBody(value: JsonValue, operation: string, fallback: boolean): string | undefined {
  if (typeof value !== 'string') return
  const lines = value.split('\n')
  if (lines.length !== 3 || lines[0] !== `operation: ${JSON.stringify(operation)}`) return
  if (fallback) {
    if (
      lines[1] !== 'mode: "author_parameters"' ||
      lines[2] !== `description: ${JSON.stringify(PARAMETER_EXIT)}`
    )
      return
  } else {
    if (!lines[1]?.startsWith('description: ') || !lines[2]?.startsWith('arguments: ')) return
    const description = lines[1].slice('description: '.length)
    const args = lines[2].slice('arguments: '.length)
    try {
      const label = JSON.parse(description)
      const parameters = JSON.parse(args)
      if (
        typeof label !== 'string' ||
        JSON.stringify(label) !== description ||
        !objectValue(parameters) ||
        JSON.stringify(parameters) !== args
      )
        return
    } catch {
      return
    }
  }
  return lines.slice(1).join('\n')
}

/** Preserve System One score output for the core's purpose/operation/binding validator. */
export function decodeDecisionResponse(value: unknown): ModelSettlement {
  const output = durableJson(value)
  if (output === null || typeof output !== 'object' || Array.isArray(output))
    return {
      error: {
        code: 'DECISION_INVALID_RESPONSE',
        message: 'Expected a decision response object',
        retryable: false,
      },
    }
  return {
    output,
    snapshot: { codec: 'systemone-json-v1', response: output },
    ...(typeof output.model === 'string' ? { observedModel: output.model } : {}),
    ...(output.routing === undefined ? {} : { routing: output.routing }),
    ...(output.usage === undefined ? {} : { usage: output.usage }),
  }
}

/** No language-provider fallback: callers must mark Jev unavailable without this transport. */
export function createDecisionBackend(connection: DecisionConnection): DecisionBackend {
  const endpoint = new URL(connection.endpoint)
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new TypeError('Decision endpoint must not contain credentials, query or fragment')
  if (!connection.model.trim()) throw new TypeError('Decision model is required')
  const pending = new WeakMap<PreparedModelCall, DecisionRequest>()
  return {
    async prepare(input, signal) {
      signal.throwIfAborted()
      const request = structuredClone({
        model: connection.model,
        state: input.state,
        questions: input.questions,
      })
      if (connection.backend === 'jev') {
        request.state = jevState(request.state)
        request.questions = jevQuestions(request.state, request.questions)
      }
      freezeJson(request)
      const call: PreparedModelCall = freezeJson({
        purpose: 'decision',
        backend: connection.backend,
        endpoint: connection.endpoint,
        requestedModel: connection.model,
        codec: 'systemone-json-v1',
        input: durableJson(request),
        ...(connection.pricing ? { pricing: durableJson(connection.pricing()) } : {}),
        inputCursor: input.inputCursor,
      })
      pending.set(call, request)
      return call
    },
    async invoke(call, signal) {
      const request = pending.get(call)
      if (request === undefined) throw new Error('Decision call was not prepared here or was already invoked')
      pending.delete(call)
      signal.throwIfAborted()
      return connection.transport.invoke(request, signal)
    },
  }
}
