import { types as utilTypes } from 'node:util'
import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import { CoreError, type Event, type EventInput, type Seq } from '@agnes/core-common/types'
import { scanAll } from '@agnes/core-ledger/log/scan-pages'
import type { SideCallStatus } from '@agnes/extension-api'
import { AI_ERROR_CODES, type AiErrorCode } from '@agnes/protocol'
import { sessionIdentity } from '../loop/scope.js'
import type { SessionImpl } from '../step/session.js'
import type {
  AuxiliaryVisionEffectBinding,
  AuxiliaryVisionEffectPort,
  AuxiliaryVisionEffectTerminal,
  AuxiliaryVisionFinishedEffect,
} from './auxiliary-vision-executor.js'
import {
  amount,
  bounded,
  checkMediaCost,
  checkSettlementOrder,
  checkSideCallCost,
  checkSideCallSettlement,
  count,
  effectIdOf,
  exactOwn,
  type Invalid,
  type LedgerPurpose,
  ownData,
  type SideCallEffectTerminal,
  sideCallResult,
  snapshotTerminal,
  type TerminalSide,
  terminalSide,
  trusted,
} from './side-call-terminal.js'

const INTENT_EVENT = 'effect/intent'
const SETTLED_EVENT = 'effect/settled'
const COST_EVENT = 'cost/ledger'
const LATE_RECEIPT_EVENT = 'x/core/late-effect-receipt'
const SIDE_CALL_PREFIX = 'side:'
const HASH = /^[0-9a-f]{64}$/u
const EFFECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u
const SENSITIVE = /(?:authorization|bearer|credential|secret|password|api[_-]?key|token|sk-[A-Za-z0-9])/iu
const LABEL = /^[a-z][a-z0-9._-]{0,63}$/u
const HOST = /^[^\s/\\@?#]+$/u

/** The deadline range a side call may record; Core's own timer races it. */
export const SIDE_CALL_DEADLINE_MS = Object.freeze({ min: 100, max: 120_000 })

/**
 * The intent side of a purpose: the effect kind, the binding row that follows the intent, and the
 * binding's exact keys. Its terminal side (terminal row, shapes, cost row and commit order) is in
 * `side-call-terminal.ts`. Media keeps the rows auxiliary vision has always written; a side call
 * names its subject digest `subjectHash`, binds its route, and adds an audit record.
 */
type PurposeRow = Readonly<{
  kind: LedgerPurpose
  intentEvent: string
  effectPrefix: string
  bindingKeys: readonly string[]
  terminal: TerminalSide
}>

const bindingKeys = (subject: string, route: readonly string[]) => [
  'effectId',
  'sessionKey',
  'lane',
  'auditBindingHash',
  'budgetBindingHash',
  subject,
  'requestDerivedHash',
  ...route,
  'model',
]

const PURPOSES: Readonly<Record<LedgerPurpose, PurposeRow>> = {
  media: {
    kind: 'media',
    intentEvent: 'x/core/auxiliary-vision-intent',
    effectPrefix: '',
    bindingKeys: bindingKeys('mediaManifestHash', []),
    terminal: terminalSide('media'),
  },
  'side-call': {
    kind: 'side-call',
    intentEvent: 'x/core/side-call-intent',
    effectPrefix: SIDE_CALL_PREFIX,
    bindingKeys: bindingKeys('subjectHash', ['route']),
    terminal: terminalSide('side-call'),
  },
}
const MEDIA: PurposeRow = PURPOSES.media
const SIDE_CALL: PurposeRow = PURPOSES['side-call']
const invalid: Invalid = MEDIA.terminal.invalid
const relation = (message: string, effectId?: unknown) =>
  new CoreError('E_RELATION', message, typeof effectId === 'string' ? { effectId } : undefined)

/** Identity of one side call. Digests only: no request content is ever written to the ledger. */
export type SideCallEffectBinding = Readonly<{
  effectId: string
  sessionKey: string
  lane: string
  /** The prepared call's request hash; `status` reports it back as `requestHash`. */
  auditBindingHash: string
  budgetBindingHash: string
  /** SHA-256 of the canonical system prompt, messages, payload and sampling. */
  subjectHash: string
  requestDerivedHash: string
  route: string
  model: string
}>

/** What a side call records for audit beside its identity; it takes no part in identity checks. */
export type SideCallEffectAudit = Readonly<{
  label: string
  adapter: Readonly<{ id: string; version: string | null }> | null
  api: string | null
  endpointHost: string | null
  deadlineMs: number
  output: 'text' | 'json'
  inputTokens: number
  estimateSource: 'provider' | 'estimate'
  projectedCredits: number | null
  payloadBytes: number | null
}>

const AUDIT_KEYS = [
  'label',
  'adapter',
  'api',
  'endpointHost',
  'deadlineMs',
  'output',
  'inputTokens',
  'estimateSource',
  'projectedCredits',
  'payloadBytes',
]

/** The effect id a side call's invocation id is recorded under. */
export const sideCallEffectId = (invocationId: string): string => `${SIDE_CALL_PREFIX}${invocationId}`

function snapshotBinding(purpose: 'media', value: unknown): AuxiliaryVisionEffectBinding
function snapshotBinding(purpose: 'side-call', value: unknown): SideCallEffectBinding
function snapshotBinding(purpose: LedgerPurpose, value: unknown) {
  const row: PurposeRow = PURPOSES[purpose]
  const record = exactOwn(value, row.bindingKeys)
  if (
    !record ||
    typeof record.effectId !== 'string' ||
    !EFFECT_ID.test(record.effectId) ||
    SENSITIVE.test(record.effectId) ||
    !record.effectId.startsWith(row.effectPrefix) ||
    !bounded(record.sessionKey, 512) ||
    !bounded(record.lane, 64) ||
    !bounded(record.model, 256) ||
    (row.bindingKeys.includes('route') && !bounded(record.route, 128)) ||
    row.bindingKeys.some(
      (key) => key.endsWith('Hash') && (typeof record[key] !== 'string' || !HASH.test(record[key])),
    )
  )
    row.terminal.invalid(`${row.terminal.noun} binding is invalid`)
  return Object.freeze(Object.fromEntries(row.bindingKeys.map((key) => [key, record[key]])))
}

function snapshotAudit(value: unknown): SideCallEffectAudit {
  const record = exactOwn(value, AUDIT_KEYS)
  const adapter = record?.adapter === null ? null : exactOwn(record?.adapter, ['id', 'version'])
  if (
    !record ||
    typeof record.label !== 'string' ||
    !LABEL.test(record.label) ||
    (adapter !== null &&
      (!adapter ||
        !bounded(adapter.id, 128) ||
        (adapter.version !== null && !bounded(adapter.version, 64)))) ||
    (record.api !== null && !bounded(record.api, 128)) ||
    (record.endpointHost !== null &&
      (!bounded(record.endpointHost, 253) || !HOST.test(record.endpointHost))) ||
    !count(record.deadlineMs) ||
    record.deadlineMs < SIDE_CALL_DEADLINE_MS.min ||
    record.deadlineMs > SIDE_CALL_DEADLINE_MS.max ||
    (record.output !== 'text' && record.output !== 'json') ||
    !count(record.inputTokens) ||
    (record.estimateSource !== 'provider' && record.estimateSource !== 'estimate') ||
    (record.projectedCredits !== null && !amount(record.projectedCredits)) ||
    (record.payloadBytes !== null && !count(record.payloadBytes))
  )
    SIDE_CALL.terminal.invalid('side-call effect audit is invalid')
  return Object.freeze({
    label: record.label,
    adapter:
      adapter && Object.freeze({ id: adapter.id as string, version: adapter.version as string | null }),
    api: record.api as string | null,
    endpointHost: record.endpointHost as string | null,
    deadlineMs: record.deadlineMs,
    output: record.output,
    inputTokens: record.inputTokens,
    estimateSource: record.estimateSource,
    projectedCredits: record.projectedCredits as number | null,
    payloadBytes: record.payloadBytes as number | null,
  })
}

const bindingHashOf = (binding: object) => sha256Hex(canonicalJson(binding))
const belongs = (session: SessionImpl, binding: Readonly<{ sessionKey: string; lane: string }>) =>
  binding.sessionKey === session.key && binding.lane === session.lane

function intentEvents(
  session: SessionImpl,
  purpose: LedgerPurpose,
  binding: AuxiliaryVisionEffectBinding | SideCallEffectBinding,
  audit?: SideCallEffectAudit,
): EventInput[] {
  const row = PURPOSES[purpose]
  const bindingHash = bindingHashOf(binding)
  return [
    session.ev(INTENT_EVENT, { effectId: binding.effectId, kind: row.kind, replay: 'never' }),
    session.ev(
      row.intentEvent,
      audit ? { version: 1, binding, bindingHash, audit } : { version: 1, binding, bindingHash },
      { ignorable: true },
    ),
  ]
}

function terminalEvent(
  session: SessionImpl,
  purpose: LedgerPurpose,
  binding: AuxiliaryVisionEffectBinding | SideCallEffectBinding,
  terminal: AuxiliaryVisionEffectTerminal | SideCallEffectTerminal,
): EventInput {
  return session.ev(
    PURPOSES[purpose].terminal.event,
    {
      version: 1,
      effectId: binding.effectId,
      bindingHash: bindingHashOf(binding),
      terminal,
      terminalHash: sha256Hex(canonicalJson(terminal)),
    },
    { ignorable: true },
  )
}

// Auxiliary vision: begin and finish rescan the lane for the effect, as they always have.

function eventData(event: Event): Readonly<Record<string, unknown>> | undefined {
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
    if (!trusted(event)) invalid('durable auxiliary event authority is invalid')
    if ((event.type === MEDIA.intentEvent || event.type === MEDIA.terminal.event) && event.ignorable !== true)
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
  const binding = snapshotBinding('media', data.binding)
  if (data.bindingHash !== bindingHashOf(binding)) invalid('durable auxiliary intent hash is invalid')
  return { binding, bindingHash: data.bindingHash }
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

type MediaState =
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'in_progress' }>
  | AuxiliaryVisionFinishedEffect

async function inspect(session: SessionImpl, expected: AuxiliaryVisionEffectBinding): Promise<MediaState> {
  const toSeq = session.lastSeq
  const events = await scanAll((q) => session.scan(q), {
    toSeq,
    lane: session.lane,
    type: [INTENT_EVENT, MEDIA.intentEvent, SETTLED_EVENT, MEDIA.terminal.event, COST_EVENT],
  })
  requireTrustedEvents(events)
  const intents = matching(events, INTENT_EVENT, expected.effectId)
  const bindings = events.filter((event) => {
    if (event.type !== MEDIA.intentEvent) return false
    return parseIntentRecord(event).binding.effectId === expected.effectId
  })
  const settlements = matching(events, SETTLED_EVENT, expected.effectId)
  const terminals = matching(events, MEDIA.terminal.event, expected.effectId)
  const costs = matching(events, COST_EVENT, expected.effectId)
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
    intentData.kind !== MEDIA.kind ||
    intentData.replay !== 'never' ||
    (bindings[0] as Event).seq !== (intents[0] as Event).seq + 1
  )
    invalid('durable auxiliary lifecycle intent is invalid')
  const durable = parseIntentRecord(bindings[0] as Event)
  if (canonicalJson(durable.binding) !== canonicalJson(expected))
    invalid('auxiliary effect identity collision')
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
  const terminalRow = terminals[0] as Event
  const terminalData = exactOwn(terminalRow.data, [
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
  const terminal = snapshotTerminal('media', terminalData.terminal, expected.model, invalid)
  const settlementData = exactOwn(settlementEvent.data, ['effectId', 'outcome'])
  if (
    settlementData?.effectId !== expected.effectId ||
    settlementData.outcome !== terminal.outcome ||
    terminalRow.seq !== settlementEvent.seq + 1
  )
    invalid('durable auxiliary settlement outcome is invalid')
  if (terminalData.terminalHash !== sha256Hex(canonicalJson(terminal)))
    invalid('durable auxiliary terminal hash is invalid')
  if (terminal.kind === 'known_spend') {
    if (costs.length !== 1) invalid('known auxiliary spend lacks one cost row')
    const cost = costs[0] as Event
    checkMediaCost(cost.data, expected.effectId, terminal)
    if (cost.seq !== terminalRow.seq + 1) invalid('durable auxiliary terminal transaction is not contiguous')
    return finishedReceipt(terminal, expected, settlementEvent.seq, cost.seq)
  }
  if (costs.length !== 0) invalid('no-cost auxiliary terminal transaction is invalid')
  return finishedReceipt(terminal, expected, settlementEvent.seq)
}

function mediaTerminalEvents(
  session: SessionImpl,
  binding: AuxiliaryVisionEffectBinding,
  terminal: AuxiliaryVisionEffectTerminal,
): EventInput[] {
  const cost =
    terminal.kind === 'known_spend'
      ? [
          session.ev(COST_EVENT, {
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
    session.ev(SETTLED_EVENT, { effectId: binding.effectId, outcome: terminal.outcome }),
    terminalEvent(session, 'media', binding, terminal),
    ...cost,
  ]
}

/**
 * The auxiliary vision effect port. Intent and terminal transactions are serialized with all other
 * session writes; recovery never admits a second dispatch for an in-progress or durably terminal
 * effect.
 */
export function createMediaEffectPort(session: SessionImpl): AuxiliaryVisionEffectPort {
  return Object.freeze({
    async begin(value: AuxiliaryVisionEffectBinding) {
      const binding = snapshotBinding('media', value)
      if (binding.sessionKey !== session.key || binding.lane !== session.lane)
        invalid('auxiliary effect does not belong to this session lane')
      return session.locked(async () => {
        const prior = await inspect(session, binding)
        if (prior.status !== 'absent') return prior
        const committed = await session.append(intentEvents(session, 'media', binding))
        const intentSeq = committed.seqs[0]
        if (intentSeq === undefined) invalid('auxiliary effect intent sequence is missing')
        return Object.freeze({ status: 'admitted', intentSeq })
      })
    },
    async finish(value: AuxiliaryVisionEffectBinding, terminalValue: AuxiliaryVisionEffectTerminal) {
      const binding = snapshotBinding('media', value)
      if (binding.sessionKey !== session.key || binding.lane !== session.lane)
        invalid('auxiliary effect does not belong to this session lane')
      const terminal = snapshotTerminal('media', terminalValue, binding.model, invalid)
      return session.locked(async () => {
        const prior = await inspect(session, binding)
        if (prior.status === 'absent') invalid('auxiliary effect has no durable intent')
        if (prior.status === 'finished') {
          if (canonicalJson(prior.terminal) !== canonicalJson(terminal))
            invalid('auxiliary effect already has a different terminal')
          return prior
        }
        const rows = mediaTerminalEvents(session, binding, terminal)
        checkSettlementOrder('media', rows, binding.effectId, terminal.kind)
        const committed = await session.append(rows)
        const terminalSeq = committed.seqs[0]
        const costOriginSeq = terminal.kind === 'known_spend' ? committed.seqs[2] : undefined
        if (terminalSeq === undefined || (terminal.kind === 'known_spend' && costOriginSeq === undefined))
          invalid('auxiliary effect terminal sequence is missing')
        return finishedReceipt(terminal, binding, terminalSeq, costOriginSeq)
      })
    },
  })
}

// Side calls: one scan of the lane builds a per-context index; later reads go by sequence.

type DurableBinding = Readonly<{
  binding: SideCallEffectBinding
  audit: SideCallEffectAudit
  bindingHash: string
}>

async function loadSideCallBinding(
  session: SessionImpl,
  intentSeq: Seq,
  effectId: string,
): Promise<DurableBinding | undefined> {
  if (!count(intentSeq) || intentSeq < 1) return undefined
  const [intent, bound] = await session.scan({ fromSeq: intentSeq, toSeq: intentSeq + 1, limit: 2 })
  try {
    if (
      intent?.seq !== intentSeq ||
      bound?.seq !== intentSeq + 1 ||
      intent.type !== INTENT_EVENT ||
      bound.type !== SIDE_CALL.intentEvent ||
      !trusted(intent) ||
      !trusted(bound) ||
      bound.ignorable !== true
    )
      return undefined
    const intentData = exactOwn(intent.data, ['effectId', 'kind', 'replay'])
    const data = exactOwn(bound.data, ['version', 'binding', 'bindingHash', 'audit'])
    if (
      intentData?.effectId !== effectId ||
      intentData.kind !== SIDE_CALL.kind ||
      intentData.replay !== 'never' ||
      data?.version !== 1
    )
      return undefined
    const binding = snapshotBinding('side-call', data.binding)
    if (
      binding.effectId !== effectId ||
      !belongs(session, binding) ||
      intent.lane !== binding.lane ||
      bound.lane !== binding.lane ||
      data.bindingHash !== bindingHashOf(binding)
    )
      return undefined
    return Object.freeze({ binding, audit: snapshotAudit(data.audit), bindingHash: data.bindingHash })
  } catch {
    return undefined
  }
}

/**
 * The binding of a pending side-call effect, for recovery. It sits right after the intent row, and
 * is returned only when both rows carry Core's system authority, sit on the binding's lane, and the
 * binding names this session and lane and matches its stored hash; anything else is `undefined`,
 * never an exception.
 */
export async function readSideCallBinding(
  session: SessionImpl,
  intentSeq: Seq,
  effectId: string,
): Promise<Readonly<{ binding: SideCallEffectBinding; audit: SideCallEffectAudit }> | undefined> {
  const durable = await loadSideCallBinding(session, intentSeq, effectId)
  return durable && Object.freeze({ binding: durable.binding, audit: durable.audit })
}

type IndexEntry = {
  intentSeq?: Seq | undefined
  settledSeq?: Seq | undefined
  terminalSeq?: Seq | undefined
  receiptSeq?: Seq | undefined
  conflict?: true
  durable?: DurableBinding | undefined
}

/**
 * Adds the lane's side-call rows from `fromSeq` to the head, including late receipts that closed a
 * call's intent, and returns the last sequence scanned. A row already indexed at the same sequence
 * is not a conflict, so a range can be scanned again.
 */
async function indexRows(session: SessionImpl, entries: Map<string, IndexEntry>, fromSeq: Seq): Promise<Seq> {
  const toSeq = session.lastSeq
  if (fromSeq > toSeq) return toSeq
  const events = await scanAll((query) => session.scan(query), {
    lane: session.lane,
    fromSeq,
    toSeq,
    type: [SIDE_CALL.intentEvent, SETTLED_EVENT, SIDE_CALL.terminal.event, LATE_RECEIPT_EVENT],
  })
  const note = (
    effectId: unknown,
    field: 'intentSeq' | 'settledSeq' | 'terminalSeq' | 'receiptSeq',
    seq: Seq,
  ) => {
    if (typeof effectId !== 'string' || !effectId.startsWith(SIDE_CALL_PREFIX)) return
    const entry = entries.get(effectId) ?? {}
    if (entry[field] !== undefined && entry[field] !== seq) entry.conflict = true
    entry[field] = seq
    entries.set(effectId, entry)
  }
  for (const event of events) {
    if (!trusted(event)) continue
    const data = event.data as {
      effectId?: unknown
      binding?: { effectId?: unknown }
      version?: unknown
      effects?: unknown
    } | null
    if (event.type === SIDE_CALL.intentEvent) note(data?.binding?.effectId, 'intentSeq', event.seq - 1)
    else if (event.type === SETTLED_EVENT) note(data?.effectId, 'settledSeq', event.seq)
    else if (event.type === SIDE_CALL.terminal.event) note(data?.effectId, 'terminalSeq', event.seq)
    else if (data?.version === 1 && Array.isArray(data.effects))
      for (const effect of data.effects) {
        const effectId = (effect as { effectId?: unknown } | null)?.effectId
        const intentSeq = typeof effectId === 'string' ? entries.get(effectId)?.intentSeq : undefined
        // The reducer's rule: a receipt clears only the pending intent it names as a source.
        if (intentSeq !== undefined && event.sourceEventSeqs?.includes(intentSeq))
          note(effectId, 'receiptSeq', event.seq)
      }
  }
  return toSeq
}

const inFlight = (entry: IndexEntry) =>
  entry.settledSeq === undefined && entry.terminalSeq === undefined && entry.receiptSeq === undefined

export type SideCallEffectPort = Readonly<{
  /**
   * Commits the effect intent and its binding row in one append, without a phase transition, and
   * returns the intent sequence. Throws `E_ENVELOPE` for an invalid binding or audit and
   * `E_RELATION` when the effect id already has a record; nothing is written then.
   */
  begin(binding: SideCallEffectBinding, audit: SideCallEffectAudit): Promise<Seq>
  /** The terminal row for a validated terminal; it goes last in the settlement batch. */
  terminalRow(binding: SideCallEffectBinding, terminal: SideCallEffectTerminal): EventInput
  /**
   * Appends one settlement batch, cost then settlement then terminal, after checking every row
   * against the terminal, and returns the sequence numbers in order; it fits a model execution's
   * `write` option. Once the loop scope is revoked a scoped writer turns the batch into a late
   * receipt and throws `E_CLOSED`, so cost and settlement alone are accepted then, once both rows
   * are checked to be this call's own.
   */
  write(events: EventInput[]): Promise<readonly Seq[]>
  /** What the ledger holds for an invocation: absent, in flight, or finished with its result. */
  status(invocationId: string): Promise<SideCallStatus>
}>

/**
 * The side-call effect port of one loop context. Build it over the loop-scoped session so that a
 * revoked write becomes a late receipt. The lane is scanned once, on first use; after that a call
 * reads only the rows it needs by sequence, and this port's own writes keep the index current. A
 * call another context left in flight, such as one whose execution was revoked, is settled by a row
 * this port did not write, so `status` scans the rows added since its last scan before answering.
 */
export function createSideCallEffectPort(session: SessionImpl): SideCallEffectPort {
  const fail: Invalid = SIDE_CALL.terminal.invalid
  const own = new Set<string>()
  let indexedTo = 0 as Seq
  let indexing: Promise<Map<string, IndexEntry>> | undefined
  const index = () =>
    (indexing ??= session
      .locked(async () => {
        const entries = new Map<string, IndexEntry>()
        indexedTo = await indexRows(session, entries, ((session.d.log.parent?.boundarySeq ?? 0) + 1) as Seq)
        return entries
      })
      .catch((error: unknown) => {
        indexing = undefined
        throw error
      }))
  const catchUp = (entries: Map<string, IndexEntry>) =>
    session.locked(async () => {
      indexedTo = await indexRows(session, entries, (indexedTo + 1) as Seq)
    })
  const durable = async (entry: IndexEntry, effectId: string): Promise<DurableBinding> => {
    if (entry.conflict || entry.intentSeq === undefined)
      throw relation('side-call effect has an ambiguous durable record', effectId)
    entry.durable ??= await loadSideCallBinding(session, entry.intentSeq, effectId)
    if (!entry.durable) throw relation('side-call effect has no trusted binding row', effectId)
    return entry.durable
  }
  const readRow = async (seq: Seq) => (await session.scan({ fromSeq: seq, toSeq: seq, limit: 1 }))[0]

  async function finished(entry: IndexEntry, known: DurableBinding, invocationId: string) {
    const { intentSeq, settledSeq, terminalSeq, receiptSeq } = entry
    const effectId = known.binding.effectId
    if (receiptSeq !== undefined) {
      if (settledSeq !== undefined || terminalSeq !== undefined)
        throw relation('side-call effect was settled twice', effectId)
      // Revocation closed the call; no output was kept, so the loop sees a cancellation.
      const [intent, receipt] = [await readRow(intentSeq as Seq), await readRow(receiptSeq)]
      const latencyMs = Math.max(0, Date.parse(receipt?.ts ?? '') - Date.parse(intent?.ts ?? '')) || 0
      return Object.freeze({
        status: 'failed' as const,
        invocationId,
        reason: 'cancelled' as const,
        retryable: false,
        dispatch: 'may-have-sent' as const,
        latencyMs,
        replayed: true,
      })
    }
    if (terminalSeq === undefined) {
      // Only recovery settles a side call without its terminal row, and always as unknown.
      const settled = settledSeq === undefined ? undefined : await readRow(settledSeq)
      const data = ownData(settled?.data, ['effectId', 'outcome'], ['code', 'durationMs'])
      if (!settled || !trusted(settled) || data?.effectId !== effectId || data.outcome !== 'unknown')
        throw relation('side-call settlement has no terminal row', effectId)
      return Object.freeze({
        status: 'unknown' as const,
        invocationId,
        reason: 'interrupted' as const,
        replayed: true,
      })
    }
    const rows =
      settledSeq === undefined || terminalSeq !== settledSeq + 1
        ? []
        : await session.scan({ fromSeq: settledSeq - 1, toSeq: terminalSeq, limit: 3 })
    if (rows.length !== 3 || rows.some((row, offset) => row.seq !== (settledSeq as Seq) - 1 + offset))
      throw relation('side-call terminal transaction is not contiguous', effectId)
    const terminal = checkSideCallSettlement(rows, known.binding, known.bindingHash)
    return sideCallResult(terminal, { invocationId, output: known.audit.output, replayed: true })
  }

  return Object.freeze({
    async begin(value: SideCallEffectBinding, auditValue: SideCallEffectAudit) {
      const binding = snapshotBinding('side-call', value)
      const audit = snapshotAudit(auditValue)
      if (!belongs(session, binding)) fail('side-call effect does not belong to this session lane')
      const entries = await index()
      return session.locked(async () => {
        if (entries.has(binding.effectId))
          throw relation('side-call effect already has a durable record', binding.effectId)
        const committed = await session.append(intentEvents(session, 'side-call', binding, audit))
        const intentSeq = committed.seqs[0]
        if (intentSeq === undefined) throw relation('side-call intent sequence is missing', binding.effectId)
        const durable = Object.freeze({ binding, audit, bindingHash: bindingHashOf(binding) })
        entries.set(binding.effectId, { intentSeq, durable })
        own.add(binding.effectId)
        return intentSeq
      })
    },
    terminalRow(value: SideCallEffectBinding, terminalValue: SideCallEffectTerminal) {
      const binding = snapshotBinding('side-call', value)
      const terminal = snapshotTerminal('side-call', terminalValue, binding.model, fail)
      return terminalEvent(session, 'side-call', binding, terminal)
    },
    async write(events: EventInput[]) {
      const entries = await index()
      return session.locked(async () => {
        const settlements = events.filter((row) => row.type === SETTLED_EVENT)
        const effectId = settlements.length === 1 ? effectIdOf(settlements[0]?.data) : undefined
        const entry = typeof effectId === 'string' ? entries.get(effectId) : undefined
        if (!entry || !inFlight(entry))
          throw relation('side-call settlement has no in-flight intent', effectId)
        const known = await durable(entry, effectId as string)
        // Once the scope is revoked a scoped writer keeps only the cost row, adds a late receipt and
        // throws; a model execution settling on revocation sends cost and settlement alone.
        const receipt = !session.loopScope.alive && sessionIdentity(session) !== session
        if (receipt && events.length === 2) {
          checkSideCallCost(events[0] as EventInput, known.binding)
          const settled = events[1] as EventInput
          const data = ownData(settled.data, ['effectId', 'outcome'], ['code', 'durationMs'])
          if (
            settled.type !== SETTLED_EVENT ||
            !trusted(settled) ||
            settled.lane !== known.binding.lane ||
            !data ||
            data.effectId !== effectId ||
            !['ok', 'error', 'aborted'].includes(data.outcome as string) ||
            (data.code !== undefined && !AI_ERROR_CODES.includes(data.code as AiErrorCode)) ||
            (data.durationMs !== undefined && !count(data.durationMs))
          )
            fail('side-call settlement does not belong to its call')
        } else checkSideCallSettlement(events, known.binding, known.bindingHash)
        const committed = await session.append(events)
        entry.settledSeq = committed.seqs[1]
        entry.terminalSeq = committed.seqs[2]
        own.delete(effectId as string)
        return committed.seqs
      })
    },
    async status(invocationId: string): Promise<SideCallStatus> {
      const effectId = sideCallEffectId(invocationId)
      const entries = await index()
      const pending = entries.get(effectId)
      if (pending && inFlight(pending) && !own.has(effectId)) await catchUp(entries)
      const entry = entries.get(effectId)
      if (!entry) return Object.freeze({ status: 'absent', invocationId })
      const known = await durable(entry, effectId)
      if (inFlight(entry)) return Object.freeze({ status: 'in-flight', invocationId })
      return Object.freeze({
        status: 'finished',
        invocationId,
        label: known.audit.label,
        requestHash: known.binding.auditBindingHash,
        result: await finished(entry, known, invocationId),
      })
    },
  })
}
