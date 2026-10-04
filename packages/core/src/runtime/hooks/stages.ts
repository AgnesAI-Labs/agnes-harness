import type { AuthorSchema, InterceptorDefinition, InterceptorInput } from '@agnes/extension-api/runtime'
import { HOOK_TABLE, validateHook } from '@agnes/protocol'
import type { ContextPayload, ContextReturn, ToolCallReturn } from '@agnes/protocol/gen/hooks'
import {
  boundedCanonicalJson,
  type CapabilityRequirement,
  canonicalJsonDigest,
  type DataRef,
  type EffectiveHookSnapshot,
  type HookRegistrationSnapshot,
  type HookResultSet,
  type HookStageRequest,
  type InterceptorInvocation,
  type InterceptorRegistration,
  type JsonValue,
  RuntimeAuthorCodecPolicy,
  type RuntimeError,
  RuntimeInterceptorPolicy,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { authorHookReturn, contextReturnToWire } from '../../hooks/returns.js'
import { assertAuthorSchema } from '../providers/accounting.js'

type Event = 'context' | 'tool_call'
type Definition = InterceptorDefinition<'context', JsonValue> | InterceptorDefinition<'tool_call', JsonValue>
export interface PureHookRegistration {
  readonly snapshot: HookRegistrationSnapshot
  readonly metadata: InterceptorRegistration
  readonly definition: Definition
  readonly config: JsonValue
}
/** Pure algorithm inputs are values, not execution grants or evidence of an installed stage. */
export interface PureHookStage {
  readonly request: HookStageRequest
  readonly effective: EffectiveHookSnapshot
  readonly registrations: readonly PureHookRegistration[]
  readonly invocation: InterceptorInvocation
  readonly sourceActionId: string
  readonly access: Readonly<{
    readFields: readonly string[]
    writeFields: readonly string[]
    permissions: readonly CapabilityRequirement[]
  }>
  readonly codecs: Readonly<{
    context: AuthorSchema<ContextReturn>
    tool_call: AuthorSchema<ToolCallReturn>
  }>
  readonly signal: AbortSignal
}
export class PureHookStageFailure extends TypeError {
  readonly error: RuntimeError
  constructor(code: RuntimeError['code'], detailCode: string) {
    super('Pure Hook stage refused')
    this.error = {
      code,
      detailCode,
      message: this.message,
      diagnosticId: 'effects-stage',
      retryAdvice: { kind: 'never' },
    }
  }
}
function refuse(detail: string): never {
  throw new PureHookStageFailure('invalid_input', detail)
}
function freeze(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
}
function json(value: unknown): JsonValue {
  const limits = RuntimeAuthorCodecPolicy.payload
  const result = boundedCanonicalJson(value, {
    maxBytes: limits.maxCanonicalJsonBytes,
    maxDepth: limits.maxDepth,
    maxMembers: limits.maxMembers,
  })
  if (!result.ok) refuse('hook_payload_invalid')
  freeze(result.value.json)
  return result.value.json
}
function same(a: unknown, b: unknown) {
  return canonicalJsonDigest(json(a)) === canonicalJsonDigest(json(b))
}
function readInline(ref: DataRef): JsonValue {
  if (!validateRuntime('DataRef', ref).ok || ref.kind !== 'inline') refuse('hook_inline_source_required')
  const value = json(ref.value)
  const proof = boundedCanonicalJson(value, {
    maxBytes: RuntimeAuthorCodecPolicy.maxInlineBytes,
    maxDepth: RuntimeAuthorCodecPolicy.payload.maxDepth,
    maxMembers: RuntimeAuthorCodecPolicy.payload.maxMembers,
  })
  if (!proof.ok || proof.value.bytes !== ref.bytes || canonicalJsonDigest(value) !== ref.digest)
    refuse('hook_input_proof')
  return value
}
function encode<T>(codec: AuthorSchema<T>, value: T): DataRef {
  const result = codec.encode(value)
  if (!result.ok || !same(result.value.schema, codec.ref) || !same(readInline(result.value), value))
    refuse('hook_output_proof')
  return Object.freeze({ ...result.value })
}
function definitionFields(definition: Definition): void {
  for (const key of Reflect.ownKeys(definition)) {
    const descriptor = Object.getOwnPropertyDescriptor(definition, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) refuse('hook_definition_accessor')
  }
}
function ordered(stage: PureHookStage): PureHookRegistration[] {
  const request = validateRuntime('HookStageRequest', json(stage.request))
  const effective = validateRuntime('EffectiveHookSnapshot', json(stage.effective))
  const invocation = validateRuntime('InterceptorInvocation', json(stage.invocation))
  if (!request.ok || !effective.ok || !invocation.ok) refuse('hook_stage_schema')
  const r = request.value,
    e = effective.value,
    i = invocation.value
  if (r.event !== 'context' && r.event !== 'tool_call')
    throw new PureHookStageFailure('incompatible', 'hook_event_unsupported')
  const { digest, ...body } = e
  if (
    digest !== canonicalJsonDigest(body) ||
    r.registrationDigest !== digest ||
    r.event !== e.event ||
    r.inputDigest !== canonicalJsonDigest(r.input)
  )
    refuse('hook_stage_digest')
  if (
    i.runId !== r.owner.runId ||
    i.actionId !== r.owner.actionId ||
    i.requestId !== r.owner.requestId ||
    i.stageId !== r.stageId ||
    i.receiptId !== null ||
    i.attempt !== null ||
    !validateRuntime('Id', stage.sourceActionId).ok
  )
    refuse('hook_invocation_identity')
  if (!e.registrations.length || e.registrations.length !== stage.registrations.length)
    refuse('hook_registration_set')
  const map = new Map<string, PureHookRegistration>(),
    ordinals = new Set<number>()
  for (const entry of stage.registrations) {
    definitionFields(entry.definition)
    const metadata = validateRuntime('InterceptorRegistration', json(entry.metadata))
    const d = entry.definition,
      s = entry.snapshot
    if (!metadata.ok || d.execution !== 'pure')
      throw new PureHookStageFailure('incompatible', 'hook_execution_unsupported')
    const m = metadata.value
    if (map.has(m.id) || ordinals.has(s.ordinal)) refuse('hook_registration_duplicate')
    if (
      m.event !== r.event ||
      d.event !== r.event ||
      m.id !== d.id ||
      m.id !== s.registrationId ||
      typeof d.handle !== 'function'
    )
      refuse('hook_registration_identity')
    if (!e.registrations.some((fixed) => same(fixed, s))) refuse('hook_snapshot_relation')
    if (!['serial', 'waterfall'].includes(s.mode))
      throw new PureHookStageFailure('incompatible', 'hook_mode_unsupported')
    if (
      m.category !== RuntimeInterceptorPolicy[r.event].category ||
      s.category !== m.category ||
      s.failPolicy !== m.failPolicy ||
      s.timeoutMs !== m.timeoutMs ||
      m.execution !== 'pure' ||
      m.effects.length
    )
      refuse('hook_registration_policy')
    const policy = HOOK_TABLE[r.event]
    if (
      (policy.failPolicy === 'closed' && m.failPolicy !== 'closed') ||
      (m.mandatory && m.failPolicy !== 'closed') ||
      m.timeoutMs > policy.timeoutMs
    )
      refuse('hook_policy_weakened')
    for (const key of [
      'priority',
      'before',
      'after',
      'mandatory',
      'failPolicy',
      'timeoutMs',
      'readFields',
      'writeFields',
      'permissions',
    ] as const) {
      if (!same(m[key], d[key])) refuse('hook_definition_metadata')
    }
    if (
      m.readFields.some((field) => !stage.access.readFields.includes(field)) ||
      m.writeFields.some((field) => !stage.access.writeFields.includes(field)) ||
      m.permissions.some(
        (permission) => !stage.access.permissions.some((allowed) => same(permission, allowed)),
      )
    )
      throw new PureHookStageFailure('denied', 'hook_projection_denied')
    const configured = json(entry.config)
    if (d.config) {
      assertAuthorSchema(d.config.schema)
      if (!same(m.configSchema, d.config.schema.ref) || !d.config.schema.parse(configured).ok)
        refuse('hook_config_schema')
    } else if (!validateRuntime('RuntimeEmptyAuthorConfig', configured).ok) refuse('hook_config_schema')
    const definition = Object.freeze({ ...d })
    map.set(
      m.id,
      Object.freeze({
        ...entry,
        metadata: m,
        snapshot: e.registrations.find((fixed) => fixed.registrationId === m.id) ?? s,
        definition,
        config: json(entry.config),
      }),
    )
    ordinals.add(s.ordinal)
  }
  const incoming = new Map([...map.keys()].map((id) => [id, new Set<string>()]))
  for (const [id, entry] of map) {
    for (const other of entry.metadata.before) {
      if (!map.has(other) || other === id) refuse('hook_order_target')
      incoming.get(other)?.add(id)
    }
    for (const other of entry.metadata.after) {
      if (!map.has(other) || other === id) refuse('hook_order_target')
      incoming.get(id)?.add(other)
    }
  }
  const result: PureHookRegistration[] = []
  while (incoming.size) {
    const layer = [...incoming].filter(([, edges]) => !edges.size).map(([id]) => id)
    if (!layer.length) refuse('hook_order_cycle')
    layer.sort((a, b) => {
      const left = map.get(a),
        right = map.get(b)
      if (!left || !right) refuse('hook_order_identity')
      return left.metadata.priority - right.metadata.priority || (a < b ? -1 : a > b ? 1 : 0)
    })
    for (const id of layer) {
      const entry = map.get(id)
      if (!entry) refuse('hook_order_identity')
      result.push(entry)
      incoming.delete(id)
    }
    for (const edges of incoming.values()) for (const id of layer) edges.delete(id)
  }
  if (result.some((entry, index) => entry.snapshot.ordinal !== index)) refuse('hook_order_ordinal')
  return result
}
async function bounded<T>(
  signal: AbortSignal,
  timeout: number,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw new PureHookStageFailure('cancelled', 'hook_cancelled')
  const local = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      local.abort()
      reject(new PureHookStageFailure('cancelled', 'hook_cancelled'))
    }
    signal.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => {
      local.abort()
      reject(new PureHookStageFailure('timeout', 'hook_timeout'))
    }, timeout)
  })
  try {
    return await Promise.race([Promise.resolve().then(() => call(local.signal)), interrupted])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (abort) signal.removeEventListener('abort', abort)
    local.abort()
  }
}
function project(payload: JsonValue, fields: readonly string[]): JsonValue {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) refuse('hook_payload_object')
  const result: Record<string, JsonValue> = {}
  for (const field of fields) {
    const key = field.slice(1)
    if (Object.hasOwn(payload, key)) {
      const value = payload[key]
      if (value === undefined) refuse('hook_payload_undefined')
      result[key] = value
    }
  }
  return json(result)
}
/** No State, effects ports, identity issuer or implicit permission/current checks are installed here. */
export async function runPureHookStage(
  stage: PureHookStage,
): Promise<Readonly<{ outcome: 'completed' | 'denied'; result: HookResultSet }>> {
  stage = {
    ...stage,
    codecs: Object.freeze({ context: stage.codecs.context, tool_call: stage.codecs.tool_call }),
    request: json(stage.request) as HookStageRequest,
    effective: json(stage.effective) as EffectiveHookSnapshot,
    invocation: json(stage.invocation) as InterceptorInvocation,
  }
  assertAuthorSchema(stage.codecs.context)
  assertAuthorSchema(stage.codecs.tool_call)
  const entries = ordered(stage),
    event: Event = stage.request.event === 'context' ? 'context' : 'tool_call'
  const original = readInline(stage.request.input)
  if (!validateHook(event, 'payload', original).ok) refuse('hook_event_payload')
  const invocation = json(stage.invocation) as InterceptorInvocation
  let candidate = original,
    output: ContextReturn | ToolCallReturn =
      event === 'context' ? { sections: (original as ContextPayload).sections } : { allow: true }
  let denied = false
  const results: HookResultSet['entries'] = []
  for (const entry of entries) {
    if (stage.signal.aborted) throw new PureHookStageFailure('cancelled', 'hook_cancelled')
    try {
      const value = await bounded(stage.signal, entry.metadata.timeoutMs, async (signal) => {
        const context = Object.freeze({
          signal,
          config: json(entry.config),
          invocation,
          log: (_message: string) => undefined,
        })
        const d = entry.definition
        if (d.execution !== 'pure')
          throw new PureHookStageFailure('incompatible', 'hook_execution_unsupported')
        let projected = project(candidate, entry.metadata.readFields)
        if (d.event === 'context') {
          if (
            projected &&
            typeof projected === 'object' &&
            !Array.isArray(projected) &&
            Array.isArray(projected.sections)
          ) {
            projected = json({
              ...projected,
              sections: projected.sections.map((section) => {
                if (!section || typeof section !== 'object' || Array.isArray(section)) refuse('hook_section')
                return { id: section.id, order: section.order, content: section.text }
              }),
            })
          }
          return contextReturnToWire(
            authorHookReturn('context', await d.handle(projected as InterceptorInput<'context'>, context)),
          )
        }
        return authorHookReturn(
          'tool_call',
          await d.handle(projected as InterceptorInput<'tool_call'>, context),
        )
      })
      const safe = json(value)
      if (!safe || typeof safe !== 'object' || Array.isArray(safe)) refuse('hook_return_object')
      for (const key of Object.keys(safe))
        if (!entry.metadata.writeFields.includes(`/${key}`)) refuse('hook_write_denied')
      let ref: DataRef
      if (event === 'context') {
        const checked = validateHook('context', 'return', safe)
        if (!checked.ok) refuse('hook_return_schema')
        const patch = safe as ContextReturn
        ref = encode(stage.codecs.context, patch)
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
          refuse('hook_context_candidate')
        const current = candidate
        const sections = new Map((current as ContextPayload).sections.map((section) => [section.id, section]))
        for (const section of patch.sections ?? []) sections.set(section.id, section)
        const merged = [...sections.values()].sort((a, b) => a.order - b.order)
        candidate = json({ ...current, sections: merged })
        output = { ...output, ...patch, sections: merged }
      } else {
        const checked = validateHook('tool_call', 'return', safe)
        if (!checked.ok) refuse('hook_return_schema')
        const decision = safe as ToolCallReturn
        ref = encode(stage.codecs.tool_call, decision)
        if (!decision.allow) {
          denied = true
          if (!('allow' in output) || output.allow !== false) output = decision
        }
      }
      results.push({
        registrationId: entry.metadata.id,
        ordinal: entry.snapshot.ordinal,
        outcome: event === 'tool_call' && 'allow' in value && !value.allow ? 'denied' : 'applied',
        output: ref,
        diagnosticId: null,
      })
    } catch (error) {
      if (stage.signal.aborted || (error instanceof PureHookStageFailure && error.error.code === 'cancelled'))
        throw new PureHookStageFailure('cancelled', 'hook_cancelled')
      const closed = entry.metadata.failPolicy === 'closed'
      const diagnosticId = `hook-${canonicalJsonDigest({ stageId: stage.request.stageId, registrationId: entry.metadata.id })}`
      results.push({
        registrationId: entry.metadata.id,
        ordinal: entry.snapshot.ordinal,
        outcome: closed ? 'denied' : 'failed-open',
        output: null,
        diagnosticId,
      })
      if (closed) {
        denied = true
        if (event === 'tool_call' && (!('allow' in output) || output.allow !== false))
          output = { allow: false, reason: 'Mandatory Hook failed' }
      }
    }
  }
  if (stage.signal.aborted) throw new PureHookStageFailure('cancelled', 'hook_cancelled')
  const final =
    event === 'context'
      ? encode(stage.codecs.context, output as ContextReturn)
      : encode(stage.codecs.tool_call, output as ToolCallReturn)
  const body = {
    stageId: stage.request.stageId,
    event,
    registrationDigest: stage.request.registrationDigest,
    inputDigest: stage.request.inputDigest,
    entries: results,
    output: final,
    sourceActionId: stage.sourceActionId,
  }
  const result = { ...body, digest: canonicalJsonDigest(json(body)) }
  if (!validateRuntime('HookResultSet', result).ok) refuse('hook_result_schema')
  freeze(result)
  return Object.freeze({ outcome: denied ? 'denied' : 'completed', result })
}
