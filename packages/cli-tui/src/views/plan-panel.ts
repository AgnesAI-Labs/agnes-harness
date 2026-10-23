import type { UITimeline } from '@agnes/protocol'
import { type Component, escapeControl } from '../component.js'
import { fitLine } from '../components/line.js'
import { tt } from '../locale-extended.js'
import type { ThemedAnsi } from '../theme.js'
import { RAIL_MIN_WIDTH } from './composer-rail.js'
import { latestPlan, type PlanStep, STEP_MARK } from './special-card.js'

/** `auto` shows the panel while a plan is unfinished; `show` and `hide` pin it either way. */
export type PlanMode = 'auto' | 'show' | 'hide'
export const PLAN_MODES: readonly PlanMode[] = ['auto', 'show', 'hide']
/** Rows the panel may take, whatever the plan's length. */
export const PLAN_PANEL_ROWS = 6

/**
 * The current plan, pinned above the prompt. It reads the newest plan call of the projected
 * timeline (nothing new on the wire); a plan whose arguments were cut off does not parse and shows
 * nothing. Once every step is done a one-line summary stays until the next turn begins.
 */
export class PlanPanel implements Component {
  private mode: PlanMode = 'auto'
  private plan: { id: string; steps: PlanStep[] } | undefined
  private session: string | undefined
  private running = false
  /** The plan call a new turn already took off the panel; its finished summary does not come back. */
  private retired: string | undefined
  /** Whether the finished summary is up: it was open, or finished while a turn ran. */
  private finished = false

  constructor(
    private readonly ansi: ThemedAnsi,
    private readonly locale: string,
  ) {}

  /** Forgets the plan: a new or switched session starts without one. */
  reset(): void {
    this.plan = undefined
    this.session = undefined
    this.running = false
    this.retired = undefined
    this.finished = false
  }

  apply(timeline: UITimeline): void {
    if (this.session !== undefined && this.session !== timeline.sessionId) this.reset()
    this.session = timeline.sessionId
    const running = timeline.opState != null
    // A turn starting takes the finished summary off for good.
    if (running && !this.running && this.finished) this.retired = this.plan?.id
    this.running = running
    this.plan = latestPlan(timeline)
    const complete = this.plan?.steps.every((step) => step.status === 'done') ?? false
    this.finished = complete && this.plan?.id !== this.retired && (this.finished || running)
  }

  /** `/todos [auto|show|hide]`: one of the three, or the next one after the current when none is named. */
  setMode(arg?: string): string | undefined {
    const next = arg === undefined ? PLAN_MODES[(PLAN_MODES.indexOf(this.mode) + 1) % PLAN_MODES.length] : arg
    if (next !== 'auto' && next !== 'show' && next !== 'hide') return undefined
    this.mode = next
    return tt(`todos.${next}`, this.locale)
  }

  private get visible(): boolean {
    if (!this.plan || this.mode === 'hide') return false
    return this.mode === 'show' || this.finished || !this.plan.steps.every((step) => step.status === 'done')
  }

  invalidate(): void {}

  render(width: number): string[] {
    const steps = this.plan?.steps
    if (!steps || !this.visible) return []
    const done = steps.filter((step) => step.status === 'done').length
    const vars = { done, total: steps.length }
    if (done === steps.length)
      return [fitLine(` ${this.ansi.fg('success', tt('plan.summaryDone', this.locale, vars))}`, width)]
    if (width < RAIL_MIN_WIDTH) return [fitLine(` ${tt('plan.summary', this.locale, vars)}`, width)]
    // Over the row budget, five rows centre on the step in progress and the last row counts what is left out.
    const room = steps.length > PLAN_PANEL_ROWS ? PLAN_PANEL_ROWS - 1 : steps.length
    const doing = steps.findIndex((step) => step.status === 'doing')
    const at =
      doing >= 0
        ? doing
        : Math.max(
            0,
            steps.findIndex((step) => step.status !== 'done'),
          )
    const from = Math.max(0, Math.min(at - Math.floor(room / 2), steps.length - room))
    const rows = steps.slice(from, from + room).map((step) => {
      const [mark, tone] = STEP_MARK[step.status]
      const text = escapeControl(step.text.replace(/\s+/g, ' ').trim())
      return fitLine(
        ` ${this.ansi.fg(tone, mark)} ${step.status === 'doing' ? this.ansi.bold(text) : text}`,
        width,
      )
    })
    if (steps.length > room)
      rows.push(
        fitLine(` ${this.ansi.dim(tt('card.more', this.locale, { count: steps.length - room }))}`, width),
      )
    return rows
  }
}
