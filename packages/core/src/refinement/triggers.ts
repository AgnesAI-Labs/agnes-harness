import type { EventInput } from '@agnes/core-common/types'
import type { ToolResult } from '@agnes/extension-api'
import { compactedForControl } from '../request/experience-room.js'
import { isChildSession } from '../step/child-session.js'
import type { SessionImpl } from '../step/session.js'
import { normalizeCommandError, normalizeToolError } from './normalize-error.js'
import type { RefinementTrigger } from './types.js'

/** A trigger and where it came from: the sink is shared by every session of the kernel. */
export type RefinementCandidate = { sessionKey: string; lane: string; trigger: RefinementTrigger }

/**
 * Where Core hands automatic candidates. Core only offers; the owner decides what to do with them
 * (supersede, cooldown, budget). `accepts` lets the owner say that automatic candidates are not
 * wanted right now for a session (for example the mode is manual), so Core does no counting for
 * them at all. Child sessions never reach the sink.
 */
export interface RefinementTriggerSink {
  offer(candidate: RefinementCandidate): void
  accepts?(sessionKey: string): boolean
}

/** The same failing tool and error this many times in one session is a candidate. */
const REPEAT_THRESHOLD = 2

/**
 * Refusals and stops are not lessons: a rejected approval, a paused session, a budget or
 * permission or credential refusal, a user's cancel. They must never be turned into advice, so they
 * are not counted. Matched on the error code, and on the first line of text whenever that text is
 * the key: for tools that only report words, and for an exit-only code (below).
 */
const NEVER_COUNTED_CODE =
  /^(?:APPROVAL_REJECTED|CONTROL_PAUSED|CANCELLED|TOOL_REJECTED_BEFORE_EFFECT)$|BUDGET|PERMISSION|CREDENTIAL|UNAUTHORI[SZ]ED|FORBIDDEN|DENIED|APPROVAL/i
const NEVER_COUNTED_TEXT =
  /permission denied|operation not permitted|access denied|unauthori[sz]ed|forbidden|credential|api[ _-]?key|budget (?:exceeded|exhausted)|quota exceeded|insufficient (?:budget|credits?)/

/**
 * Codes that only say the command exited non-zero. Every failing shell command carries one, so as a
 * key it would make all of them the same error: such a failure is keyed by the error it printed
 * (its stderr first, see `normalizeCommandError`), and by the code only when there is no text. The
 * jobs shell puts the exit status itself in `details.code`, a number: it says no more than these.
 */
const EXIT_ONLY_CODE = new Set(['SHELL_EXIT'])

function live(s: SessionImpl): RefinementTriggerSink | undefined {
  const sink = s.d.refinementTriggers
  if (!sink || !s.d.refinementEnabled?.() || isChildSession(s)) return undefined
  return sink.accepts?.(s.key) === false ? undefined : sink
}

/**
 * Runs a trigger hook. It sits after rows are committed, in steps that must go on, so nothing an
 * owner-supplied function does (a throwing switch, `accepts` or `offer`) may reach the caller: the
 * candidate is dropped.
 */
function guarded(fn: () => void): void {
  try {
    fn()
  } catch {
    // Dropped on purpose; see above.
  }
}

/** A replace row is `summary` unless its begin row says it was an elided fallback. */
export function replaceMode(events: readonly EventInput[]): 'summary' | 'elided' {
  const begin = events.find((event) => event.type === 'x/core/compaction-begin')
  return (begin?.data as { mode?: unknown } | undefined)?.mode === 'elided' ? 'elided' : 'summary'
}

/** A compaction that replaced history with a model summary: one candidate. Elided and failed ones are not. */
export function onCompactionCommitted(
  s: SessionImpl,
  payload: { replaceSeq: number; mode: 'summary' | 'elided' },
): void {
  // A compaction made only to fit a control notice is not a lesson boundary: no trigger.
  if (compactedForControl(s) || payload.mode !== 'summary') return
  guarded(() => {
    const sink = live(s)
    if (sink)
      sink.offer({
        sessionKey: s.key,
        lane: s.lane,
        trigger: { kind: 'compaction', seq: payload.replaceSeq },
      })
  })
}

/** The most tool and error pairs a session's tally keeps; past it the oldest pair is forgotten. */
export const MAX_FAILURE_TALLIES = 256

/** Per session: how often each tool and error was seen, and which were offered. */
const tallies = new WeakMap<SessionImpl, Map<string, { count: number; offered: boolean }>>()

/**
 * A tool result that settled. Failures count per tool and normalized error within the session; the
 * second of the same kind is offered once. A reopened session starts its tally again.
 */
export function onToolSettled(
  s: SessionImpl,
  name: string,
  result: Pick<ToolResult, 'content' | 'isError' | 'details'>,
  code?: string,
): void {
  if (result.isError !== true || !s.turn) return
  guarded(() => countFailure(s, name, result, code))
}

function countFailure(
  s: SessionImpl,
  name: string,
  result: Pick<ToolResult, 'content' | 'details'>,
  code?: string,
): void {
  const sink = live(s)
  if (!sink) return
  const detail = (result.details as { code?: unknown } | null | undefined)?.code
  const known =
    code ?? (typeof detail === 'string' ? detail : typeof detail === 'number' ? 'SHELL_EXIT' : undefined)
  if (known && NEVER_COUNTED_CODE.test(known)) return
  const exitOnly = known !== undefined && EXIT_ONLY_CODE.has(known)
  const byCode = known && !exitOnly ? known : undefined
  const text = byCode
    ? ''
    : exitOnly
      ? normalizeCommandError(result.content)
      : normalizeToolError({ content: result.content })
  if (text && NEVER_COUNTED_TEXT.test(text)) return
  const key = byCode ?? (text || known)
  if (!key) return
  const seen = tallies.get(s) ?? new Map<string, { count: number; offered: boolean }>()
  tallies.set(s, seen)
  const id = `${name}\u0000${key}`
  const tally = seen.get(id) ?? { count: 0, offered: false }
  if (!seen.has(id) && seen.size >= MAX_FAILURE_TALLIES) {
    const oldest = seen.keys().next()
    if (!oldest.done) seen.delete(oldest.value)
  }
  seen.set(id, tally)
  tally.count++
  if (tally.count < REPEAT_THRESHOLD || tally.offered) return
  tally.offered = true
  // `lastSeq` is the last committed row. With parallel calls that can be a sibling's result, so it
  // is not the third failing result itself but a boundary at or after it: everything up to here
  // is evidence the planner may read.
  sink.offer({
    sessionKey: s.key,
    lane: s.lane,
    trigger: { kind: 'repeated-failure', seq: s.lastSeq, focus: name },
  })
}
