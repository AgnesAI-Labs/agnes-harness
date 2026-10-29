import { types as utilTypes } from 'node:util'
import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import { CoreError, type EventInput } from '@agnes/core-common/types'
import type { SideCallFailure, SideCallResult, SideCallUsage } from '@agnes/extension-api'
import {
  AI_ERROR_CODES,
  type AiErrorCode,
  type Billing,
  type JsonValue,
  type TokenCounts,
} from '@agnes/protocol'
import {
  type AuxiliaryVisionEffectTerminal,
  AuxiliaryVisionExecutionError,
} from './auxiliary-vision-executor.js'

/** The auxiliary model calls whose ledger rows share this layer: auxiliary vision and side calls. */
export type LedgerPurpose = 'media' | 'side-call'
export type TerminalKind = 'known_spend' | 'no_spend' | 'unknown_spend'
export type Invalid = (message: string) => never
type Snapshot = Readonly<Record<string, unknown>>

export const MAX_OUTPUT_TEXT = 1_048_576
/**
 * The longest retry hint a side call keeps, in milliseconds: one hour. A vendor asking a caller to
 * wait longer than that is not a hint a loop can act on within a turn; such a value, like any value
 * that is not a whole non-negative number of milliseconds, is dropped rather than recorded.
 */
export const MAX_RETRY_AFTER_MS = 3_600_000
const SETTLED_EVENT = 'effect/settled'
const COST_EVENT = 'cost/ledger'

/** Reads own enumerable data properties only, so a getter or proxy is refused without being run. */
export function ownData(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Snapshot | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value))
      return undefined
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    if (
      keys.some((key) => typeof key !== 'string' || (!required.includes(key) && !optional.includes(key))) ||
      required.some((key) => !Object.hasOwn(descriptors, key)) ||
      keys.some((key) => {
        const descriptor = descriptors[key as string]
        return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
      })
    )
      return undefined
    const copy = Object.create(null) as Record<string, unknown>
    for (const key of [...required, ...optional])
      if (Object.hasOwn(descriptors, key)) copy[key] = descriptors[key]?.value
    return Object.freeze(copy)
  } catch {
    return undefined
  }
}

/** A snapshot with exactly these keys, in this order. */
export const exactOwn = (value: unknown, fields: readonly string[]): Snapshot | undefined =>
  ownData(value, fields)

export function bounded(value: unknown, maximum: number): value is string {
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

export const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0
export const amount = (value: unknown): value is number => Number.isFinite(value) && (value as number) >= 0
export const trusted = (row: Pick<EventInput, 'origin' | 'trust'>): boolean =>
  row.origin === 'system' && row.trust === 'trusted'

/** Reads a row's effect id without running a getter. */
export function effectIdOf(data: unknown): unknown {
  if (!data || typeof data !== 'object' || utilTypes.isProxy(data)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(data, 'effectId')
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
}

export function parseTokens(value: unknown, invalid: Invalid, message: string): TokenCounts {
  const record =
    exactOwn(value, ['input', 'output', 'cacheRead', 'cacheWrite']) ??
    exactOwn(value, ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'])
  if (
    !record ||
    !['input', 'output', 'cacheRead', 'cacheWrite'].every((key) => count(record[key])) ||
    (record.reasoning !== undefined && !count(record.reasoning))
  )
    invalid(message)
  return Object.freeze({
    input: record.input as number,
    output: record.output as number,
    cacheRead: record.cacheRead as number,
    cacheWrite: record.cacheWrite as number,
    ...(record.reasoning === undefined ? {} : { reasoning: record.reasoning as number }),
  })
}

type SideCallTiming = NonNullable<SideCallUsage['timing']>
type SideCallResponse = Readonly<{ id?: string; model?: string }>
type SideCallSpend = {
  tokens: TokenCounts
  credits: number
  creditSource: 'gateway' | 'estimated'
  billing?: Billing
  timing?: SideCallTiming
}
type SideCallCommon = { purpose: 'side-call'; model: string; latencyMs: number }
export type SideCallKnownReason =
  | 'driver_failed'
  | 'deadline_exceeded'
  | 'caller_cancelled'
  | 'session_cancelled'
  | 'invalid_output'
export type SideCallNoSpendReason = 'cancelled_before_dispatch' | 'driver_not_sent'
export type SideCallUnknownReason =
  | 'adapter_error'
  | 'deadline_exceeded'
  | 'caller_cancelled'
  | 'session_cancelled'

/**
 * How a side call ended, as its terminal row records it. Known spend copies the observed usage,
 * unknown spend copies the estimate written to the cost row, and no spend means a zero cost row.
 * `code` and `retryable` are recorded where the result cannot derive them, an adapter error keeps the
 * vendor's retry hint when it gave one, and `text` is kept for a success and for output that failed
 * to parse. `interrupted` is false only for a call that ran to
 * completion: a success, or output that failed to parse.
 */
export type SideCallEffectTerminal =
  | Readonly<
      SideCallCommon &
        SideCallSpend & {
          kind: 'known_spend'
          outcome: 'ok'
          interrupted: false
          text: string
          response?: SideCallResponse
        }
    >
  | Readonly<
      SideCallCommon &
        SideCallSpend & {
          kind: 'known_spend'
          outcome: 'error' | 'aborted'
          interrupted: boolean
          text?: string
          reason: SideCallKnownReason
          code?: AiErrorCode
          retryable?: boolean
          retryAfterMs?: number
        }
    >
  | Readonly<
      SideCallCommon & {
        kind: 'no_spend'
        outcome: 'error' | 'aborted'
        interrupted: true
        reason: SideCallNoSpendReason
        code?: AiErrorCode
        retryable?: boolean
        retryAfterMs?: number
      }
    >
  | Readonly<
      SideCallCommon &
        Omit<SideCallSpend, 'credits' | 'creditSource' | 'billing'> & {
          kind: 'unknown_spend'
          outcome: 'error' | 'aborted'
          interrupted: true
          credits?: number
          creditSource: 'estimated'
          reason: SideCallUnknownReason
          code?: AiErrorCode
          retryable?: boolean
          retryAfterMs?: number
        }
    >

/**
 * One terminal reason: the kinds and settled outcomes it may pair with, whether the call ran to
 * completion, and for side calls the code it records and the failure a loop sees.
 */
type ReasonRule = Readonly<{
  kinds: readonly TerminalKind[]
  outcomes: readonly string[]
  completed?: true
  code?: 'adapter' | 'TIMEOUT'
  text?: true
  failure?: SideCallFailure
}>

/** The terminal side of a purpose: its terminal row, the commit that carries it, and its shapes. */
type TerminalRules = Readonly<{
  noun: string
  event: string
  invalid: Invalid
  /** The settlement rows of one effect, in the order the purpose commits them. */
  order(kind: TerminalKind): readonly string[]
  costKeys: Readonly<{ required: readonly string[]; optional: readonly string[] }>
  /** Picks out the fields every terminal shares; media only accepts its historical exact key sets. */
  head(value: unknown): Snapshot | undefined
  /** True when `head` already pins the exact key set, so variants need no key check of their own. */
  exactHead: boolean
  minOutput: number
  unknownCreditSource: 'unknown' | 'estimated'
  reasons: Readonly<Record<string, ReasonRule>>
  /** The fields one variant carries beyond the shared head, required and optional. */
  fields(kind: TerminalKind, rule: ReasonRule | undefined): { required: string[]; optional: string[] }
}>

const HEAD = ['kind', 'outcome', 'purpose', 'model', 'interrupted']
const PAID = ['gateway', 'estimated']
// Every field a terminal can carry, in the order terminals are written.
const FIELD_ORDER = [
  'tokens',
  'credits',
  'creditSource',
  'billing',
  'timing',
  'visionText',
  'text',
  'response',
  'reason',
  'code',
  'retryable',
  'retryAfterMs',
  'latencyMs',
]
const MEDIA_KEY_SETS = [
  [...HEAD, 'reason'],
  [...HEAD, 'creditSource', 'reason'],
  [...HEAD, 'tokens', 'credits', 'creditSource', 'visionText'],
  [...HEAD, 'tokens', 'credits', 'creditSource', 'reason'],
]
const SIDE_CALL_KEYS = FIELD_ORDER.filter((key) => key !== 'visionText')
const SPENT: readonly TerminalKind[] = ['known_spend', 'unknown_spend']
const reason = (
  kinds: readonly TerminalKind[],
  outcomes: readonly string[],
  failure: SideCallFailure,
  extra: Omit<ReasonRule, 'kinds' | 'outcomes' | 'failure'> = {},
): ReasonRule => ({ kinds, outcomes, failure, ...extra })

const RULES: Readonly<Record<LedgerPurpose, TerminalRules>> = {
  media: {
    noun: 'auxiliary effect',
    event: 'x/core/auxiliary-vision-terminal',
    invalid: (message) => {
      throw new AuxiliaryVisionExecutionError('SETTLEMENT_INVALID', message)
    },
    order: (kind) =>
      kind === 'known_spend'
        ? [SETTLED_EVENT, 'x/core/auxiliary-vision-terminal', COST_EVENT]
        : [SETTLED_EVENT, 'x/core/auxiliary-vision-terminal'],
    costKeys: {
      required: ['purpose', 'effectId', 'tokens', 'credits', 'creditSource', 'model', 'interrupted'],
      optional: [],
    },
    head: (value) =>
      MEDIA_KEY_SETS.reduce<Snapshot | undefined>((found, keys) => found ?? exactOwn(value, keys), undefined),
    exactHead: true,
    minOutput: 1,
    unknownCreditSource: 'unknown',
    reasons: {
      driver_failed: { kinds: ['known_spend'], outcomes: ['error'] },
      driver_aborted: { kinds: ['known_spend'], outcomes: ['aborted'] },
      cancelled_before_dispatch: { kinds: ['no_spend'], outcomes: ['aborted'] },
      driver_not_sent: { kinds: ['no_spend'], outcomes: ['error', 'aborted'] },
      effect_contract_invalid: { kinds: ['no_spend'], outcomes: ['error'] },
      driver_outcome_unknown: { kinds: ['unknown_spend'], outcomes: ['unknown'] },
      driver_contract_invalid: { kinds: ['unknown_spend'], outcomes: ['unknown'] },
    },
    fields: (kind, rule) => ({
      required:
        kind === 'known_spend'
          ? ['tokens', 'credits', 'creditSource', rule ? 'reason' : 'visionText']
          : kind === 'no_spend'
            ? ['reason']
            : ['creditSource', 'reason'],
      optional: [],
    }),
  },
  'side-call': {
    noun: 'side-call effect',
    event: 'x/core/side-call-terminal',
    invalid: (message) => {
      throw new CoreError('E_ENVELOPE', message)
    },
    // A model execution hands back the cost row before the settlement; the terminal row goes last.
    order: () => [COST_EVENT, SETTLED_EVENT, 'x/core/side-call-terminal'],
    costKeys: {
      required: ['purpose', 'effectId', 'model', 'tokens', 'creditSource'],
      optional: [
        'credits',
        'interrupted',
        'billing',
        'timing',
        'response',
        'route',
        'adapter',
        'endpointHost',
      ],
    },
    head: (value) => ownData(value, HEAD, SIDE_CALL_KEYS),
    exactHead: false,
    minOutput: 0,
    unknownCreditSource: 'estimated',
    reasons: {
      cancelled_before_dispatch: reason(['no_spend'], ['error', 'aborted'], 'cancelled'),
      driver_not_sent: reason(['no_spend'], ['error'], 'adapter-error', { code: 'adapter' }),
      driver_failed: reason(['known_spend'], ['error'], 'adapter-error', { code: 'adapter' }),
      adapter_error: reason(['unknown_spend'], ['error'], 'adapter-error', { code: 'adapter' }),
      deadline_exceeded: reason(SPENT, ['error'], 'deadline', { code: 'TIMEOUT' }),
      caller_cancelled: reason(SPENT, ['error'], 'cancelled'),
      session_cancelled: reason(SPENT, ['aborted'], 'cancelled'),
      invalid_output: reason(['known_spend'], ['error'], 'invalid-output', { completed: true, text: true }),
    },
    fields: (kind, rule) => {
      const required = ['latencyMs']
      const optional: string[] = []
      if (kind === 'known_spend') required.push('tokens', 'credits', 'creditSource')
      if (kind === 'known_spend') optional.push('billing', 'timing')
      if (kind === 'unknown_spend') required.push('tokens', 'creditSource')
      if (kind === 'unknown_spend') optional.push('credits', 'timing')
      if (!rule) required.push('text')
      if (!rule) optional.push('response')
      else required.push('reason')
      if (rule?.text) required.push('text')
      if (rule?.code) required.push('code')
      else if (rule) optional.push('code')
      if (rule?.code === 'adapter') required.push('retryable')
      if (rule?.code === 'adapter') optional.push('retryAfterMs')
      return { required, optional }
    },
  },
}

export type TerminalSide = Readonly<{ event: string; noun: string; invalid: Invalid }>
/** The terminal row type of a purpose, and how its rows are named and refused. */
export const terminalSide = (purpose: LedgerPurpose): TerminalSide => RULES[purpose]

function billing(value: unknown): Billing | undefined {
  const record = exactOwn(value, ['usdMicros', 'source', 'subscription'])
  if (
    !record ||
    !count(record.usdMicros) ||
    !PAID.includes(record.source as string) ||
    typeof record.subscription !== 'boolean'
  )
    return undefined
  return Object.freeze({
    usdMicros: record.usdMicros,
    source: record.source as Billing['source'],
    subscription: record.subscription,
  })
}

function optionalFields<T extends string>(
  value: unknown,
  fields: Readonly<Record<T, (v: unknown) => boolean>>,
) {
  const keys = Object.keys(fields) as T[]
  const record = ownData(value, [], keys)
  if (!record || keys.some((key) => record[key] !== undefined && !fields[key](record[key]))) return undefined
  return Object.freeze(
    Object.fromEntries(keys.filter((key) => record[key] !== undefined).map((key) => [key, record[key]])),
  )
}

/** The checked, normalized value of one terminal field, or undefined when it is invalid. */
function field(
  key: string,
  value: unknown,
  kind: TerminalKind,
  rule: ReasonRule | undefined,
  rules: TerminalRules,
) {
  switch (key) {
    case 'credits':
      return amount(value) ? value : undefined
    case 'creditSource':
      return (kind === 'unknown_spend' ? [rules.unknownCreditSource] : PAID).includes(value as string)
        ? value
        : undefined
    case 'billing':
      return billing(value)
    case 'timing':
      return optionalFields(value, { ttftMs: count, durationMs: count })
    case 'visionText':
    case 'text':
      return typeof value === 'string' && value.length >= rules.minOutput && value.length <= MAX_OUTPUT_TEXT
        ? value
        : undefined
    case 'response':
      return optionalFields(value, { id: (v) => bounded(v, 128), model: (v) => bounded(v, 256) })
    case 'code':
      if (rule?.code === 'TIMEOUT') return value === 'TIMEOUT' ? value : undefined
      return AI_ERROR_CODES.includes(value as AiErrorCode) ? value : undefined
    case 'retryAfterMs':
      return count(value) && value <= MAX_RETRY_AFTER_MS ? value : undefined
    case 'retryable':
      return typeof value === 'boolean' ? value : undefined
    case 'latencyMs':
      return count(value) ? value : undefined
    default:
      return value
  }
}

/**
 * Validates and freezes one terminal for a purpose. The purpose decides the output field, which
 * outcome and reason pairs are allowed, and the fields each variant carries. Getters and proxies are
 * refused without being run; the result is a fresh frozen object in the order terminals are written.
 */
export function snapshotTerminal(
  purpose: 'media',
  value: unknown,
  model: string,
  invalid: Invalid,
): AuxiliaryVisionEffectTerminal
export function snapshotTerminal(
  purpose: 'side-call',
  value: unknown,
  model: string,
  invalid: Invalid,
): SideCallEffectTerminal
export function snapshotTerminal(
  purpose: LedgerPurpose,
  value: unknown,
  model: string,
  invalid: Invalid,
): AuxiliaryVisionEffectTerminal | SideCallEffectTerminal {
  const rules = RULES[purpose]
  const head = rules.head(value)
  if (head?.purpose !== purpose || head.model !== model) invalid(`${rules.noun} terminal binding is invalid`)
  const kind = head.kind as TerminalKind
  let tokens: TokenCounts | undefined
  if (kind === 'known_spend') {
    tokens = parseTokens(head.tokens, invalid, `${rules.noun} usage is invalid`)
    if (
      !['ok', 'error', 'aborted'].includes(head.outcome as string) ||
      !amount(head.credits) ||
      !PAID.includes(head.creditSource as string)
    )
      invalid(`known ${rules.noun} terminal is invalid`)
  }
  const success = kind === 'known_spend' && head.outcome === 'ok'
  const label = success
    ? 'successful'
    : kind === 'known_spend'
      ? 'failed'
      : kind === 'no_spend'
        ? 'no-spend'
        : 'unknown-spend'
  const rule =
    !success && typeof head.reason === 'string' && Object.hasOwn(rules.reasons, head.reason)
      ? rules.reasons[head.reason]
      : undefined
  if (
    (!success && (!rule?.kinds.includes(kind) || !rule.outcomes.includes(head.outcome as string))) ||
    head.interrupted !== !(success || rule?.completed)
  )
    invalid(`${label} ${rules.noun} terminal is invalid`)
  const { required, optional } = rules.fields(kind, rule)
  if (
    !rules.exactHead &&
    (!ownData(value, HEAD, [...required, ...optional]) || required.some((key) => head[key] === undefined))
  )
    invalid(`${label} ${rules.noun} terminal is invalid`)
  if (kind === 'unknown_spend' && required.includes('tokens'))
    tokens = parseTokens(head.tokens, invalid, `${rules.noun} usage is invalid`)
  const terminal: Record<string, unknown> = {
    kind,
    outcome: head.outcome,
    purpose,
    model,
    interrupted: head.interrupted,
  }
  for (const key of FIELD_ORDER) {
    if (!required.includes(key) && (!optional.includes(key) || head[key] === undefined)) continue
    const checked = key === 'tokens' ? tokens : field(key, head[key], kind, rule, rules)
    if (checked === undefined) invalid(`${label} ${rules.noun} terminal is invalid`)
    terminal[key] = checked
  }
  return Object.freeze(terminal) as AuxiliaryVisionEffectTerminal | SideCallEffectTerminal
}

/**
 * Checks one effect's settlement batch against the order its purpose commits: media writes the
 * settlement, its terminal and then any known cost; a side call writes cost, settlement and terminal,
 * always all three. Every row must belong to `effectId` and nothing else may be in the batch.
 */
export function checkSettlementOrder(
  purpose: LedgerPurpose,
  rows: readonly Readonly<{ type: string; data?: unknown }>[],
  effectId: string,
  kind: TerminalKind,
): void {
  const rules: TerminalRules = RULES[purpose]
  const order = rules.order(kind)
  if (
    rows.length !== order.length ||
    rows.some((row, index) => row.type !== order[index] || effectIdOf(row.data) !== effectId)
  )
    rules.invalid(`${rules.noun} settlement rows are out of order`)
}

/** A durable media cost row must repeat its known-spend terminal exactly, in the original seven keys. */
export function checkMediaCost(
  data: unknown,
  effectId: string,
  terminal: Extract<AuxiliaryVisionEffectTerminal, { kind: 'known_spend' }>,
): void {
  const invalid: Invalid = RULES.media.invalid
  const record = exactOwn(data, RULES.media.costKeys.required)
  const tokens = record ? parseTokens(record.tokens, invalid, 'auxiliary effect usage is invalid') : undefined
  if (
    record?.purpose !== 'media' ||
    record.effectId !== effectId ||
    record.credits !== terminal.credits ||
    record.creditSource !== terminal.creditSource ||
    record.model !== terminal.model ||
    record.interrupted !== terminal.interrupted ||
    canonicalJson(tokens) !== canonicalJson(terminal.tokens)
  )
    invalid('durable auxiliary cost is invalid')
}

const ZERO_TOKENS: TokenCounts = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

/**
 * Checks what a side call's cost row must satisfy however the call ended: Core's authority on the
 * call's lane, only cost-row keys, and the call's own purpose, effect, model and route. A route is
 * optional, but when present it is the bound one. Returns the row's fields with parsed tokens.
 */
export function checkSideCallCost(
  cost: EventInput,
  binding: Readonly<{ effectId: string; lane: string; route: string; model: string }>,
): Snapshot {
  const fail: Invalid = RULES['side-call'].invalid
  const { required, optional } = RULES['side-call'].costKeys
  const spent = ownData(cost.data, required, optional)
  if (
    cost.type !== COST_EVENT ||
    !trusted(cost) ||
    cost.lane !== binding.lane ||
    spent?.purpose !== 'side-call' ||
    spent.effectId !== binding.effectId ||
    spent.model !== binding.model ||
    (spent.route !== undefined && spent.route !== binding.route) ||
    (spent.credits !== undefined && !amount(spent.credits))
  )
    fail('side-call cost row does not belong to its call')
  return Object.freeze({
    ...spent,
    tokens: parseTokens(spent.tokens, fail, 'side-call effect usage is invalid'),
  })
}

/**
 * Checks a side call's settlement batch, written or read back: cost, settlement and terminal rows
 * of the bound effect, in that order, with Core's authority, a terminal bound to `bindingHash`, a
 * settlement with the terminal's outcome and code, and a cost row that repeats the terminal's spend
 * (zero for no spend). Returns the terminal.
 */
export function checkSideCallSettlement(
  rows: readonly EventInput[],
  binding: Readonly<{ effectId: string; lane: string; route: string; model: string }>,
  bindingHash: string,
): SideCallEffectTerminal {
  const fail: Invalid = RULES['side-call'].invalid
  const terminalRow = rows.find((row) => row.type === RULES['side-call'].event)
  const data = exactOwn(terminalRow?.data, ['version', 'effectId', 'bindingHash', 'terminal', 'terminalHash'])
  if (!terminalRow || data?.version !== 1 || data.bindingHash !== bindingHash)
    fail('side-call terminal binding is invalid')
  const terminal = snapshotTerminal('side-call', data.terminal, binding.model, fail)
  checkSettlementOrder('side-call', rows, binding.effectId, terminal.kind)
  if (rows.some((row) => !trusted(row) || row.lane !== binding.lane) || terminalRow.ignorable !== true)
    fail('side-call settlement rows lack Core authority')
  if (data.terminalHash !== sha256Hex(canonicalJson(terminal))) fail('side-call terminal hash is invalid')
  const [cost, settled] = rows as [EventInput, EventInput]
  const settlement = ownData(settled.data, ['effectId', 'outcome'], ['code', 'durationMs'])
  if (
    settlement?.outcome !== terminal.outcome ||
    settlement.code !== ('code' in terminal ? terminal.code : undefined) ||
    (settlement.durationMs !== undefined && !count(settlement.durationMs))
  )
    fail('side-call settlement does not match its terminal')
  const spend =
    terminal.kind === 'no_spend'
      ? { tokens: ZERO_TOKENS, credits: 0, creditSource: 'estimated', billing: undefined }
      : {
          tokens: terminal.tokens,
          credits: terminal.credits,
          creditSource: terminal.creditSource,
          billing: terminal.kind === 'known_spend' ? terminal.billing : undefined,
        }
  const spent = checkSideCallCost(cost, binding)
  if (
    canonicalJson(spent.tokens) !== canonicalJson(spend.tokens) ||
    spent.credits !== spend.credits ||
    spent.creditSource !== spend.creditSource ||
    (spent.billing === undefined) !== (spend.billing === undefined) ||
    (spent.billing !== undefined && canonicalJson(spent.billing) !== canonicalJson(spend.billing)) ||
    (spent.interrupted !== undefined && spent.interrupted !== true) ||
    (spent.interrupted === true) !== terminal.interrupted
  )
    fail('side-call cost row does not match its terminal')
  return terminal
}

function usage(terminal: SideCallEffectTerminal): SideCallUsage | undefined {
  if (terminal.kind === 'no_spend')
    return Object.freeze({ tokens: ZERO_TOKENS, credits: 0, creditSource: 'estimated' })
  if (terminal.credits === undefined) return undefined
  return Object.freeze({
    tokens: terminal.tokens,
    credits: terminal.credits,
    creditSource: terminal.creditSource,
    ...(terminal.kind === 'known_spend' && terminal.billing ? { billing: terminal.billing } : {}),
    ...(terminal.timing ? { timing: terminal.timing } : {}),
  })
}

/**
 * The result a loop sees for a recorded terminal. `replayed` says whether it is being read back from
 * an earlier call. A no-spend terminal reports zero usage, matching its zero cost row; an estimate
 * without credits (no catalog price) reports no usage.
 */
export function sideCallResult(
  terminal: SideCallEffectTerminal,
  context: Readonly<{ invocationId: string; output: 'text' | 'json'; replayed: boolean }>,
): SideCallResult {
  const { invocationId, replayed } = context
  if (terminal.kind === 'known_spend' && terminal.outcome === 'ok')
    return Object.freeze({
      status: 'ok',
      invocationId,
      text: terminal.text,
      ...(context.output === 'json' ? { json: JSON.parse(terminal.text) as JsonValue } : {}),
      usage: usage(terminal) as SideCallUsage,
      latencyMs: terminal.latencyMs,
      ...(terminal.response ? { response: terminal.response } : {}),
      replayed,
    })
  const failure = RULES['side-call'].reasons[terminal.reason]?.failure as SideCallFailure
  const spent = usage(terminal)
  return Object.freeze({
    status: 'failed',
    invocationId,
    reason: failure,
    ...(terminal.code === undefined ? {} : { code: terminal.code }),
    retryable: terminal.retryable ?? failure === 'deadline',
    ...(terminal.retryAfterMs === undefined ? {} : { retryAfterMs: terminal.retryAfterMs }),
    dispatch: terminal.kind === 'no_spend' ? 'not-sent' : 'may-have-sent',
    ...(spent ? { usage: spent } : {}),
    latencyMs: terminal.latencyMs,
    replayed,
  })
}
