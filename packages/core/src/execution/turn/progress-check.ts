import type { OpStateObj } from '@agnes/core-common/step/op-state'
import type { Event, Seq } from '@agnes/core-common/types'
import { scanAll } from '@agnes/core-ledger/log/scan-pages'
import { PROGRESS_CHECK_PREFIX } from '../../request/derive.js'
import type { SessionImpl, TurnMemory } from '../../step/session.js'
import { progressChecked } from '../../step/turn-restore.js'
import { wrapUpDue } from './turn-limits.js'

/**
 * Progress checks, off unless a preset sets `loop.progress_check_steps`: in a turn that runs under a
 * prompt limit or unattended, the model is asked now and then to state its done-check, its progress against it and whether to finish, continue or switch to
 * a more direct approach. A model that spins in place rarely stops on its own; a periodic self-review
 * against the goal is what moved it in other harnesses. The check is a note and nothing more: it never
 * ends the turn and never blocks a tool call.
 *
 * Every trigger is a structured ledger fact, never the model's wording, so it behaves the same in any
 * language: model steps since the last check, new files the official write tool created, a run of
 * failed tool results, or a step whose loop-hygiene verdict saw repeated writes or no progress.
 *
 * The state is the ledger itself. The last check is the last `[progress check]` note of the turn,
 * and the counts start after it, so a recovered turn replays the same rows, finds the check it
 * already delivered and does not send it again; the note's key also stops the same check twice.
 */

/** The receipt the official write and edit tools record per file change; `existed: false` is a new file. */
const FILE_CHANGE_RECEIPT = 'x/agnes/tools-core/file-change'
/** New files since the last check that call for one early. */
const FILES_TRIGGER = 8
/** Failed tool results in a row that call for a check early. */
const FAILURES_TRIGGER = 5
/** An early trigger waits this many model steps after the last check, so one burst asks once. */
const MIN_STEPS_BETWEEN = 3

type Stall = 'repeated' | 'no_progress'
type Tally = {
  /** Rows read through this sequence. */
  to: Seq
  /** The step whose request opened last; a check note is written with its step's start. */
  step: number
  checks: number
  /** The step whose request carried the last check; 0 before the first. */
  lastStep: number
  files: number
  failRun: number
  failedRun: number
  stall?: Stall
}

const tallies = new WeakMap<TurnMemory, Tally>()

function fresh(to: Seq): Tally {
  return { to, step: 0, checks: 0, lastStep: 0, files: 0, failRun: 0, failedRun: 0 }
}

function noteText(e: Event): string | undefined {
  const data = e.data as { kind?: unknown; content?: Array<{ text?: unknown }> } | null
  const text = data?.kind === 'runtime_context' ? data.content?.[0]?.text : undefined
  return typeof text === 'string' ? text : undefined
}

function read(t: Tally, e: Event): void {
  const data = (e.data ?? {}) as Record<string, unknown>
  if (e.type === FILE_CHANGE_RECEIPT) {
    if (data.existed === false) t.files++
    return
  }
  if (e.type === 'step/start') {
    if (typeof data.step === 'number') t.step = data.step
  } else if (e.type === 'tool/result') {
    t.failRun = data.isError === true ? t.failRun + 1 : 0
    if (t.failRun >= FAILURES_TRIGGER) t.failedRun = t.failRun
  } else if (e.type === 'verifier/signal') {
    const reasons = data.scope === 'step' && Array.isArray(data.reasons) ? data.reasons.map(String) : []
    if (reasons.some((r) => r.startsWith('repeated_write'))) t.stall = 'repeated'
    else if (reasons.some((r) => r.startsWith('no_progress'))) t.stall ??= 'no_progress'
  } else if (noteText(e)?.startsWith(PROGRESS_CHECK_PREFIX)) {
    Object.assign(t, { checks: t.checks + 1, lastStep: t.step, files: 0, failRun: 0, failedRun: 0 })
    delete t.stall
  }
}

/** The turn's tally brought up to the ledger's end; recovery starts again from the turn's trigger. */
async function tally(s: SessionImpl, t: TurnMemory, triggerSeq: Seq): Promise<Tally> {
  const current = tallies.get(t) ?? fresh(triggerSeq)
  if (s.lastSeq > current.to) {
    const rows = await scanAll((q) => s.d.log.scan(q), {
      fromSeq: (current.to + 1) as Seq,
      toSeq: s.lastSeq,
      type: ['step/start', 'user/message', 'tool/result', 'verifier/signal', FILE_CHANGE_RECEIPT],
    })
    for (const e of rows)
      if (e.type === FILE_CHANGE_RECEIPT || (e.lane ?? s.lane) === s.lane) read(current, e)
    current.to = s.lastSeq
  }
  tallies.set(t, current)
  return current
}

function reason(t: Tally, steps: number, every: number): string | undefined {
  const since = t.checks === 0 ? 'so far in this turn' : 'since the last progress check'
  if (steps >= MIN_STEPS_BETWEEN) {
    if (t.stall === 'repeated') return 'The same change was made several times in a row.'
    if (t.stall === 'no_progress') return 'Several replies in a row brought no new results.'
    if (t.failedRun > 0) return `${t.failedRun} tool results in a row failed.`
    if (t.files >= FILES_TRIGGER) return `${t.files} new files were created ${since}.`
  }
  return steps >= every ? `${steps} model steps ${since}.` : undefined
}

export function progressCheckText(check: number, turn: number, step: number, why: string): string {
  const since = check === 1 ? 'since this turn began' : 'since the last progress check'
  return `Progress check ${check} (turn ${turn}, step ${step})
${why} Before your next action, answer in three short lines:
1. Done-check: the check that proves this request is done, and whether it passes now.
2. Progress: what changed in that check's result ${since}.
3. Decision: FINISH (it passes: stop and report), CONTINUE (name the next concrete step) or SWITCH (this approach is not moving the result: name the more direct approach you take instead), and why.`
}

/**
 * The progress check due with the request being assembled, as a Core note, or none. Only a turn under
 * a prompt limit or unattended, with checks turned on, is read at all. None once the turn's limit note has reached its
 * wrap-up: finishing then matters more than reviewing.
 */
export async function progressCheckNote(s: SessionImpl, t: TurnMemory, op: OpStateObj) {
  if (!progressChecked(s, t)) return undefined
  const state = await tally(s, t, op.meta.triggerSeq)
  if (wrapUpDue(t)) return undefined
  const step = op.step + 1
  const why = reason(state, step - 1 - state.lastStep, s.preset.progressCheck.everySteps)
  if (!why) return undefined
  const text = progressCheckText(state.checks + 1, op.meta.turn, step, why)
  const key = text.split('\n', 1)[0] as string
  return { prefix: PROGRESS_CHECK_PREFIX, text, dedup: { kind: 'present' as const, key } }
}
