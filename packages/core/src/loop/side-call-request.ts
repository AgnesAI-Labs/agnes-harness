import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import { CoreError } from '@agnes/core-common/types'
import { withTimeout } from '@agnes/core-effects/effects/wrap'
import type { PreparedSideCall, SideCallOptions } from '@agnes/extension-api'
import {
  inspectJsonData,
  type JsonValue,
  type ModelRecord,
  type Provider,
  type RequestBody,
  validateAgainst,
} from '@agnes/protocol'
import { RequestMessage as MessageSchema, ThinkingLevel as ThinkingSchema } from '@agnes/protocol/gen/model'
import { estimateTokens } from '../execution/model-tokens.js'
import { SIDE_CALL_DEADLINE_MS, sideCallEffectId } from '../orchestrator/side-call-effect-port.js'
import type { SideCallPlan } from '../orchestrator/side-call-executor.js'
import { bounded, ownData } from '../orchestrator/side-call-terminal.js'
import type { SessionImpl } from '../step/session.js'

const LABEL = /^[a-z][a-z0-9._-]{0,63}$/u
const INVOCATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,122}$/u
const SENSITIVE = /(?:authorization|bearer|credential|secret|password|api[_-]?key|token|sk-[A-Za-z0-9])/iu
const HOST = /^[^\s/\\@?#]+$/u
const MAX_BYTES = 1_048_576
const MAX_SYSTEM_CHARS = 1_048_576
const DEFAULT_DEADLINE_MS = 10_000
const COUNT_TIMEOUT_MS = 5_000

type RouteDescription = ReturnType<NonNullable<Provider['describeRoute']>>

/** A prepared call as Core keeps it, beside the frozen object the loop holds. */
export type SideCallRequest = SideCallPlan &
  Readonly<{
    turnId: number
    /** Digest of the catalog record and the provider's full route description; never written. */
    targetDigest: string
  }>

const envelope = (reason: string, message: string) => new CoreError('E_ENVELOPE', message, { reason })
const digest = (value: unknown) => sha256Hex(canonicalJson(value))

export const noTurn = () =>
  new CoreError('E_RELATION', 'A side call requires an open turn', { reason: 'no-turn' })

/** Refuses an invocation id the effect id cannot carry, or one that looks like a credential. */
export function checkInvocationId(value: unknown): string {
  if (typeof value !== 'string' || !INVOCATION_ID.test(value) || SENSITIVE.test(value))
    throw envelope('invocation-id', 'Side call invocationId is invalid')
  return value
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/** The catalog record of a route and model, and what the provider says would serve it. */
function resolveTarget(s: SessionImpl, route: unknown, model: unknown) {
  if (typeof route !== 'string' || typeof model !== 'string') return undefined
  let record: ModelRecord | undefined
  let description: RouteDescription
  try {
    record = s.d.provider.models().find((item) => item.route === route && item.id === model)
  } catch {
    return undefined
  }
  if (!record) return undefined
  try {
    description = s.d.provider.describeRoute?.(route, model)
  } catch {
    // A provider that cannot describe the route leaves the call without an adapter identity.
    description = undefined
  }
  return { record, description, digest: digest({ record, description: description ?? null }) }
}

/** The audit identity of the adapter behind a route; null when the provider gives none it can record. */
function adapterOf(description: RouteDescription): PreparedSideCall['adapter'] {
  const adapter = description?.adapter
  if (
    !description ||
    !bounded(adapter?.id, 128) ||
    (adapter.version !== null && !bounded(adapter.version, 64)) ||
    !bounded(description.api, 128)
  )
    return null
  const host = description.endpointHost
  return Object.freeze({
    id: adapter.id,
    version: adapter.version,
    api: description.api,
    endpointHost: bounded(host, 253) && HOST.test(host) ? host : null,
  })
}

function messagesOf(value: unknown): RequestBody['messages'] {
  if (value === undefined) return []
  let messages: unknown
  try {
    messages = structuredClone(value)
  } catch {
    messages = undefined
  }
  if (
    !Array.isArray(messages) ||
    messages.some(
      (message) =>
        !validateAgainst(MessageSchema, message).ok ||
        (message.role !== 'user' && message.role !== 'assistant') ||
        Object.hasOwn(message, 'toolCalls'),
    )
  )
    throw envelope('messages', 'Side call messages are user and assistant content with no tool calls')
  return deepFreeze(messages as RequestBody['messages'])
}

function samplingOf(value: unknown): RequestBody['sampling'] {
  if (value === undefined) return undefined
  const sampling = ownData(value, [], ['temperature', 'maxTokens', 'thinking'])
  const { temperature, maxTokens, thinking } = sampling ?? {}
  if (
    !sampling ||
    (temperature !== undefined &&
      !(typeof temperature === 'number' && temperature >= 0 && temperature <= 2)) ||
    (maxTokens !== undefined && !(Number.isSafeInteger(maxTokens) && (maxTokens as number) >= 1)) ||
    (thinking !== undefined && !validateAgainst(ThinkingSchema, thinking).ok)
  )
    throw envelope('sampling', 'Side call sampling is invalid')
  return Object.freeze(
    Object.fromEntries(Object.entries(sampling).filter(([, field]) => field !== undefined)),
  ) as RequestBody['sampling']
}

function payloadOf(value: unknown): { payload?: JsonValue; bytes: number | null } {
  if (value === undefined) return { bytes: null }
  const checked = inspectJsonData(value, MAX_BYTES)
  if (!checked.ok) throw envelope('payload-size', 'Side call payload must be JSON data of at most 1 MiB')
  // A plain copy in the caller's key order; the adapter receives it as written.
  const payload = deepFreeze(JSON.parse(JSON.stringify(checked.value)) as JsonValue)
  return { payload, bytes: new TextEncoder().encode(canonicalJson(payload)).byteLength }
}

/** A provider count when it can bind one to this exact request, otherwise the text estimate. */
async function inputTokensOf(
  s: SessionImpl,
  request: RequestBody,
): Promise<{ inputTokens: number; source: 'provider' | 'estimate' }> {
  const provider = s.d.provider
  if (request.payload === undefined && request.messages.length > 0 && typeof provider.count === 'function') {
    const controller = new AbortController()
    try {
      const counted = await withTimeout(
        Promise.resolve(provider.count(request, { signal: controller.signal })),
        COUNT_TIMEOUT_MS,
        'side call count',
      )
      if (
        counted.source !== 'unsupported' &&
        counted.boundHash === request.derivedHash &&
        Number.isSafeInteger(counted.tokens) &&
        counted.tokens > 0
      )
        return { inputTokens: counted.tokens, source: 'provider' }
    } catch {
      // A count is advisory; the estimate below stands in for it.
    } finally {
      controller.abort()
    }
  }
  return { inputTokens: estimateTokens(canonicalJson(request)), source: 'estimate' }
}

async function projectedCreditsOf(
  s: SessionImpl,
  inputTokens: number,
  model: string,
): Promise<number | null> {
  try {
    const projected = await s.d.runtime.billingProjected({ tokensEstimate: inputTokens, model })
    return Number.isFinite(projected.credits) && projected.credits >= 0 ? projected.credits : null
  } catch {
    return null
  }
}

/**
 * Prepares side calls for one loop context and resolves them again at send time. `prepare` checks
 * the options, freezes the request exactly as the adapter will receive it, and estimates it; it
 * writes nothing and sends nothing. Only this context can send what it prepared, in the same turn,
 * and only while the route still resolves to the same catalog record and full route description.
 */
export function sideCallRequests(s: SessionImpl) {
  const prepared = new WeakMap<object, SideCallRequest>()
  return {
    async prepare(options: SideCallOptions): Promise<PreparedSideCall> {
      const op = s.op()
      if (!op) throw noTurn()
      const given: Partial<SideCallOptions> = options ?? {}
      const { label, deadlineMs = DEFAULT_DEADLINE_MS, output = 'text', system = '' } = given
      if (typeof label !== 'string' || !LABEL.test(label))
        throw envelope('label', 'Side call label is invalid')
      if (
        !Number.isSafeInteger(deadlineMs) ||
        deadlineMs < SIDE_CALL_DEADLINE_MS.min ||
        deadlineMs > SIDE_CALL_DEADLINE_MS.max
      )
        throw envelope('deadline', 'Side call deadlineMs must be 100 to 120000')
      const invocationId = checkInvocationId(given.invocationId ?? s.d.ids.effectId())
      if (output !== 'text' && output !== 'json')
        throw envelope('output', 'Side call output must be text or json')
      if (typeof system !== 'string' || system.length > MAX_SYSTEM_CHARS)
        throw envelope('system', 'Side call system prompt must be a string of at most 1 MiB')
      const messages = messagesOf(given.messages)
      const sampling = samplingOf(given.sampling)
      const { payload, bytes } = payloadOf(given.payload)
      const resolved = resolveTarget(s, given.target?.route, given.target?.model)
      if (!resolved)
        throw new CoreError('E_MODEL_UNKNOWN', 'Side call target is not in the model catalog', {
          reason: 'target-unknown',
        })
      const { record } = resolved
      if (
        !record.input.includes('image') &&
        messages.some((message) => message.content.some((block) => block.type === 'image'))
      )
        throw envelope('image-input', 'Side call target model does not accept images')

      const target = Object.freeze({ route: record.route, model: record.id })
      const subject = { system, messages, payload, sampling }
      const subjectHash = digest(subject)
      const requestHash = digest({ label, target, ...subject, output, deadlineMs })
      const derivedHash = digest({ purpose: 'side-call', label, target, subjectHash, deadlineMs, output })
      const request: RequestBody = deepFreeze({
        kind: 'inference',
        sessionKey: s.key,
        slot: record.slot ?? 'primary',
        route: target.route,
        model: target.model,
        contractId: record.contract_id,
        derivedHash,
        system,
        messages,
        tools: [],
        ...(payload === undefined ? {} : { payload }),
        ...(sampling ? { sampling } : {}),
        timeoutMs: { firstToken: deadlineMs, total: deadlineMs },
      })
      const { inputTokens, source } = await inputTokensOf(s, request)
      const projectedCredits = await projectedCreditsOf(s, inputTokens, target.model)
      const adapter = adapterOf(resolved.description)
      const call = Object.freeze({
        invocationId,
        label,
        target,
        adapter,
        deadlineMs,
        requestHash,
        estimate: Object.freeze({
          inputTokens,
          source,
          projectedCredits,
          contextWindow: record.contextWindow ?? null,
        }),
      }) as PreparedSideCall
      prepared.set(
        call,
        Object.freeze({
          prepared: call,
          request,
          binding: Object.freeze({
            effectId: sideCallEffectId(invocationId),
            sessionKey: s.key,
            lane: s.lane,
            auditBindingHash: requestHash,
            budgetBindingHash: digest({
              purpose: 'side-call',
              sessionKey: s.key,
              lane: s.lane,
              derivedHash,
              target,
            }),
            subjectHash,
            requestDerivedHash: derivedHash,
            route: target.route,
            model: target.model,
          }),
          audit: Object.freeze({
            label,
            adapter: adapter && Object.freeze({ id: adapter.id, version: adapter.version }),
            api: adapter?.api ?? null,
            endpointHost: adapter?.endpointHost ?? null,
            deadlineMs,
            output,
            inputTokens,
            estimateSource: source,
            projectedCredits,
            payloadBytes: bytes,
          }),
          turnId: op.meta.turn,
          targetDigest: resolved.digest,
        }),
      )
      return call
    },

    /** The call as prepared, once it is known to be this context's, this turn's and still on target. */
    resolve(call: PreparedSideCall): SideCallRequest {
      const known = call && typeof call === 'object' ? prepared.get(call) : undefined
      if (!known)
        throw new CoreError('E_REQUEST_FROZEN', 'Side call was not prepared by this loop context', {
          reason: 'foreign',
        })
      const op = s.op()
      if (!op) throw noTurn()
      if (known.turnId !== op.meta.turn)
        throw new CoreError('E_REQUEST_FROZEN', 'Side call was prepared in another turn', { reason: 'turn' })
      const { target } = known.prepared
      if (resolveTarget(s, target.route, target.model)?.digest !== known.targetDigest)
        throw new CoreError('E_REQUEST_FROZEN', 'Side call target changed after it was prepared', {
          reason: 'target-changed',
        })
      return known
    },
  }
}
