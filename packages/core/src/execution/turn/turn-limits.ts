import type { PromptSection } from '../../request/contribute.js'
import type { SessionImpl, TurnMemory } from '../../step/session.js'
import { turnMaxSteps } from '../../step/step-cap.js'
import { type TurnTimeLimit, turnTimeLimit } from '../../step/time-limit.js'
import { admittedStep } from './gate.js'

/**
 * Turn limits the model is told about: the prompt's wall-clock limit, the effective step ceiling and
 * a prompt's own credit limit. Only time, steps and credits trigger a note, never anything the model
 * wrote, so the notes behave the same in every language. A turn whose prompt set no limit (an
 * ordinary interactive turn) gets no note at all.
 */
export type TurnLimits = {
  time?: { timeLimitMs: number; deadlineAt: number }
  steps?: { max: number; used: number }
  credits?: { cap: number; used: number }
}

type Kind = keyof TurnLimits
/** Fractions of a limit at which the model is told once how much remains. */
export const LIMIT_THRESHOLDS = [0.5, 0.75, 0.9] as const
/** `level` 0 is the opening note; 1 to 3 index `LIMIT_THRESHOLDS`. */
export type LimitNotice = { level: number; kind: Kind }

const TITLE = 'Turn limits'
/** The highest threshold each turn has told the model about, and the limit it named. Per process. */
const notices = new WeakMap<TurnMemory, LimitNotice>()
const KIND_ORDER: readonly Kind[] = ['time', 'steps', 'credits']

const ADVICE = [
  'Prioritise the core requirement: if its result is not in place yet, put a working version in place and check it before refining anything.',
  'Finish the core requirement now and verify it; skip optional extras and further exploration.',
  'Wrap up: leave the work in its best checked state and end with a short reply saying what is done, how it was checked and what remains.',
] as const

/**
 * The limits in force for the open turn, read from turn memory and ledger state only. Only a prompt
 * that carries a limit of its own (a run budget such as `agh -p --timeout`, `--max-turns` or
 * `--max-budget`) turns the notes on; a preset's standing step ceiling alone is a runaway guard,
 * not a budget for this task, and adds nothing. Once on, the note reports every limit in force.
 */
export function currentTurnLimits(s: SessionImpl, t: TurnMemory): TurnLimits {
  const limits: TurnLimits = {}
  const time = turnTimeLimit(t)
  if (!time && t.maxStepsCap === undefined && t.budgetCap === undefined) return limits
  if (time) limits.time = time
  const max = turnMaxSteps(s)
  if (max !== null) limits.steps = { max, used: Math.max(0, admittedStep(s) - 1) }
  // Only a prompt's own credit limit is a turn total; the preset's per-request cap is not.
  if (t.budgetCap !== undefined) {
    const cap = s.turnBudgetCap()
    if (cap !== null) limits.credits = { cap, used: s.state.creditsUsed }
  }
  return limits
}

function fraction(limits: TurnLimits, kind: Kind, now: number): number {
  if (kind === 'time' && limits.time) {
    const { timeLimitMs, deadlineAt } = limits.time
    return (now - (deadlineAt - timeLimitMs)) / timeLimitMs
  }
  if (kind === 'steps' && limits.steps) return limits.steps.used / limits.steps.max
  if (kind === 'credits' && limits.credits)
    return limits.credits.cap > 0 ? limits.credits.used / limits.credits.cap : 1
  return Number.NEGATIVE_INFINITY
}

/**
 * Which note is due: the highest threshold any limit has crossed, naming the limit nearest its end.
 * A level once reached is kept (with the limit it named), so a note is never taken back or reworded
 * within its level; each threshold therefore reaches the model at most once per turn.
 */
export function dueLimitNotice(limits: TurnLimits, now: number, previous?: LimitNotice): LimitNotice {
  let best: LimitNotice = { level: 0, kind: KIND_ORDER.find((k) => limits[k]) ?? 'time' }
  let bestFraction = Number.NEGATIVE_INFINITY
  for (const kind of KIND_ORDER) {
    if (!limits[kind]) continue
    const used = fraction(limits, kind, now)
    if (used <= bestFraction) continue
    bestFraction = used
    best = { level: LIMIT_THRESHOLDS.filter((t) => used >= t).length, kind }
  }
  return previous && previous.level >= best.level ? previous : best
}

/** Whether the turn's limit note has reached its last threshold, the wrap-up. */
export const wrapUpDue = (t: TurnMemory): boolean => notices.get(t)?.level === LIMIT_THRESHOLDS.length

/** `11m30s`, `45s`, `1h05m`: whole seconds, rounded down so the model never hears it has more. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = total % 60
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m${String(sec).padStart(2, '0')}s`
  return `${sec}s`
}

const formatCredits = (n: number) => String(Math.round(n * 100) / 100)
const stepWord = (n: number) => (n === 1 ? '1 model step' : `${n} model steps`)
const deadline = (at: number) => `${new Date(at).toISOString().slice(0, 19).replace('T', ' ')} UTC`

function describe(limits: TurnLimits): string {
  const parts: string[] = []
  if (limits.time)
    parts.push(
      `a time limit of ${formatDuration(limits.time.timeLimitMs)} (until ${deadline(limits.time.deadlineAt)})`,
    )
  if (limits.steps) parts.push(`at most ${stepWord(limits.steps.max)}`)
  if (limits.credits) parts.push(`a credit limit of ${formatCredits(limits.credits.cap)}`)
  return parts.join('; ')
}

/**
 * What remains when a threshold is crossed. It is derived from the threshold rather than measured,
 * so a recovered turn rebuilds the same text and the note is not delivered again.
 */
function remaining(limits: TurnLimits, kind: Kind, threshold: number): string {
  if (kind === 'time' && limits.time)
    return `about ${formatDuration(Math.round(limits.time.timeLimitMs * (1 - threshold)))} left (until ${deadline(limits.time.deadlineAt)})`
  if (kind === 'steps' && limits.steps)
    return `${stepWord(limits.steps.max - Math.ceil(threshold * limits.steps.max))} left`
  if (kind === 'credits' && limits.credits)
    return `about ${formatCredits(limits.credits.cap * (1 - threshold))} credits left`
  return ''
}

const KIND_NAME: Record<Kind, string> = { time: 'time limit', steps: 'step limit', credits: 'credit limit' }

export function limitNoteText(limits: TurnLimits, notice: LimitNotice): string {
  const all = describe(limits)
  if (notice.level === 0)
    return `${TITLE}\nThis turn has limits: ${all}. When one is reached the turn ends, and what is finished and checked by then is the result. Plan the work to fit, and do the core of the request first.`
  const threshold = LIMIT_THRESHOLDS[notice.level - 1] as number
  return `${TITLE}\n${Math.round(threshold * 100)}% of this turn's ${KIND_NAME[notice.kind]} is used: ${remaining(limits, notice.kind, threshold)}. ${ADVICE[notice.level - 1]}\nLimits for this turn: ${all}.`
}

/**
 * The turn-limits live note for the next request, or none when the turn has no limit. One note item
 * whose text changes at each threshold: live-note delivery sends a changed text once and leaves the
 * system prompt, and so its cache, untouched.
 */
export function turnLimitSection(s: SessionImpl, t: TurnMemory): PromptSection | undefined {
  const limits = currentTurnLimits(s, t)
  if (!limits.time && !limits.steps && !limits.credits) return undefined
  const notice = dueLimitNotice(limits, s.d.clock(), notices.get(t))
  notices.set(t, notice)
  return {
    id: 'core:turn-limits',
    order: 114,
    source: 'core',
    text: limitNoteText(limits, notice),
    delivery: 'live-note',
  }
}

/** The measured time is stated to the nearest 10 s: precise enough to plan with, and not noisy. */
const CLOCK_STEP_MS = 10_000

/**
 * The turn's measured time for the request being assembled, in a turn with a time limit. The
 * threshold notes above say what remained when a threshold was crossed; between them the model knew
 * the deadline but not the current time, and in one run concluded the limit was reached with minutes
 * left. This text is measured from the clock at each request and written as a short Core note
 * (`[turn time]`) deduplicated against the latest one, so a request inside the same 10 s adds nothing.
 * It is history like any note: the cached prefix stays put, and a recovered turn needs no identical
 * rebuild, since its next request simply measures again.
 */
export function turnTimeText(limit: TurnTimeLimit, now: number): string {
  const left = limit.deadlineAt - now
  const total = formatDuration(limit.timeLimitMs)
  if (left <= 0)
    return `This turn's ${total} time limit is reached. End now with a short reply saying what is done, how it was checked and what remains.`
  const step = (ms: number) => Math.floor(ms / CLOCK_STEP_MS) * CLOCK_STEP_MS
  const used = Math.min(limit.timeLimitMs, Math.max(0, now - (limit.deadlineAt - limit.timeLimitMs)))
  const remaining = left < CLOCK_STEP_MS ? 'less than 10s' : `about ${formatDuration(step(left))}`
  return `${formatDuration(step(used))} of this turn's ${total} time limit used, ${remaining} left. This remaining time is measured at this request and is authoritative: do not conclude that the time limit is reached unless this note says so.`
}

/** The measured time for the request being assembled, or none when the turn has no time limit. */
export function turnTimeNote(s: SessionImpl, t: TurnMemory): string | undefined {
  const limit = turnTimeLimit(t)
  return limit ? turnTimeText(limit, s.d.clock()) : undefined
}
