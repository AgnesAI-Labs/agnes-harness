import type { OpStateObj } from '@agnes/core-common/step/op-state'
import { CoreError, type EventInput, type Seq } from '@agnes/core-common/types'
import { SCAN_PAGE_MAX } from '@agnes/core-ledger/log/storage'
import type { Actor } from '@agnes/protocol'
import {
  budgetOverrideEvent,
  type EnqueueMsg,
  INBOX_BUDGET_EVENT,
  type InboxBudgetOverride,
  TURN_BUDGET_EVENT,
} from './inbox.js'
import type { SessionImpl, TurnMemory } from './session.js'
import {
  INBOX_TIME_LIMIT_EVENT,
  inboxTimeLimit,
  rehydrateTimeLimit,
  setTurnTimeLimit,
  TURN_TIME_LIMIT_EVENT,
  type TurnTimeLimit,
  timeLimitEvent,
  validTimeLimit,
} from './time-limit.js'

/**
 * A prompt's own cap on model steps. It travels as two rows of its own, never as a field on the
 * budget rows: those are `x/core` types whose validators insist on `creditsCap`, and an older core
 * reading this ledger skips an `ignorable` row of a type it does not know but would reject a
 * changed one. An older core therefore runs the turn without the cap rather than failing to open.
 */
export const INBOX_STEP_CAP_EVENT = 'x/core/inbox-step-cap'
export const TURN_STEP_CAP_EVENT = 'x/core/turn-step-cap'
export const STEP_CAP_MAX = 1000

export const validStepCap = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= STEP_CAP_MAX

export function stepCapEvent(
  type: typeof INBOX_STEP_CAP_EVENT | typeof TURN_STEP_CAP_EVENT,
  actor: Actor,
  data: { itemId: string; maxSteps: number } | { turn: number; maxSteps: number },
): EventInput {
  return { type, origin: 'system', trust: 'trusted', actor, data, ignorable: true }
}

/** The cap only lowers the preset's ceiling; `null` is no ceiling at all. */
export function effectiveMaxSteps(preset: number | null, cap: number | undefined): number | null {
  return cap === undefined ? preset : preset === null ? cap : Math.min(preset, cap)
}

type Row = { itemId?: unknown; turn?: unknown; maxSteps?: unknown }

async function readCap(
  s: SessionImpl,
  type: string,
  range: { fromSeq: Seq } | undefined,
  matches: (row: Row) => boolean,
): Promise<number | undefined> {
  let toSeq: Seq | undefined
  for (;;) {
    const rows = await s.d.log.scan({
      type,
      order: 'desc',
      limit: SCAN_PAGE_MAX,
      ...(range ?? {}),
      ...(toSeq === undefined ? {} : { toSeq }),
    })
    for (const event of rows) {
      const data = (event.data ?? {}) as Row
      if (!matches(data)) continue
      if (!validStepCap(data.maxSteps))
        throw new CoreError('E_ENVELOPE', 'stored per-turn step cap is invalid')
      return data.maxSteps
    }
    const oldest = rows.at(-1)
    if (rows.length < SCAN_PAGE_MAX || !oldest || oldest.seq <= 1) return undefined
    toSeq = (oldest.seq - 1) as Seq
  }
}

export const inboxStepCap = (s: SessionImpl, itemId: string) =>
  readCap(s, INBOX_STEP_CAP_EVENT, undefined, (r) => r.itemId === itemId)

/** Recovery: reads the open turn's cap back off its own row. */
export const rehydratedStepCap = (s: SessionImpl, op: OpStateObj) =>
  readCap(s, TURN_STEP_CAP_EVENT, { fromSeq: op.meta.triggerSeq }, (r) => r.turn === op.meta.turn)

/** The step cap and time limit a queued item carries for the turn it opens. */
export async function inboxTurnCaps(s: SessionImpl, itemId: string) {
  return { stepCap: await inboxStepCap(s, itemId), timeLimit: await inboxTimeLimit(s, itemId) }
}

export function applyTurnCaps(turn: TurnMemory, stepCap: number | undefined, timeLimit?: TurnTimeLimit) {
  if (stepCap !== undefined) turn.maxStepsCap = stepCap
  setTurnTimeLimit(turn, timeLimit)
}

/** Recovery: both caps come back off the open turn's own rows. */
export async function rehydrateTurnCaps(s: SessionImpl, op: OpStateObj, turn: TurnMemory): Promise<void> {
  applyTurnCaps(turn, await rehydratedStepCap(s, op))
  await rehydrateTimeLimit(s, op, turn)
}

/** Ceiling for the open turn: the preset's, lowered by the prompt's own cap. `null` is none. */
export function turnMaxSteps(s: SessionImpl): number | null {
  if (!s.op()) return s.preset.budget.maxSteps
  if (!s.turn) throw new CoreError('E_RELATION', 'open turn step cap has not been rehydrated')
  return effectiveMaxSteps(s.preset.budget.maxSteps, s.turn.maxStepsCap)
}

/** What a queued input may carry for the one turn it opens; refused before the inbox changes. */
export function validateTurnOverrides(
  msg: Pick<EnqueueMsg, 'budget' | 'hardBudget' | 'maxSteps' | 'timeLimitMs'>,
  target: string,
): void {
  if (msg.hardBudget !== undefined && (msg.hardBudget !== true || msg.budget === undefined))
    throw new CoreError('E_ENVELOPE', 'hard budget requires a credit ceiling')
  if (msg.budget !== undefined) {
    if (target !== 'next-turn')
      throw new CoreError('E_ENVELOPE', 'a per-turn budget override requires next-turn input')
    if (!Number.isFinite(msg.budget) || msg.budget < 0)
      throw new CoreError('E_ENVELOPE', 'a per-turn budget override must be a finite non-negative number')
  }
  if (msg.maxSteps !== undefined) {
    if (target !== 'next-turn')
      throw new CoreError('E_ENVELOPE', 'a per-turn step cap requires next-turn input')
    if (!validStepCap(msg.maxSteps))
      throw new CoreError('E_ENVELOPE', 'a per-turn step cap must be an integer from 1 to 1000')
  }
  if (msg.timeLimitMs !== undefined) {
    if (target !== 'next-turn')
      throw new CoreError('E_ENVELOPE', 'a per-turn time limit requires next-turn input')
    if (!validTimeLimit(msg.timeLimitMs))
      throw new CoreError('E_ENVELOPE', 'a per-turn time limit must be an integer number of ms up to one day')
  }
}

/** `now` is when the item is queued: a time limit's deadline is counted from there, as the client's is. */
export function inboxOverrideEvents(
  actor: Actor,
  itemId: string,
  msg: Pick<EnqueueMsg, 'budget' | 'hardBudget' | 'maxSteps' | 'timeLimitMs'>,
  now: number,
): EventInput[] {
  return [
    ...(msg.budget === undefined
      ? []
      : [
          budgetOverrideEvent(INBOX_BUDGET_EVENT, actor, {
            itemId,
            creditsCap: msg.budget,
            ...(msg.hardBudget ? { hard: true as const } : {}),
          }),
        ]),
    ...(msg.maxSteps === undefined
      ? []
      : [stepCapEvent(INBOX_STEP_CAP_EVENT, actor, { itemId, maxSteps: msg.maxSteps })]),
    ...(msg.timeLimitMs === undefined
      ? []
      : [
          timeLimitEvent(INBOX_TIME_LIMIT_EVENT, actor, {
            itemId,
            timeLimitMs: msg.timeLimitMs,
            deadlineAt: now + msg.timeLimitMs,
          }),
        ]),
  ]
}

export function turnOverrideEvents(
  actor: Actor,
  turn: number,
  budget: InboxBudgetOverride | undefined,
  stepCap: number | undefined,
  timeLimit?: TurnTimeLimit,
): EventInput[] {
  return [
    ...(budget === undefined ? [] : [budgetOverrideEvent(TURN_BUDGET_EVENT, actor, { turn, ...budget })]),
    ...(stepCap === undefined ? [] : [stepCapEvent(TURN_STEP_CAP_EVENT, actor, { turn, maxSteps: stepCap })]),
    ...(timeLimit === undefined
      ? []
      : [timeLimitEvent(TURN_TIME_LIMIT_EVENT, actor, { turn, ...timeLimit })]),
  ]
}
