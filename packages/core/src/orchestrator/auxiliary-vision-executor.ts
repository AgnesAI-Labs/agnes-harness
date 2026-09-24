import { types as utilTypes } from 'node:util'
import type { RequestBody, TokenCounts } from '@agnes/protocol'
import {
  reconcileTreeReservationHandle,
  releaseTreeReservationHandle,
  reserveTreeBudgetHandle,
  settleTreeSpendHandle,
  type TreeReservationHandle,
} from '../child/runtime-budget.js'
import { canonicalJson, sha256Hex } from '../request/hash.js'
import type { SessionImpl } from '../step/session.js'
import type { Seq } from '../types.js'
import {
  type AuxiliaryVisionOutcome,
  type AuxiliaryVisionPlan,
  auxiliaryVisionOutcome,
  isPreparedAuxiliaryVisionPlan,
} from './auxiliary-vision.js'

export type AuxiliaryVisionExecutionAuthority = Readonly<{
  plan: AuxiliaryVisionPlan
  effectId: string
  projectedCredits: number
  inputTokens: number
  budgetBindingHash: string
  auditBindingHash: string
}>

const executionAuthorities = new WeakSet<object>()
const authorityByPlan = new WeakMap<AuxiliaryVisionPlan, AuxiliaryVisionExecutionAuthority>()
const EFFECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u
const SENSITIVE = /(?:authorization|bearer|credential|secret|password|api[_-]?key|token|sk-[A-Za-z0-9])/iu

export class AuxiliaryVisionExecutionError extends Error {
  constructor(
    readonly code: 'INPUT_INVALID' | 'EFFECT_WRITE_FAILED' | 'SETTLEMENT_INVALID',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'AuxiliaryVisionExecutionError'
  }
}

/** Binds one prepared plan to exactly one durable effect and immutable budget quote. */
export function authorizeAuxiliaryVisionExecution(
  input: Readonly<{
    plan: AuxiliaryVisionPlan
    effectId: string
    projectedCredits: number
    inputTokens: number
  }>,
): AuxiliaryVisionExecutionAuthority {
  if (!isPreparedAuxiliaryVisionPlan(input.plan))
    throw new AuxiliaryVisionExecutionError('INPUT_INVALID', 'plan lacks Core media authority')
  if (!EFFECT_ID.test(input.effectId) || SENSITIVE.test(input.effectId))
    throw new AuxiliaryVisionExecutionError('INPUT_INVALID', 'effect id is invalid')
  if (!Number.isFinite(input.projectedCredits) || input.projectedCredits < 0)
    throw new AuxiliaryVisionExecutionError('INPUT_INVALID', 'projected credits are invalid')
  if (!Number.isSafeInteger(input.inputTokens) || input.inputTokens < 0)
    throw new AuxiliaryVisionExecutionError('INPUT_INVALID', 'input token quote is invalid')
  const prior = authorityByPlan.get(input.plan)
  if (prior) {
    if (
      prior.effectId !== input.effectId ||
      prior.projectedCredits !== input.projectedCredits ||
      prior.inputTokens !== input.inputTokens
    )
      throw new AuxiliaryVisionExecutionError(
        'INPUT_INVALID',
        'prepared plan is already bound to a different execution identity',
      )
    return prior
  }
  const quote = {
    planAuditBindingHash: input.plan.auditBindingHash,
    planBudgetBindingHash: input.plan.budgetBindingHash,
    effectId: input.effectId,
    projectedCredits: input.projectedCredits,
    inputTokens: input.inputTokens,
  }
  const authority = Object.freeze({
    plan: input.plan,
    effectId: input.effectId,
    projectedCredits: input.projectedCredits,
    inputTokens: input.inputTokens,
    budgetBindingHash: sha256Hex(canonicalJson({ purpose: 'media', quote })),
    auditBindingHash: sha256Hex(canonicalJson({ purpose: 'media', quote, request: input.plan.request })),
  })
  authorityByPlan.set(input.plan, authority)
  executionAuthorities.add(authority)
  return authority
}

export type AuxiliaryVisionEffectBinding = Readonly<{
  effectId: string
  sessionKey: string
  lane: string
  auditBindingHash: string
  budgetBindingHash: string
  mediaManifestHash: string
  requestDerivedHash: string
  model: string
}>

type KnownTerminal = Readonly<{
  kind: 'known_spend'
  outcome: 'ok' | 'error' | 'aborted'
  purpose: 'media'
  model: string
  interrupted: boolean
  tokens: TokenCounts
  credits: number
  creditSource: 'gateway' | 'estimated'
  visionText?: string
  reason?: 'driver_failed' | 'driver_aborted'
}>
type NoSpendTerminal = Readonly<{
  kind: 'no_spend'
  outcome: 'error' | 'aborted'
  purpose: 'media'
  model: string
  interrupted: true
  reason: 'cancelled_before_dispatch' | 'driver_not_sent' | 'effect_contract_invalid'
}>
type UnknownSpendTerminal = Readonly<{
  kind: 'unknown_spend'
  outcome: 'unknown'
  purpose: 'media'
  model: string
  interrupted: true
  creditSource: 'unknown'
  reason: 'driver_outcome_unknown' | 'driver_contract_invalid'
}>
export type AuxiliaryVisionEffectTerminal = KnownTerminal | NoSpendTerminal | UnknownSpendTerminal
export type AuxiliaryVisionEffectReceipt = Readonly<{
  terminalSeq: Seq
  costOriginSeq?: Seq
  auditBindingHash: string
  budgetBindingHash: string
  requestDerivedHash: string
  terminalHash: string
}>
export type AuxiliaryVisionFinishedEffect = Readonly<{
  status: 'finished'
  terminal: AuxiliaryVisionEffectTerminal
  receipt: AuxiliaryVisionEffectReceipt
}>

export type AuxiliaryVisionTerminalAuthority = Readonly<{
  outcome: AuxiliaryVisionOutcome
  sessionKey: string
  lane: string
  mediaManifestHash: string
  effectId: string
  terminalSeq: Seq
  terminalHash: string
}>

const terminalOutcomes = new WeakMap<object, AuxiliaryVisionTerminalAuthority>()
export type AuxiliaryVisionExecutorFallbackAuthority = Readonly<{
  outcome: AuxiliaryVisionOutcome
  sessionKey: string
  lane: string
  mediaManifestHash: string
  effectId: string
  state: 'not_dispatched' | 'durable_in_progress'
  reason: 'cancelled_before_reservation' | 'budget_blocked' | 'cancelled_before_intent' | 'effect_in_progress'
}>
const executorFallbackOutcomes = new WeakMap<object, AuxiliaryVisionExecutorFallbackAuthority>()

/** Internal read-only bridge; only a validated durable terminal can populate this WeakMap. */
export function consumeAuxiliaryVisionTerminalAuthority(
  value: unknown,
): AuxiliaryVisionTerminalAuthority | undefined {
  return value && typeof value === 'object' && !utilTypes.isProxy(value)
    ? terminalOutcomes.get(value)
    : undefined
}

export function consumeAuxiliaryVisionExecutorFallbackAuthority(
  value: unknown,
): AuxiliaryVisionExecutorFallbackAuthority | undefined {
  return value && typeof value === 'object' && !utilTypes.isProxy(value)
    ? executorFallbackOutcomes.get(value)
    : undefined
}

export type AuxiliaryVisionEffectPort = Readonly<{
  /** Idempotently persists intent or returns the durable phase already bound to this identity. */
  begin(
    binding: AuxiliaryVisionEffectBinding,
  ): Promise<
    | Readonly<{ status: 'admitted'; intentSeq: Seq }>
    | Readonly<{ status: 'in_progress' }>
    | AuxiliaryVisionFinishedEffect
  >
  /** Persists terminal and known cost atomically, then returns their durable recovery receipt. */
  finish(
    binding: AuxiliaryVisionEffectBinding,
    terminal: AuxiliaryVisionEffectTerminal,
  ): Promise<AuxiliaryVisionFinishedEffect>
}>

export type AuxiliaryVisionUsage = Readonly<{
  tokens: TokenCounts
  credits: number
  creditSource: 'gateway' | 'estimated'
}>
export type AuxiliaryVisionDriverResult =
  | Readonly<{ status: 'completed'; text: string; usage: AuxiliaryVisionUsage }>
  | Readonly<{
      status: 'failed' | 'aborted'
      dispatch: 'not_sent' | 'may_have_sent'
      usage?: AuxiliaryVisionUsage
    }>
export type AuxiliaryVisionDriver = Readonly<{
  dispatch(
    input: Readonly<{
      binding: AuxiliaryVisionEffectBinding
      intentSeq: Seq
      request: RequestBody
      timeoutMs: AuxiliaryVisionPlan['timeoutMs']
      signal: AbortSignal
    }>,
  ): Promise<AuxiliaryVisionDriverResult>
}>

function positiveSeq(value: number | undefined): value is Seq {
  return Number.isSafeInteger(value) && (value ?? 0) >= 1
}

function fallback(plan: AuxiliaryVisionPlan): AuxiliaryVisionOutcome {
  return auxiliaryVisionOutcome({ axSomText: plan.axSomText })
}

function terminalForResult(resultValue: unknown, model: string): AuxiliaryVisionEffectTerminal {
  const head = plainOwn(resultValue, ['status'], ['dispatch', 'text', 'usage'])
  if (!head)
    return Object.freeze({
      kind: 'unknown_spend',
      outcome: 'unknown',
      purpose: 'media',
      model,
      interrupted: true,
      creditSource: 'unknown',
      reason: 'driver_contract_invalid',
    })
  if (head.status === 'completed') {
    const result = plainOwn(resultValue, ['status', 'text', 'usage'])
    const usage = result ? parseUsage(result.usage) : undefined
    if (
      !result ||
      !usage ||
      typeof result.text !== 'string' ||
      !result.text ||
      result.text.length > 1_048_576
    )
      return Object.freeze({
        kind: 'unknown_spend',
        outcome: 'unknown',
        purpose: 'media',
        model,
        interrupted: true,
        creditSource: 'unknown',
        reason: 'driver_contract_invalid',
      })
    return Object.freeze({
      kind: 'known_spend',
      outcome: 'ok',
      purpose: 'media',
      model,
      interrupted: false,
      tokens: usage.tokens,
      credits: usage.credits,
      creditSource: usage.creditSource,
      visionText: result.text,
    })
  }
  const result = plainOwn(resultValue, ['dispatch', 'status'], ['usage'])
  if (
    !result ||
    (result.status !== 'failed' && result.status !== 'aborted') ||
    (result.dispatch !== 'not_sent' && result.dispatch !== 'may_have_sent')
  )
    return Object.freeze({
      kind: 'unknown_spend',
      outcome: 'unknown',
      purpose: 'media',
      model,
      interrupted: true,
      creditSource: 'unknown',
      reason: 'driver_contract_invalid',
    })
  const usage = result.usage === undefined ? undefined : parseUsage(result.usage)
  if (result.dispatch === 'not_sent' && result.usage !== undefined)
    return Object.freeze({
      kind: 'unknown_spend',
      outcome: 'unknown',
      purpose: 'media',
      model,
      interrupted: true,
      creditSource: 'unknown',
      reason: 'driver_contract_invalid',
    })
  if (result.dispatch === 'not_sent')
    return Object.freeze({
      kind: 'no_spend',
      outcome: result.status === 'aborted' ? 'aborted' : 'error',
      purpose: 'media',
      model,
      interrupted: true,
      reason: 'driver_not_sent',
    })
  if (usage)
    return Object.freeze({
      kind: 'known_spend',
      outcome: result.status === 'aborted' ? 'aborted' : 'error',
      purpose: 'media',
      model,
      interrupted: true,
      tokens: usage.tokens,
      credits: usage.credits,
      creditSource: usage.creditSource,
      reason: result.status === 'aborted' ? 'driver_aborted' : 'driver_failed',
    })
  return Object.freeze({
    kind: 'unknown_spend',
    outcome: 'unknown',
    purpose: 'media',
    model,
    interrupted: true,
    creditSource: 'unknown',
    reason: result.usage ? 'driver_contract_invalid' : 'driver_outcome_unknown',
  })
}

function plainOwn(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value))
    return undefined
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  if (keys.some((key) => typeof key !== 'string')) return undefined
  const allowed = new Set([...required, ...optional])
  if (
    required.some((key) => !Object.hasOwn(descriptors, key)) ||
    keys.some((key) => !allowed.has(key as string)) ||
    Object.values(descriptors).some(
      (descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true,
    )
  )
    return undefined
  const snapshot = Object.create(null) as Record<string, unknown>
  for (const key of keys as string[]) snapshot[key] = descriptors[key]?.value
  return Object.freeze(snapshot)
}

function parseTokens(value: unknown): TokenCounts | undefined {
  const record = plainOwn(value, ['cacheRead', 'cacheWrite', 'input', 'output'], ['reasoning'])
  if (!record) return undefined
  const valid = ['cacheRead', 'cacheWrite', 'input', 'output', 'reasoning'].every((key) => {
    const token = record[key]
    return token === undefined || (Number.isSafeInteger(token) && (token as number) >= 0)
  })
  if (!valid) return undefined
  return Object.freeze({
    input: record.input as number,
    output: record.output as number,
    cacheRead: record.cacheRead as number,
    cacheWrite: record.cacheWrite as number,
    ...(record.reasoning === undefined ? {} : { reasoning: record.reasoning as number }),
  })
}

function parseUsage(value: unknown): AuxiliaryVisionUsage | undefined {
  const record = plainOwn(value, ['creditSource', 'credits', 'tokens'])
  if (!record) return undefined
  const tokens = parseTokens(record.tokens)
  if (
    !tokens ||
    !Number.isFinite(record.credits) ||
    (record.credits as number) < 0 ||
    (record.creditSource !== 'gateway' && record.creditSource !== 'estimated')
  )
    return undefined
  return Object.freeze({
    tokens,
    credits: record.credits as number,
    creditSource: record.creditSource,
  })
}

function parseTerminal(value: unknown, binding: AuxiliaryVisionEffectBinding): AuxiliaryVisionEffectTerminal {
  const common = ['interrupted', 'kind', 'model', 'outcome', 'purpose']
  const head = plainOwn(value, common, ['creditSource', 'credits', 'reason', 'tokens', 'visionText'])
  if (head?.purpose !== 'media' || head.model !== binding.model)
    throw new AuxiliaryVisionExecutionError('SETTLEMENT_INVALID', 'effect terminal binding is invalid')
  if (head.kind === 'known_spend') {
    const terminal = plainOwn(
      value,
      [...common, 'creditSource', 'credits', 'tokens'],
      ['reason', 'visionText'],
    )
    const tokens = terminal ? parseTokens(terminal.tokens) : undefined
    if (
      !terminal ||
      !tokens ||
      !Number.isFinite(terminal.credits) ||
      (terminal.credits as number) < 0 ||
      (terminal.creditSource !== 'gateway' && terminal.creditSource !== 'estimated') ||
      !['ok', 'error', 'aborted'].includes(terminal.outcome as string)
    )
      throw new AuxiliaryVisionExecutionError('SETTLEMENT_INVALID', 'known effect terminal is invalid')
    if (terminal.outcome === 'ok') {
      if (
        terminal.interrupted !== false ||
        typeof terminal.visionText !== 'string' ||
        terminal.visionText.length < 1 ||
        terminal.visionText.length > 1_048_576 ||
        terminal.reason !== undefined
      )
        throw new AuxiliaryVisionExecutionError('SETTLEMENT_INVALID', 'known success terminal is invalid')
    } else if (
      terminal.interrupted !== true ||
      terminal.visionText !== undefined ||
      terminal.reason !== (terminal.outcome === 'aborted' ? 'driver_aborted' : 'driver_failed')
    )
      throw new AuxiliaryVisionExecutionError('SETTLEMENT_INVALID', 'known failure terminal is invalid')
    return Object.freeze({
      kind: 'known_spend',
      outcome: terminal.outcome as KnownTerminal['outcome'],
      purpose: 'media',
      model: binding.model,
      interrupted: terminal.interrupted as boolean,
      tokens,
      credits: terminal.credits as number,
      creditSource: terminal.creditSource as KnownTerminal['creditSource'],
      ...(terminal.visionText === undefined ? {} : { visionText: terminal.visionText as string }),
      ...(terminal.reason === undefined
        ? {}
        : { reason: terminal.reason as NonNullable<KnownTerminal['reason']> }),
    })
  }
  if (head.kind === 'no_spend') {
    const terminal = plainOwn(value, [...common, 'reason'])
    const allowedReasons = ['cancelled_before_dispatch', 'driver_not_sent', 'effect_contract_invalid']
    if (
      terminal?.interrupted !== true ||
      !['error', 'aborted'].includes(terminal.outcome as string) ||
      !allowedReasons.includes(terminal.reason as string) ||
      (terminal.reason === 'cancelled_before_dispatch' && terminal.outcome !== 'aborted') ||
      (terminal.reason === 'effect_contract_invalid' && terminal.outcome !== 'error')
    )
      throw new AuxiliaryVisionExecutionError('SETTLEMENT_INVALID', 'no-spend terminal is invalid')
    return Object.freeze({
      kind: 'no_spend',
      outcome: terminal.outcome as NoSpendTerminal['outcome'],
      purpose: 'media',
      model: binding.model,
      interrupted: true,
      reason: terminal.reason as NoSpendTerminal['reason'],
    })
  }
  if (head.kind === 'unknown_spend') {
    const terminal = plainOwn(value, [...common, 'creditSource', 'reason'])
    if (
      terminal?.outcome !== 'unknown' ||
      terminal.interrupted !== true ||
      terminal.creditSource !== 'unknown' ||
      !['driver_outcome_unknown', 'driver_contract_invalid'].includes(terminal.reason as string)
    )
      throw new AuxiliaryVisionExecutionError('SETTLEMENT_INVALID', 'unknown-spend terminal is invalid')
    return Object.freeze({
      kind: 'unknown_spend',
      outcome: 'unknown',
      purpose: 'media',
      model: binding.model,
      interrupted: true,
      creditSource: 'unknown',
      reason: terminal.reason as UnknownSpendTerminal['reason'],
    })
  }
  throw new AuxiliaryVisionExecutionError('SETTLEMENT_INVALID', 'effect terminal kind is invalid')
}

function validateFinished(
  value: AuxiliaryVisionFinishedEffect,
  binding: AuxiliaryVisionEffectBinding,
): AuxiliaryVisionFinishedEffect {
  try {
    const finished = plainOwn(value, ['receipt', 'status', 'terminal'])
    if (finished?.status !== 'finished') throw new Error('finished shape')
    const terminal = parseTerminal(finished.terminal, binding)
    const receipt = plainOwn(
      finished.receipt,
      ['auditBindingHash', 'budgetBindingHash', 'requestDerivedHash', 'terminalHash', 'terminalSeq'],
      ['costOriginSeq'],
    )
    if (
      !receipt ||
      !positiveSeq(receipt.terminalSeq as number | undefined) ||
      receipt.auditBindingHash !== binding.auditBindingHash ||
      receipt.budgetBindingHash !== binding.budgetBindingHash ||
      receipt.requestDerivedHash !== binding.requestDerivedHash ||
      receipt.terminalHash !== sha256Hex(canonicalJson(terminal))
    )
      throw new Error('receipt binding')
    if (
      (terminal.kind === 'known_spend' && !positiveSeq(receipt.costOriginSeq as number | undefined)) ||
      (terminal.kind !== 'known_spend' && receipt.costOriginSeq !== undefined)
    )
      throw new Error('cost receipt')
    return Object.freeze({
      status: 'finished',
      terminal,
      receipt: Object.freeze({
        terminalSeq: receipt.terminalSeq as Seq,
        auditBindingHash: receipt.auditBindingHash as string,
        budgetBindingHash: receipt.budgetBindingHash as string,
        requestDerivedHash: receipt.requestDerivedHash as string,
        terminalHash: receipt.terminalHash as string,
        ...(receipt.costOriginSeq === undefined ? {} : { costOriginSeq: receipt.costOriginSeq as Seq }),
      }),
    })
  } catch (error) {
    if (error instanceof AuxiliaryVisionExecutionError) throw error
    throw new AuxiliaryVisionExecutionError('SETTLEMENT_INVALID', 'effect settlement is invalid')
  }
}

function parseEffectPhase(
  value: unknown,
  binding: AuxiliaryVisionEffectBinding,
): Awaited<ReturnType<AuxiliaryVisionEffectPort['begin']>> {
  const head = plainOwn(value, ['status'], ['intentSeq', 'receipt', 'terminal'])
  if (!head) throw new AuxiliaryVisionExecutionError('SETTLEMENT_INVALID', 'effect phase is invalid')
  if (head.status === 'admitted') {
    const admitted = plainOwn(value, ['intentSeq', 'status'])
    if (!admitted || !positiveSeq(admitted.intentSeq as number | undefined))
      throw new AuxiliaryVisionExecutionError('SETTLEMENT_INVALID', 'effect phase is invalid')
    return Object.freeze({ status: 'admitted', intentSeq: admitted.intentSeq as Seq })
  }
  if (head.status === 'in_progress') {
    if (!plainOwn(value, ['status']))
      throw new AuxiliaryVisionExecutionError('SETTLEMENT_INVALID', 'effect phase is invalid')
    return Object.freeze({ status: 'in_progress' })
  }
  if (head.status === 'finished') return validateFinished(value as AuxiliaryVisionFinishedEffect, binding)
  throw new AuxiliaryVisionExecutionError('SETTLEMENT_INVALID', 'effect phase is invalid')
}

async function settleReservation(
  session: SessionImpl,
  reservation: TreeReservationHandle | undefined,
  finished: AuxiliaryVisionFinishedEffect,
  binding: AuxiliaryVisionEffectBinding,
): Promise<void> {
  finished = validateFinished(finished, binding)
  if (!reservation) return
  if (finished.terminal.kind === 'no_spend') {
    await releaseTreeReservationHandle(session, reservation)
    return
  }
  const originSeq =
    finished.terminal.kind === 'known_spend'
      ? (finished.receipt.costOriginSeq as Seq)
      : finished.receipt.terminalSeq
  const credits = finished.terminal.kind === 'known_spend' ? finished.terminal.credits : undefined
  const creditSource =
    finished.terminal.kind === 'known_spend' ? finished.terminal.creditSource : ('unknown' as const)
  try {
    await settleTreeSpendHandle(session, reservation, credits, originSeq, creditSource)
  } catch (error) {
    const reconciled = await reconcileTreeReservationHandle(session, reservation)
    if (reconciled.status === 'settled' || reconciled.status === 'unknown') return
    if (reconciled.status === 'held') {
      await settleTreeSpendHandle(session, reservation, credits, originSeq, creditSource)
      return
    }
    throw error
  }
}

function validateDurableTerminal(
  durableStatus: 'settled' | 'released' | 'unknown',
  terminal: AuxiliaryVisionEffectTerminal,
): void {
  const matches =
    (durableStatus === 'settled' && terminal.kind === 'known_spend') ||
    (durableStatus === 'released' && terminal.kind === 'no_spend') ||
    (durableStatus === 'unknown' && terminal.kind === 'unknown_spend')
  if (!matches)
    throw new AuxiliaryVisionExecutionError(
      'SETTLEMENT_INVALID',
      'durable budget status disagrees with effect terminal',
    )
}

function terminalOutcome(
  plan: AuxiliaryVisionPlan,
  binding: AuxiliaryVisionEffectBinding,
  finished: AuxiliaryVisionFinishedEffect,
): AuxiliaryVisionOutcome {
  const checked = validateFinished(finished, binding)
  const outcome =
    checked.terminal.kind === 'known_spend' && checked.terminal.outcome === 'ok'
      ? auxiliaryVisionOutcome({
          axSomText: plan.axSomText,
          visionText: checked.terminal.visionText as string,
        })
      : fallback(plan)
  terminalOutcomes.set(
    outcome,
    Object.freeze({
      outcome,
      sessionKey: binding.sessionKey,
      lane: binding.lane,
      mediaManifestHash: binding.mediaManifestHash,
      effectId: binding.effectId,
      terminalSeq: checked.receipt.terminalSeq,
      terminalHash: checked.receipt.terminalHash,
    }),
  )
  return outcome
}

function controlledFallback(
  plan: AuxiliaryVisionPlan,
  binding: AuxiliaryVisionEffectBinding,
  state: AuxiliaryVisionExecutorFallbackAuthority['state'],
  reason: AuxiliaryVisionExecutorFallbackAuthority['reason'],
): AuxiliaryVisionOutcome {
  const outcome = fallback(plan)
  executorFallbackOutcomes.set(
    outcome,
    Object.freeze({
      outcome,
      sessionKey: binding.sessionKey,
      lane: binding.lane,
      mediaManifestHash: binding.mediaManifestHash,
      effectId: binding.effectId,
      state,
      reason,
    }),
  )
  return outcome
}

/** Executes or recovers one branded auxiliary effect; durable prior phases are never redispatched. */
export async function executeAuxiliaryVision(
  input: Readonly<{
    session: SessionImpl
    authority: AuxiliaryVisionExecutionAuthority
    signal: AbortSignal
    effects: AuxiliaryVisionEffectPort
    driver: AuxiliaryVisionDriver
  }>,
): Promise<AuxiliaryVisionOutcome> {
  if (!executionAuthorities.has(input.authority))
    throw new AuxiliaryVisionExecutionError('INPUT_INVALID', 'execution authority is invalid')
  const { plan } = input.authority
  if (plan.sessionKey !== input.session.key || plan.lane !== input.session.lane)
    throw new AuxiliaryVisionExecutionError('INPUT_INVALID', 'authority does not belong to this session lane')
  if (!(input.signal instanceof AbortSignal))
    throw new AuxiliaryVisionExecutionError('INPUT_INVALID', 'signal is invalid')

  const binding = Object.freeze({
    effectId: input.authority.effectId,
    sessionKey: plan.sessionKey,
    lane: plan.lane,
    auditBindingHash: input.authority.auditBindingHash,
    budgetBindingHash: input.authority.budgetBindingHash,
    mediaManifestHash: plan.mediaManifestHash,
    requestDerivedHash: plan.request.derivedHash,
    model: plan.request.model,
  })
  if (input.signal.aborted)
    return controlledFallback(plan, binding, 'not_dispatched', 'cancelled_before_reservation')

  const reserved = await reserveTreeBudgetHandle(
    input.session,
    input.authority.projectedCredits,
    { route: plan.request.route, model: plan.request.model },
    { effectId: input.authority.effectId, requestHash: input.authority.auditBindingHash },
    input.authority.inputTokens,
  )
  if (reserved.status === 'blocked')
    return controlledFallback(plan, binding, 'not_dispatched', 'budget_blocked')
  const reservation = reserved.status === 'reserved' ? reserved.handle : undefined
  if (input.signal.aborted && reserved.status !== 'terminal') {
    if (reservation) await releaseTreeReservationHandle(input.session, reservation)
    return controlledFallback(plan, binding, 'not_dispatched', 'cancelled_before_intent')
  }
  let phase: Awaited<ReturnType<AuxiliaryVisionEffectPort['begin']>>
  try {
    phase = parseEffectPhase(await input.effects.begin(binding), binding)
  } catch (cause) {
    if (reservation) await releaseTreeReservationHandle(input.session, reservation)
    if (cause instanceof AuxiliaryVisionExecutionError) throw cause
    throw new AuxiliaryVisionExecutionError('EFFECT_WRITE_FAILED', 'auxiliary intent persistence failed', {
      cause,
    })
  }
  if (phase.status === 'in_progress') {
    if (reserved.status === 'terminal')
      throw new AuxiliaryVisionExecutionError(
        'SETTLEMENT_INVALID',
        'terminal budget reservation has an in-progress effect',
      )
    return controlledFallback(plan, binding, 'durable_in_progress', 'effect_in_progress')
  }
  if (phase.status === 'finished') {
    const checked = validateFinished(phase, binding)
    if (reserved.status === 'terminal') {
      validateDurableTerminal(reserved.durableStatus, checked.terminal)
      return terminalOutcome(plan, binding, checked)
    }
    await settleReservation(input.session, reservation, checked, binding)
    return terminalOutcome(plan, binding, checked)
  }
  if (reserved.status === 'terminal')
    throw new AuxiliaryVisionExecutionError(
      'SETTLEMENT_INVALID',
      'terminal budget reservation has a dispatchable effect',
    )
  if (!positiveSeq(phase.intentSeq)) {
    const terminal: NoSpendTerminal = Object.freeze({
      kind: 'no_spend',
      outcome: 'error',
      purpose: 'media',
      model: plan.request.model,
      interrupted: true,
      reason: 'effect_contract_invalid',
    })
    const finished = await input.effects.finish(binding, terminal)
    await settleReservation(input.session, reservation, finished, binding)
    throw new AuxiliaryVisionExecutionError('SETTLEMENT_INVALID', 'effect intent receipt is invalid')
  }
  if (input.signal.aborted) {
    const terminal: NoSpendTerminal = Object.freeze({
      kind: 'no_spend',
      outcome: 'aborted',
      purpose: 'media',
      model: plan.request.model,
      interrupted: true,
      reason: 'cancelled_before_dispatch',
    })
    const finished = await input.effects.finish(binding, terminal)
    await settleReservation(input.session, reservation, finished, binding)
    return terminalOutcome(plan, binding, finished)
  }

  let terminal: AuxiliaryVisionEffectTerminal
  try {
    terminal = terminalForResult(
      await input.driver.dispatch({
        binding,
        intentSeq: phase.intentSeq,
        request: plan.request,
        timeoutMs: plan.timeoutMs,
        signal: input.signal,
      }),
      plan.request.model,
    )
  } catch {
    terminal = Object.freeze({
      kind: 'unknown_spend',
      outcome: 'unknown',
      purpose: 'media',
      model: plan.request.model,
      interrupted: true,
      creditSource: 'unknown',
      reason: 'driver_outcome_unknown',
    })
  }
  let finished: AuxiliaryVisionFinishedEffect
  try {
    finished = await input.effects.finish(binding, terminal)
  } catch (cause) {
    throw new AuxiliaryVisionExecutionError('EFFECT_WRITE_FAILED', 'auxiliary terminal persistence failed', {
      cause,
    })
  }
  const checked = validateFinished(finished, binding)
  if (canonicalJson(checked.terminal) !== canonicalJson(terminal))
    throw new AuxiliaryVisionExecutionError('SETTLEMENT_INVALID', 'effect terminal receipt changed identity')
  await settleReservation(input.session, reservation, checked, binding)
  return terminalOutcome(plan, binding, checked)
}
