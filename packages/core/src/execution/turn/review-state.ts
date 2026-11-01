import type { Event, EventInput, Seq } from '@agnes/core-common/types'
import type { SessionImpl } from '../../step/session.js'
import { turnTimeLimit } from '../../step/time-limit.js'
import { reviewHistory } from './review-history.js'

export const REVIEW_DIAGNOSTIC = 'completion_gate_contract_review'
export const REVIEW_ANCHOR = 'x/core/completion-review-anchor'
export const REVIEW_STOP = 'x/core/completion-review-stop'
export const REVIEW_MAX_ADMISSIONS = 3
export const REVIEW_DURATION_MS = 60_000
export type ReviewReason = 'requests' | 'deadline' | 'unavailable'
export type ReviewBudget = {
  version: 1
  maxInferenceAdmissions: 3
  startedAt: number
  deadlineAt: number
}
export type ReviewAnchor = { sessionKey: string; lane: string; ranSeq: Seq }
export type ReviewState =
  | { kind: 'none' }
  | { kind: 'legacy'; anchor: ReviewAnchor }
  | { kind: 'invalid'; anchor?: ReviewAnchor }
  | { kind: 'active'; anchor: ReviewAnchor; budget: ReviewBudget; used: number; stopped?: ReviewReason }

const trusted = (row: Event) => row.origin === 'system' && row.trust === 'trusted'
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

export function newReviewBudget(s: SessionImpl): ReviewBudget {
  const startedAt = s.d.clock()
  return {
    version: 1,
    maxInferenceAdmissions: REVIEW_MAX_ADMISSIONS,
    startedAt,
    deadlineAt: Math.min(startedAt + REVIEW_DURATION_MS, turnTimeLimit(s.turn)?.deadlineAt ?? Infinity),
  }
}

function validBudget(value: unknown): value is ReviewBudget {
  const b = record(value)
  return (
    !!b &&
    b.version === 1 &&
    b.maxInferenceAdmissions === REVIEW_MAX_ADMISSIONS &&
    positive(b.startedAt) &&
    positive(b.deadlineAt) &&
    b.deadlineAt > b.startedAt &&
    b.deadlineAt - b.startedAt <= REVIEW_DURATION_MS
  )
}

/** Reconstruct from facts, including failed and uncertain intents, never from request headers. */
export async function readReviewState(s: SessionImpl, turn = s.op()?.meta.turn): Promise<ReviewState> {
  if (turn === undefined) return { kind: 'none' }
  const group = await reviewHistory(s, turn)
  if (!group?.hasReview) return { kind: 'none' }
  const cached = parsed.get(group)?.get(turn)
  if (cached?.revision === group.revision) return cached.state
  const state = parseReviewState(s, turn, group.rows)
  let turns = parsed.get(group)
  if (!turns) {
    turns = new Map()
    parsed.set(group, turns)
  }
  turns.set(turn, { revision: group.revision, state })
  return state
}

const parsed = new WeakMap<object, Map<number, { revision: number; state: ReviewState }>>()
function parseReviewState(s: SessionImpl, turn: number, rows: Event[]): ReviewState {
  const starts = new Map<number, Event>()
  const owner = new Map<Seq, number>()
  let current: number | undefined
  const invalidTurns = new Set<number>()
  for (const row of rows) {
    if (row.type === 'turn/start') {
      const n = record(row.data)?.turn
      if (!positive(n) || starts.has(n) || !trusted(row)) {
        if (positive(n)) invalidTurns.add(n)
        continue
      }
      starts.set(n, row)
      current = n
    }
    if (current !== undefined) owner.set(row.seq, current)
  }
  const roots = new Map<number, number>()
  const root = (n: number, visiting = new Set<number>()): number | undefined => {
    const cached = roots.get(n)
    if (cached !== undefined) return cached
    const start = starts.get(n)
    if (!start || visiting.has(n)) {
      invalidTurns.add(n)
      return undefined
    }
    const data = record(start.data)!
    if (data.trigger !== 'approval-resume') {
      roots.set(n, n)
      return n
    }
    const previous = record(data.continues)
    const predecessor = positive(previous?.turn) ? starts.get(previous.turn) : undefined
    const call = rows.find(
      (row) =>
        row.type === 'tool/call' &&
        row.seq < start.seq &&
        record(row.data)?.toolUseId === previous?.toolUseId,
    )
    const callTurn = call && owner.get(call.seq)
    const ended =
      predecessor &&
      rows.find(
        (row) => row.type === 'turn/end' && owner.get(row.seq) === previous?.turn && row.seq < start.seq,
      )
    const decision =
      typeof previous?.requestId === 'string'
        ? s.state.registers.decisionStates.get(previous.requestId)?.value
        : undefined
    if (
      !predecessor ||
      predecessor.seq >= start.seq ||
      !positive(previous?.step) ||
      !call ||
      callTurn !== previous?.turn ||
      s.state.toolCalls.get(String(previous?.toolUseId))?.step !== previous?.step ||
      record(ended?.data)?.reason !== 'parked' ||
      !decision ||
      decision.request.sourcePackage !== '@agnes/core' ||
      decision.request.lane !== s.lane ||
      decision.request.operationId !== previous.toolUseId
    ) {
      invalidTurns.add(n)
    }
    if (!positive(previous?.turn)) return undefined
    visiting.add(n)
    const r = root(previous.turn as number, visiting)
    if (r !== undefined) roots.set(n, r)
    return r
  }
  const currentRoot = root(turn)
  // Resolve every continuation: siblings reopening the same parked call share its allowance too.
  for (const n of starts.keys()) root(n)
  const related = rows.filter((row) => roots.get(owner.get(row.seq) ?? -1) === currentRoot)
  const ran = related.filter(
    (row) =>
      row.type === 'x/core/completion-gate' &&
      trusted(row) &&
      record(row.data)?.diagnostic === REVIEW_DIAGNOSTIC &&
      record(row.data)?.status === 'ran',
  )
  const first = ran[0]
  const refs = related.filter((row) => row.type === REVIEW_ANCHOR)
  if (!first) return refs.length ? { kind: 'invalid' } : { kind: 'none' }
  const anchor: ReviewAnchor = { sessionKey: s.key, lane: s.lane, ranSeq: first.seq }
  if (
    currentRoot === undefined ||
    [...invalidTurns].some((n) => n === turn || roots.get(n) === currentRoot) ||
    ran.length !== 1
  )
    return { kind: 'invalid', anchor }
  const data = record(first.data)!
  // Only an entirely absent object is legacy. Null, partial and future formats refuse work.
  if (!Object.hasOwn(data, 'reviewBudget')) return { kind: 'legacy', anchor }
  if (!validBudget(data.reviewBudget)) return { kind: 'invalid', anchor }
  const seen = new Set<number>()
  for (const row of refs) {
    const ref = record(row.data)
    const n = owner.get(row.seq)!
    if (
      !trusted(row) ||
      seen.has(n) ||
      ref?.version !== 1 ||
      ref.sessionKey !== anchor.sessionKey ||
      ref.lane !== anchor.lane ||
      ref.ranSeq !== anchor.ranSeq ||
      row.seq <= first.seq ||
      record(starts.get(n)?.data)?.trigger !== 'approval-resume' ||
      !row.sourceEventSeqs?.includes(first.seq)
    )
      return { kind: 'invalid', anchor }
    seen.add(n)
  }
  for (const [n, start] of starts)
    if (roots.get(n) === currentRoot && start.seq > first.seq && !seen.has(n))
      return { kind: 'invalid', anchor }
  const stops = related.filter((row) => row.type === REVIEW_STOP)
  let stopped: ReviewReason | undefined
  for (const row of stops) {
    const stop = record(row.data)
    if (
      !trusted(row) ||
      stop?.ranSeq !== first.seq ||
      !['requests', 'deadline', 'unavailable'].includes(String(stop.reason))
    )
      return { kind: 'invalid', anchor }
    stopped ??= stop.reason as ReviewReason
  }
  const used = related.filter(
    (row) => row.seq > first.seq && row.type === 'effect/intent' && record(row.data)?.kind === 'inference',
  ).length
  return { kind: 'active', anchor, budget: data.reviewBudget, used, ...(stopped ? { stopped } : {}) }
}

/** Written beside turn/start, never as a second register or a new physical-turn allowance. */
export async function reviewContinuationEvents(s: SessionImpl, predecessor: number): Promise<EventInput[]> {
  const state = await readReviewState(s, predecessor)
  if (state.kind === 'none' || !('anchor' in state) || !state.anchor) return []
  return [
    s.ev(
      REVIEW_ANCHOR,
      { version: 1, ...state.anchor },
      {
        ignorable: true,
        sourceEventSeqs: [state.anchor.ranSeq],
      },
    ),
  ]
}
