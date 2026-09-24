import { types as utilTypes } from 'node:util'
import {
  type CountResult,
  type InferenceEvent,
  type ModelRecord,
  type Provider,
  type RequestBody,
  validateAgainst,
} from '@agnes/protocol'
import {
  CountResult as CountResultSchema,
  InferenceEvent as InferenceEventSchema,
  ModelRecord as ModelRecordSchema,
} from '@agnes/protocol/gen/model'
import { withTimeout } from '../effects/wrap.js'
import { canonicalJson, sha256Hex } from '../request/hash.js'
import type { SessionImpl } from '../step/session.js'
import {
  type AuxiliaryVisionImageLimits,
  type AuxiliaryVisionImageTransform,
  type AuxiliaryVisionOutcome,
  type AuxiliaryVisionPlan,
  type AuxiliaryVisionTarget,
  auxiliaryVisionOutcome,
  prepareAuxiliaryVisionPlan,
} from './auxiliary-vision.js'
import { createAuxiliaryVisionEffectPort } from './auxiliary-vision-effect-port.js'
import {
  type AuxiliaryVisionDriver,
  type AuxiliaryVisionDriverResult,
  authorizeAuxiliaryVisionExecution,
  executeAuxiliaryVision,
} from './auxiliary-vision-executor.js'
import { isLedgerPreparedRequestMedia, type LedgerPreparedRequestMedia } from './request-media-surface.js'

const COUNT_TIMEOUT_MS = 5_000
const MAX_VISION_TEXT = 1_048_576

declare const admissionBrand: unique symbol
export type AuxiliaryVisionProductionAdmission = Readonly<{ readonly [admissionBrand]: true }>

const productionAdmissions = new WeakSet<object>()
export type AuxiliaryVisionNotDispatchedAuthority = Readonly<{
  outcome: AuxiliaryVisionOutcome
  sessionKey: string
  lane: string
  mediaManifestHash: string
  reason:
    | 'admission_closed'
    | 'cancelled'
    | 'target_unavailable'
    | 'plan_unavailable'
    | 'count_unavailable'
    | 'budget_unavailable'
}>
const notDispatchedOutcomes = new WeakMap<object, AuxiliaryVisionNotDispatchedAuthority>()

/** Internal read-only bridge for an assembly-controlled fallback that provably did not dispatch. */
export function consumeAuxiliaryVisionNotDispatchedAuthority(
  value: unknown,
): AuxiliaryVisionNotDispatchedAuthority | undefined {
  return value && typeof value === 'object' && !utilTypes.isProxy(value)
    ? notDispatchedOutcomes.get(value)
    : undefined
}

/**
 * Internal composition capability. It is deliberately not re-exported from `@agnes/core`; P0 stays
 * closed until the Host owns a reviewed issuer/wiring path rather than passing a caller-authored flag.
 */
export function mintAuxiliaryVisionProductionAdmission(): AuxiliaryVisionProductionAdmission {
  const authority = Object.freeze(Object.create(null)) as AuxiliaryVisionProductionAdmission
  productionAdmissions.add(authority)
  return authority
}

function hasProductionAdmission(value: unknown): value is AuxiliaryVisionProductionAdmission {
  return !!value && typeof value === 'object' && productionAdmissions.has(value)
}

export type AuxiliaryVisionAssemblyInput = Readonly<{
  session: SessionImpl
  media: LedgerPreparedRequestMedia
  /** Omission or an object not minted by Core keeps production Computer Use media disabled. */
  productionAdmission?: AuxiliaryVisionProductionAdmission
  /** Stable identity supplied by the owning primary-inference attempt. */
  effectId: string
  axSomText: string
  timeoutMs: Readonly<{ firstToken: number; total: number }>
  imageLimits: AuxiliaryVisionImageLimits
  maxOutputTokens: number
  signal: AbortSignal
  transformImage?: AuxiliaryVisionImageTransform
}>

type ResolvedImageTarget = Readonly<{
  target: AuxiliaryVisionTarget
  parserVersion: string
}>

function exactOwnData(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value))
      return undefined
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const allowed = new Set([...required, ...optional])
    if (
      required.some((key) => !Object.hasOwn(descriptors, key)) ||
      Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !allowed.has(key)) ||
      Object.values(descriptors).some(
        (descriptor) => descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value'),
      )
    )
      return undefined
    const copy = Object.create(null) as Record<string, unknown>
    for (const key of Reflect.ownKeys(descriptors) as string[]) copy[key] = descriptors[key]?.value
    return Object.freeze(copy)
  } catch {
    return undefined
  }
}

function snapshotContract(value: unknown):
  | Readonly<{
      contract_id: string | null
      parser_version: string
    }>
  | undefined {
  const contract = exactOwnData(value, ['contract_id', 'parser_version'])
  if (
    !contract ||
    (contract.contract_id !== null && typeof contract.contract_id !== 'string') ||
    typeof contract.parser_version !== 'string' ||
    contract.parser_version.length < 1 ||
    contract.parser_version.length > 32
  )
    return undefined
  return Object.freeze({
    contract_id: contract.contract_id as string | null,
    parser_version: contract.parser_version,
  })
}

function validatedModels(provider: Provider): readonly ModelRecord[] | undefined {
  try {
    const values: unknown = provider.models()
    if (!Array.isArray(values) || values.length > 10_000) return undefined
    const records: ModelRecord[] = []
    for (const value of values) {
      const checked = validateAgainst<ModelRecord>(ModelRecordSchema, value)
      if (!checked.ok) return undefined
      records.push(checked.value)
    }
    return records
  } catch {
    return undefined
  }
}

/** Resolves image capability from the fitted provider catalogue; callers cannot self-assert it. */
function resolveImageTarget(session: SessionImpl): ResolvedImageTarget | undefined {
  const records = validatedModels(session.d.provider)
  if (!records) return undefined
  const route = session.preset.model.route.image
  if (!route) return undefined
  const pinned = session.preset.model.id.image
  const onRoute = records.filter((record) => record.route === route)
  const candidates = pinned
    ? onRoute.filter((record) => record.id === pinned)
    : onRoute.filter((record) => record.slot === 'image')
  const selected =
    candidates.length === 1
      ? candidates[0]
      : !pinned && candidates.length === 0 && onRoute.length === 1
        ? onRoute[0]
        : undefined
  if (!selected?.input.includes('image')) return undefined
  let rawContract: unknown
  try {
    rawContract = session.d.contractForModel?.({ route, model: selected.id }) ?? session.d.contract
  } catch {
    return undefined
  }
  const contract = snapshotContract(rawContract)
  if (!contract) return undefined
  if (contract.contract_id !== selected.contract_id) return undefined
  return Object.freeze({
    target: Object.freeze({
      id: selected.id,
      route,
      slot: 'image' as const,
      input: Object.freeze([...selected.input]),
      contract_id: selected.contract_id,
    }),
    parserVersion: contract.parser_version,
  })
}

/** Pre-route signal for request-media. Dispatch re-resolves the catalogue to reject capability drift. */
export function auxiliaryVisionAvailableForSession(
  session: SessionImpl,
  productionAdmission?: AuxiliaryVisionProductionAdmission,
): boolean {
  return hasProductionAdmission(productionAdmission) && resolveImageTarget(session) !== undefined
}

function fallback(
  input: AuxiliaryVisionAssemblyInput,
  reason: AuxiliaryVisionNotDispatchedAuthority['reason'],
): AuxiliaryVisionOutcome {
  const outcome = auxiliaryVisionOutcome({ axSomText: input.axSomText })
  if (
    isLedgerPreparedRequestMedia(input.media) &&
    input.media.sessionKey === input.session.key &&
    input.media.header.route === 'auxiliary-vision'
  )
    notDispatchedOutcomes.set(
      outcome,
      Object.freeze({
        outcome,
        sessionKey: input.session.key,
        lane: input.session.lane,
        mediaManifestHash: sha256Hex(canonicalJson(input.media.hashMaterial)),
        reason,
      }),
    )
  return outcome
}

async function countInputTokens(
  session: SessionImpl,
  media: LedgerPreparedRequestMedia,
  request: RequestBody,
  signal: AbortSignal,
): Promise<number | undefined> {
  try {
    const provider = session.d.provider
    if (!provider || typeof provider !== 'object' || utilTypes.isProxy(provider))
      throw new TypeError('auxiliary provider counter is invalid')
    const descriptor = Object.getOwnPropertyDescriptor(provider, 'count')
    if (descriptor !== undefined) {
      if (!Object.hasOwn(descriptor, 'value')) throw new TypeError('auxiliary provider counter is invalid')
      const count = descriptor.value as unknown
      if (typeof count !== 'function' || utilTypes.isProxy(count))
        throw new TypeError('auxiliary provider counter is invalid')
      const raw = await withTimeout(
        Reflect.apply(count, provider, [request, { signal }]) as Promise<unknown>,
        COUNT_TIMEOUT_MS,
        'auxiliary provider.count',
        signal,
        session.d.timers,
      )
      const countResult = exactOwnData(raw, ['source'], ['tokens', 'boundHash'])
      if (!countResult) throw new TypeError('auxiliary provider count result is invalid')
      const checked = validateAgainst<CountResult>(CountResultSchema, countResult)
      if (
        checked.ok &&
        checked.value.source !== 'unsupported' &&
        checked.value.boundHash === request.derivedHash &&
        Number.isSafeInteger(checked.value.tokens) &&
        checked.value.tokens > 0
      )
        return checked.value.tokens
      throw new TypeError('auxiliary provider count result is invalid')
    }
  } catch {
    // A counter is advisory. The trusted, manifest-aware fallback below is the only alternative.
  }
  const imageCount = media.selected.length
  const imageFallback = session.d.imageInputTokenFallback
  if (!imageFallback || imageCount < 1) return undefined
  try {
    const raw = await withTimeout(
      Promise.resolve(imageFallback({ wire: request, media: media.header, imageCount, signal })),
      COUNT_TIMEOUT_MS,
      'auxiliary image token fallback',
      signal,
      session.d.timers,
    )
    const counted = exactOwnData(raw, ['imageCount', 'tokens'])
    return counted &&
      counted.imageCount === imageCount &&
      Number.isSafeInteger(counted.tokens) &&
      (counted.tokens as number) > 0
      ? (counted.tokens as number)
      : undefined
  } catch {
    return undefined
  }
}

function stampMatches(
  event: Extract<InferenceEvent, { type: 'sent' }>,
  request: Parameters<Provider['infer']>[0],
  parserVersion: string,
): boolean {
  const stamp = event.stamp
  return (
    stamp.derived_hash === request.derivedHash &&
    stamp.tool_schema_hash === sha256Hex(canonicalJson(request.tools).normalize('NFC')) &&
    stamp.parser_version === parserVersion &&
    stamp.contract_id === request.contractId &&
    stamp.model.route === request.route &&
    stamp.model.id === request.model
  )
}

function failure(
  status: 'failed' | 'aborted',
  sent: boolean,
  usage?: Extract<InferenceEvent, { type: 'usage' }>,
): AuxiliaryVisionDriverResult {
  const knownUsage =
    usage?.credits === undefined
      ? undefined
      : Object.freeze({
          tokens: Object.freeze({ ...usage.tokens }),
          credits: usage.credits,
          creditSource: usage.creditSource,
        })
  return Object.freeze({
    status,
    dispatch: sent ? 'may_have_sent' : 'not_sent',
    ...(knownUsage ? { usage: knownUsage } : {}),
  })
}

/** Strict adapter for Core's fitted Provider. It never retries and never returns provider error text. */
function providerDriver(provider: Provider, parserVersion: string): AuxiliaryVisionDriver {
  return Object.freeze({
    async dispatch(input) {
      const startedAt = performance.now()
      const stream = provider.infer(input.request, {
        signal: input.signal,
        toolNames: [],
        retry: false,
      })
      if (!stream || typeof stream[Symbol.asyncIterator] !== 'function')
        throw new TypeError('auxiliary provider returned no stream')
      const iterator = stream[Symbol.asyncIterator]()
      let sent = false
      let done = false
      let streamEnded = false
      let firstOutput = false
      let usage: Extract<InferenceEvent, { type: 'usage' }> | undefined
      let text = ''
      try {
        for (;;) {
          const elapsed = performance.now() - startedAt
          if (elapsed >= input.timeoutMs.total || (!firstOutput && elapsed >= input.timeoutMs.firstToken))
            throw new Error('auxiliary provider deadline exceeded')
          const waitingForFirst = !firstOutput
          const totalRemaining = input.timeoutMs.total - elapsed
          const firstRemaining = input.timeoutMs.firstToken - elapsed
          const next = await withTimeout(
            Promise.resolve(iterator.next()),
            Math.min(totalRemaining, firstOutput ? totalRemaining : firstRemaining),
            'auxiliary provider stream',
            input.signal,
          )
          const completedElapsed = performance.now() - startedAt
          if (
            completedElapsed >= input.timeoutMs.total ||
            (waitingForFirst && completedElapsed >= input.timeoutMs.firstToken)
          )
            throw new Error('auxiliary provider deadline exceeded')
          if (next.done) {
            streamEnded = true
            break
          }
          const checked = validateAgainst<InferenceEvent>(InferenceEventSchema, next.value)
          if (!checked.ok) throw new TypeError('auxiliary provider event is invalid')
          const event = checked.value
          if (done) throw new TypeError('auxiliary provider output followed done')
          if (event.type === 'sent') {
            if (sent || !stampMatches(event, input.request, parserVersion))
              throw new TypeError('auxiliary provider stamp is invalid')
            sent = true
          } else if (event.type === 'error') {
            return failure(event.reason === 'aborted' ? 'aborted' : 'failed', sent, usage)
          } else if (!sent) {
            throw new TypeError('auxiliary provider emitted output before sent')
          } else if (event.type === 'text_delta') {
            if (text.length + event.delta.length > MAX_VISION_TEXT)
              throw new TypeError('auxiliary provider text is invalid')
            text += event.delta
            if (event.delta) firstOutput = true
          } else if (event.type === 'thinking_delta') {
            if (event.delta) firstOutput = true
          } else if (event.type === 'usage') {
            if (usage) throw new TypeError('auxiliary provider usage is ambiguous')
            usage = event
          } else if (event.type === 'done') {
            if (event.reason === 'toolUse') throw new TypeError('auxiliary provider terminal is invalid')
            done = true
            break
          } else {
            throw new TypeError('auxiliary provider emitted a forbidden event')
          }
        }
      } finally {
        if (!streamEnded) {
          try {
            void Promise.resolve(iterator.return?.(undefined)).catch(() => undefined)
          } catch {
            // Cleanup failure cannot replace the unknown provider outcome being durably settled.
          }
        }
      }
      if (!sent || !done || !text || !usage || usage.credits === undefined)
        throw new TypeError('auxiliary provider stream is incomplete')
      return Object.freeze({
        status: 'completed' as const,
        text,
        usage: Object.freeze({
          tokens: Object.freeze({ ...usage.tokens }),
          credits: usage.credits,
          creditSource: usage.creditSource,
        }),
      })
    },
  })
}

/** Production Core caller: plan, quote, reserve, persist, dispatch once, and settle as one path. */
export async function runAuxiliaryVisionAssembly(
  input: AuxiliaryVisionAssemblyInput,
): Promise<AuxiliaryVisionOutcome> {
  if (input.signal !== input.session.ac.signal || !(input.signal instanceof AbortSignal))
    throw new TypeError('auxiliary vision must use the owning session cancellation signal')
  if (!hasProductionAdmission(input.productionAdmission)) return fallback(input, 'admission_closed')
  if (input.signal.aborted) return fallback(input, 'cancelled')
  const resolved = resolveImageTarget(input.session)
  if (!resolved) return fallback(input, 'target_unavailable')
  let plan: AuxiliaryVisionPlan
  try {
    plan = await prepareAuxiliaryVisionPlan({
      sessionKey: input.session.key,
      lane: input.session.lane,
      media: input.media,
      target: resolved.target,
      axSomText: input.axSomText,
      timeoutMs: input.timeoutMs,
      imageLimits: input.imageLimits,
      maxOutputTokens: input.maxOutputTokens,
      signal: input.signal,
      ...(input.transformImage ? { transformImage: input.transformImage } : {}),
    })
  } catch {
    // Planning may cross an injected image transform. Never inspect or rethrow its unknown failure:
    // even `instanceof` can execute a hostile Proxy trap, and provider-visible fallback is sufficient.
    return fallback(input, 'plan_unavailable')
  }
  const inputTokens = await countInputTokens(input.session, input.media, plan.request, input.signal)
  if (inputTokens === undefined || input.signal.aborted)
    return fallback(input, input.signal.aborted ? 'cancelled' : 'count_unavailable')
  const projection = await input.session.d.runtime.ledgerProjected({
    tokensEstimate: inputTokens,
    model: plan.request.model,
  })
  if (!Number.isFinite(projection.credits) || projection.credits < 0 || input.signal.aborted)
    return fallback(input, input.signal.aborted ? 'cancelled' : 'budget_unavailable')
  const authority = authorizeAuxiliaryVisionExecution({
    plan,
    effectId: input.effectId,
    projectedCredits: projection.credits,
    inputTokens,
  })
  return executeAuxiliaryVision({
    session: input.session,
    authority,
    signal: input.signal,
    effects: createAuxiliaryVisionEffectPort(input.session),
    driver: providerDriver(input.session.d.provider, resolved.parserVersion),
  })
}
