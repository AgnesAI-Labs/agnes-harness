import { types as utilTypes } from 'node:util'
import type { TokenCounts } from '@agnes/protocol'
import { scanAll } from '../log/scan-pages.js'
import { canonicalJson, sha256Hex } from '../request/hash.js'
import type { SessionImpl } from '../step/session.js'
import type { Event, EventInput, Seq } from '../types.js'
import {
  type AuxiliaryVisionEffectBinding,
  type AuxiliaryVisionEffectPort,
  type AuxiliaryVisionEffectTerminal,
  AuxiliaryVisionExecutionError,
  type AuxiliaryVisionFinishedEffect,
} from './auxiliary-vision-executor.js'

const INTENT_EVENT = 'effect/intent'
const TERMINAL_EVENT = 'effect/settled'
const INTENT_METADATA_EVENT = 'x/core/auxiliary-vision-intent'
const TERMINAL_METADATA_EVENT = 'x/core/auxiliary-vision-terminal'
const HASH = /^[0-9a-f]{64}$/u
const EFFECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u
const SENSITIVE = /(?:authorization|bearer|credential|secret|password|api[_-]?key|token|sk-[A-Za-z0-9])/iu

type Snapshot = Readonly<Record<string, unknown>>
type DurableState =
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'in_progress' }>
  | AuxiliaryVisionFinishedEffect

function invalid(message: string): never {
  throw new AuxiliaryVisionExecutionError('SETTLEMENT_INVALID', message)
}

function bounded(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 0x1f || code === 0x7f
    })
  )
}

function exactOwn(value: unknown, fields: readonly string[]): Snapshot | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value))
      return undefined
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== 'string' || !fields.includes(key)) ||
      fields.some((key) => {
        const descriptor = descriptors[key]
        return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
      })
    )
      return undefined
    const copy = Object.create(null) as Record<string, unknown>
    for (const key of fields) copy[key] = descriptors[key]?.value
    return Object.freeze(copy)
  } catch {
    return undefined
  }
}

function snapshotBinding(value: unknown): AuxiliaryVisionEffectBinding {
  const record = exactOwn(value, [
    'effectId',
    'sessionKey',
    'lane',
    'auditBindingHash',
    'budgetBindingHash',
    'mediaManifestHash',
    'requestDerivedHash',
    'model',
  ])
  if (
    !record ||
    typeof record.effectId !== 'string' ||
    !EFFECT_ID.test(record.effectId) ||
    SENSITIVE.test(record.effectId) ||
    !bounded(record.sessionKey, 512) ||
    !bounded(record.lane, 64) ||
    !bounded(record.model, 256) ||
    typeof record.auditBindingHash !== 'string' ||
    !HASH.test(record.auditBindingHash) ||
    typeof record.budgetBindingHash !== 'string' ||
    !HASH.test(record.budgetBindingHash) ||
    typeof record.mediaManifestHash !== 'string' ||
    !HASH.test(record.mediaManifestHash) ||
    typeof record.requestDerivedHash !== 'string' ||
    !HASH.test(record.requestDerivedHash)
  )
    invalid('auxiliary effect binding is invalid')
  return Object.freeze({
    effectId: record.effectId,
    sessionKey: record.sessionKey,
    lane: record.lane,
    auditBindingHash: record.auditBindingHash,
    budgetBindingHash: record.budgetBindingHash,
    mediaManifestHash: record.mediaManifestHash,
    requestDerivedHash: record.requestDerivedHash,
    model: record.model,
  })
}

function parseTokens(value: unknown): TokenCounts {
  const record =
    exactOwn(value, ['input', 'output', 'cacheRead', 'cacheWrite']) ??
    exactOwn(value, ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'])
  if (
    !record ||
    !['input', 'output', 'cacheRead', 'cacheWrite'].every(
      (key) => Number.isSafeInteger(record[key]) && (record[key] as number) >= 0,
    ) ||
    (record.reasoning !== undefined &&
      (!Number.isSafeInteger(record.reasoning) || (record.reasoning as number) < 0))
  )
    invalid('auxiliary effect usage is invalid')
  return Object.freeze({
    input: record.input as number,
    output: record.output as number,
    cacheRead: record.cacheRead as number,
    cacheWrite: record.cacheWrite as number,
    ...(record.reasoning === undefined ? {} : { reasoning: record.reasoning as number }),
  })
}

function snapshotTerminal(
  value: unknown,
  binding: AuxiliaryVisionEffectBinding,
): AuxiliaryVisionEffectTerminal {
  const head =
    exactOwn(value, ['kind', 'outcome', 'purpose', 'model', 'interrupted', 'reason']) ??
    exactOwn(value, ['kind', 'outcome', 'purpose', 'model', 'interrupted', 'creditSource', 'reason']) ??
    exactOwn(value, [
      'kind',
      'outcome',
      'purpose',
      'model',
      'interrupted',
      'tokens',
      'credits',
      'creditSource',
      'visionText',
    ]) ??
    exactOwn(value, [
      'kind',
      'outcome',
      'purpose',
      'model',
      'interrupted',
      'tokens',
      'credits',
      'creditSource',
      'reason',
    ])
  if (head?.purpose !== 'media' || head.model !== binding.model)
    invalid('auxiliary effect terminal binding is invalid')
  if (head.kind === 'known_spend') {
    const tokens = parseTokens(head.tokens)
    if (
      (head.outcome !== 'ok' && head.outcome !== 'error' && head.outcome !== 'aborted') ||
      !Number.isFinite(head.credits) ||
      (head.credits as number) < 0 ||
      (head.creditSource !== 'gateway' && head.creditSource !== 'estimated')
    )
      invalid('known auxiliary effect terminal is invalid')
    if (head.outcome === 'ok') {
      if (
        head.interrupted !== false ||
        typeof head.visionText !== 'string' ||
        head.visionText.length < 1 ||
        head.visionText.length > 1_048_576
      )
        invalid('successful auxiliary effect terminal is invalid')
      return Object.freeze({
        kind: 'known_spend',
        outcome: 'ok',
        purpose: 'media',
        model: binding.model,
        interrupted: false,
        tokens,
        credits: head.credits as number,
        creditSource: head.creditSource,
        visionText: head.visionText,
      })
    }
    if (
      head.interrupted !== true ||
      head.reason !== (head.outcome === 'aborted' ? 'driver_aborted' : 'driver_failed')
    )
      invalid('failed auxiliary effect terminal is invalid')
    return Object.freeze({
      kind: 'known_spend',
      outcome: head.outcome,
      purpose: 'media',
      model: binding.model,
      interrupted: true,
      tokens,
      credits: head.credits as number,
      creditSource: head.creditSource,
      reason: head.reason as 'driver_aborted' | 'driver_failed',
    })
  }
  if (head.kind === 'no_spend') {
    if (
      (head.outcome !== 'error' && head.outcome !== 'aborted') ||
      head.interrupted !== true ||
      (head.reason !== 'cancelled_before_dispatch' &&
        head.reason !== 'driver_not_sent' &&
        head.reason !== 'effect_contract_invalid') ||
      (head.reason === 'cancelled_before_dispatch' && head.outcome !== 'aborted') ||
      (head.reason === 'effect_contract_invalid' && head.outcome !== 'error')
    )
      invalid('no-spend auxiliary effect terminal is invalid')
    return Object.freeze({
      kind: 'no_spend',
      outcome: head.outcome,
      purpose: 'media',
      model: binding.model,
      interrupted: true,
      reason: head.reason,
    })
  }
  if (
    head.kind !== 'unknown_spend' ||
    head.outcome !== 'unknown' ||
    head.interrupted !== true ||
    head.creditSource !== 'unknown' ||
    (head.reason !== 'driver_outcome_unknown' && head.reason !== 'driver_contract_invalid')
  )
    invalid('unknown-spend auxiliary effect terminal is invalid')
  return Object.freeze({
    kind: 'unknown_spend',
    outcome: 'unknown',
    purpose: 'media',
    model: binding.model,
    interrupted: true,
    creditSource: 'unknown',
    reason: head.reason,
  })
}

function sameBinding(left: AuxiliaryVisionEffectBinding, right: AuxiliaryVisionEffectBinding): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function eventData(event: Event): Snapshot | undefined {
  try {
    if (
      !event.data ||
      typeof event.data !== 'object' ||
      Array.isArray(event.data) ||
      utilTypes.isProxy(event.data)
    )
      return undefined
    const keys = Reflect.ownKeys(Object.getOwnPropertyDescriptors(event.data))
    if (keys.some((key) => typeof key !== 'string')) return undefined
    return exactOwn(event.data, keys as string[])
  } catch {
    return undefined
  }
}

function requireTrustedEvents(events: readonly Event[]): void {
  for (const event of events) {
    if (event.origin !== 'system' || event.trust !== 'trusted')
      invalid('durable auxiliary event authority is invalid')
    if (
      (event.type === INTENT_METADATA_EVENT || event.type === TERMINAL_METADATA_EVENT) &&
      event.ignorable !== true
    )
      invalid('durable auxiliary metadata marker is invalid')
  }
}

function matching(events: readonly Event[], type: string, effectId: string): Event[] {
  return events.filter((event) => event.type === type && eventData(event)?.effectId === effectId)
}

function parseIntentRecord(event: Event): { binding: AuxiliaryVisionEffectBinding; bindingHash: string } {
  const data = exactOwn(event.data, ['version', 'binding', 'bindingHash'])
  if (data?.version !== 1 || typeof data.bindingHash !== 'string' || !HASH.test(data.bindingHash))
    invalid('durable auxiliary intent is invalid')
  const binding = snapshotBinding(data.binding)
  if (data.bindingHash !== sha256Hex(canonicalJson(binding)))
    invalid('durable auxiliary intent hash is invalid')
  return { binding, bindingHash: data.bindingHash }
}

function validateCost(
  event: Event,
  binding: AuxiliaryVisionEffectBinding,
  terminal: Extract<AuxiliaryVisionEffectTerminal, { kind: 'known_spend' }>,
): void {
  const data = exactOwn(event.data, [
    'purpose',
    'effectId',
    'tokens',
    'credits',
    'creditSource',
    'model',
    'interrupted',
  ])
  const tokens = data ? parseTokens(data.tokens) : undefined
  if (
    data?.purpose !== 'media' ||
    data.effectId !== binding.effectId ||
    data.credits !== terminal.credits ||
    data.creditSource !== terminal.creditSource ||
    data.model !== terminal.model ||
    data.interrupted !== terminal.interrupted ||
    canonicalJson(tokens) !== canonicalJson(terminal.tokens)
  )
    invalid('durable auxiliary cost is invalid')
}

function finishedReceipt(
  terminal: AuxiliaryVisionEffectTerminal,
  binding: AuxiliaryVisionEffectBinding,
  terminalSeq: Seq,
  costOriginSeq?: Seq,
): AuxiliaryVisionFinishedEffect {
  return Object.freeze({
    status: 'finished',
    terminal,
    receipt: Object.freeze({
      terminalSeq,
      ...(costOriginSeq === undefined ? {} : { costOriginSeq }),
      auditBindingHash: binding.auditBindingHash,
      budgetBindingHash: binding.budgetBindingHash,
      requestDerivedHash: binding.requestDerivedHash,
      terminalHash: sha256Hex(canonicalJson(terminal)),
    }),
  })
}

async function inspect(session: SessionImpl, expected: AuxiliaryVisionEffectBinding): Promise<DurableState> {
  const toSeq = session.lastSeq
  const events = await scanAll((q) => session.scan(q), {
    toSeq,
    lane: session.lane,
    type: [INTENT_EVENT, INTENT_METADATA_EVENT, TERMINAL_EVENT, TERMINAL_METADATA_EVENT, 'cost/ledger'],
  })
  requireTrustedEvents(events)
  const intents = matching(events, INTENT_EVENT, expected.effectId)
  const bindings = events.filter((event) => {
    if (event.type !== INTENT_METADATA_EVENT) return false
    return parseIntentRecord(event).binding.effectId === expected.effectId
  })
  const settlements = matching(events, TERMINAL_EVENT, expected.effectId)
  const terminals = matching(events, TERMINAL_METADATA_EVENT, expected.effectId)
  const costs = matching(events, 'cost/ledger', expected.effectId)
  if (
    intents.length === 0 &&
    bindings.length === 0 &&
    settlements.length === 0 &&
    terminals.length === 0 &&
    costs.length === 0
  )
    return Object.freeze({ status: 'absent' })
  if (intents.length !== 1 || bindings.length !== 1) invalid('durable auxiliary effect identity is ambiguous')
  const intentData = exactOwn((intents[0] as Event).data, ['effectId', 'kind', 'replay'])
  if (
    intentData?.effectId !== expected.effectId ||
    intentData.kind !== 'media' ||
    intentData.replay !== 'never' ||
    (bindings[0] as Event).seq !== (intents[0] as Event).seq + 1
  )
    invalid('durable auxiliary lifecycle intent is invalid')
  const durable = parseIntentRecord(bindings[0] as Event)
  if (!sameBinding(durable.binding, expected)) invalid('auxiliary effect identity collision')
  if (settlements.length === 0 && terminals.length === 0) {
    if (costs.length !== 0) invalid('unfinished auxiliary effect has cost rows')
    return Object.freeze({ status: 'in_progress' })
  }
  if (settlements.length === 1 && terminals.length === 0) {
    const settlement = settlements[0] as Event
    const settlementData = exactOwn(settlement.data, ['effectId', 'outcome'])
    if (
      settlementData?.effectId !== expected.effectId ||
      settlementData.outcome !== 'unknown' ||
      costs.length !== 0
    )
      invalid('recovered auxiliary settlement is invalid')
    const terminal: AuxiliaryVisionEffectTerminal = Object.freeze({
      kind: 'unknown_spend',
      outcome: 'unknown',
      purpose: 'media',
      model: expected.model,
      interrupted: true,
      creditSource: 'unknown',
      reason: 'driver_outcome_unknown',
    })
    return finishedReceipt(terminal, expected, settlement.seq)
  }
  if (settlements.length !== 1 || terminals.length !== 1) invalid('durable auxiliary terminal is ambiguous')
  const settlementEvent = settlements[0] as Event
  const terminalEvent = terminals[0] as Event
  const terminalData = exactOwn(terminalEvent.data, [
    'version',
    'effectId',
    'bindingHash',
    'terminal',
    'terminalHash',
  ])
  if (
    terminalData?.version !== 1 ||
    terminalData.effectId !== expected.effectId ||
    terminalData.bindingHash !== durable.bindingHash
  )
    invalid('durable auxiliary terminal binding is invalid')
  const terminal = snapshotTerminal(terminalData.terminal, expected)
  const settlementData = exactOwn(settlementEvent.data, ['effectId', 'outcome'])
  if (
    settlementData?.effectId !== expected.effectId ||
    settlementData.outcome !== terminal.outcome ||
    terminalEvent.seq !== settlementEvent.seq + 1
  )
    invalid('durable auxiliary settlement outcome is invalid')
  if (terminalData.terminalHash !== sha256Hex(canonicalJson(terminal)))
    invalid('durable auxiliary terminal hash is invalid')
  if (terminal.kind === 'known_spend') {
    if (costs.length !== 1) invalid('known auxiliary spend lacks one cost row')
    const cost = costs[0] as Event
    validateCost(cost, expected, terminal)
    if (cost.seq !== terminalEvent.seq + 1)
      invalid('durable auxiliary terminal transaction is not contiguous')
    return finishedReceipt(terminal, expected, settlementEvent.seq, cost.seq)
  }
  if (costs.length !== 0) invalid('no-cost auxiliary terminal transaction is invalid')
  return finishedReceipt(terminal, expected, settlementEvent.seq)
}

function intentEvents(
  session: SessionImpl,
  binding: AuxiliaryVisionEffectBinding,
  bindingHash: string,
): EventInput[] {
  return [
    session.ev(INTENT_EVENT, { effectId: binding.effectId, kind: 'media', replay: 'never' }),
    session.ev(INTENT_METADATA_EVENT, { version: 1, binding, bindingHash }, { ignorable: true }),
  ]
}

function terminalEvents(
  session: SessionImpl,
  binding: AuxiliaryVisionEffectBinding,
  bindingHash: string,
  terminal: AuxiliaryVisionEffectTerminal,
): EventInput[] {
  const terminalHash = sha256Hex(canonicalJson(terminal))
  const cost =
    terminal.kind === 'known_spend'
      ? [
          session.ev('cost/ledger', {
            purpose: 'media',
            effectId: binding.effectId,
            tokens: terminal.tokens,
            credits: terminal.credits,
            creditSource: terminal.creditSource,
            model: terminal.model,
            interrupted: terminal.interrupted,
          }),
        ]
      : []
  return [
    session.ev(TERMINAL_EVENT, { effectId: binding.effectId, outcome: terminal.outcome }),
    session.ev(
      TERMINAL_METADATA_EVENT,
      { version: 1, effectId: binding.effectId, bindingHash, terminal, terminalHash },
      { ignorable: true },
    ),
    ...cost,
  ]
}

/**
 * Adapts the session ledger to the executor's effect port. Intent and terminal transactions are
 * serialized with all other session writes; recovery never admits a second dispatch for an
 * in-progress or durably terminal effect.
 */
export function createAuxiliaryVisionEffectPort(session: SessionImpl): AuxiliaryVisionEffectPort {
  return Object.freeze({
    async begin(value: AuxiliaryVisionEffectBinding) {
      const binding = snapshotBinding(value)
      if (binding.sessionKey !== session.key || binding.lane !== session.lane)
        invalid('auxiliary effect does not belong to this session lane')
      return session.locked(async () => {
        const prior = await inspect(session, binding)
        if (prior.status !== 'absent') return prior
        const bindingHash = sha256Hex(canonicalJson(binding))
        const committed = await session.append(intentEvents(session, binding, bindingHash))
        const intentSeq = committed.seqs[0]
        if (intentSeq === undefined) invalid('auxiliary effect intent sequence is missing')
        return Object.freeze({ status: 'admitted', intentSeq })
      })
    },
    async finish(value: AuxiliaryVisionEffectBinding, terminalValue: AuxiliaryVisionEffectTerminal) {
      const binding = snapshotBinding(value)
      if (binding.sessionKey !== session.key || binding.lane !== session.lane)
        invalid('auxiliary effect does not belong to this session lane')
      const terminal = snapshotTerminal(terminalValue, binding)
      return session.locked(async () => {
        const prior = await inspect(session, binding)
        if (prior.status === 'absent') invalid('auxiliary effect has no durable intent')
        if (prior.status === 'finished') {
          if (canonicalJson(prior.terminal) !== canonicalJson(terminal))
            invalid('auxiliary effect already has a different terminal')
          return prior
        }
        const bindingHash = sha256Hex(canonicalJson(binding))
        const committed = await session.append(terminalEvents(session, binding, bindingHash, terminal))
        const terminalSeq = committed.seqs[0]
        const costOriginSeq = terminal.kind === 'known_spend' ? committed.seqs[2] : undefined
        if (terminalSeq === undefined || (terminal.kind === 'known_spend' && costOriginSeq === undefined))
          invalid('auxiliary effect terminal sequence is missing')
        return finishedReceipt(terminal, binding, terminalSeq, costOriginSeq)
      })
    },
  })
}
