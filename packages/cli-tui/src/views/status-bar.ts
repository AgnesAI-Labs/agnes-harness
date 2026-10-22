import type { UsageView } from '@agnes/protocol'
import { type Component, escapeControl, wrapText } from '../component.js'
import { fitLine } from '../components/line.js'
import {
  formatCredits,
  formatUsageLine,
  PRESSURE_ERROR_FRACTION,
  PRESSURE_WARNING_FRACTION,
} from '../format-usage.js'
import { type Locale, t } from '../locale.js'
import type { Tone } from '../palette.js'
import type { StatusItem } from '../slots.js'
import { displayWidth } from '../terminal.js'
import type { ThemedAnsi } from '../theme.js'
import { RAIL_MIN_WIDTH } from './composer-rail.js'

export type LinkState = 'ok' | 'reconnecting' | 'catching-up'
export type NoticeTone = 'info' | 'success' | 'warning' | 'error'
const NOTICE_TONE = { info: 'info', success: 'success', warning: 'warning', error: 'danger' } as const
// Keyed by string: the level arrives in an extension's slot payload.
const LEVEL_TONE: Record<string, Tone> = { info: 'info', warn: 'warning', error: 'danger' }

/**
 * One composed status line: `status.line` slot fills, the current budget, a parked approval
 * ticket, the most recent daemon notice, and the connection's link state, joined with ` · ` and
 * with any unset piece omitted entirely (not just left blank) so a cleared field never leaves a
 * stale fragment in the render.
 */
export class StatusBar implements Component {
  private slots: StatusItem[] = []
  private budget = ''
  private budgetTier: 'hidden' | 'warning' | 'error' = 'hidden'
  private parked = ''
  private notice = ''
  private noticeTone: NoticeTone = 'info'
  private link: LinkState = 'ok'
  private safeMode = false
  private usage: UsageView | undefined

  constructor(
    private readonly ansi: ThemedAnsi,
    private readonly locale: Locale = 'en',
  ) {}

  setSlots(items: StatusItem[]): void {
    this.slots = items
  }

  /**
   * Below the 70% warning threshold, or with no hard cap at all, this stays hidden -- a number
   * that never changes colour is background noise nobody reads by the time it matters (spec
   * RP2). Above it, the segment shows the fraction crossed and, at 90%, an explicit warning
   * glyph on top of the colour change.
   */
  setBudget(used: number, cap?: number): void {
    if (cap === undefined || cap <= 0) {
      this.budget = ''
      this.budgetTier = 'hidden'
      return
    }
    const fraction = used / cap
    if (fraction < PRESSURE_WARNING_FRACTION) {
      this.budget = ''
      this.budgetTier = 'hidden'
      return
    }
    const pct = Math.round(fraction * 100)
    const isError = fraction >= PRESSURE_ERROR_FRACTION
    this.budget = `credits ${formatCredits(used)}/${formatCredits(cap)} · ${pct}%${isError ? ' ⚠' : ''}`
    this.budgetTier = isError ? 'error' : 'warning'
  }

  setParked(ticket?: string): void {
    this.parked = ticket ? `${t('status.parked', this.locale)} ${ticket.slice(0, 8)}…` : ''
  }

  setNotice(text?: string, tone: NoticeTone = 'info'): void {
    this.notice = text ?? ''
    this.noticeTone = tone
  }

  /** A run that skipped parts of its setup says so for its whole life, so nobody forgets it. */
  setSafeMode(on: boolean): void {
    this.safeMode = on
  }

  setLink(state: LinkState): void {
    this.link = state
  }

  /** Updates the Pi-style usage footer from the same projection as the timeline. */
  setUsage(usage?: UsageView): void {
    this.usage = usage
  }

  invalidate(): void {}

  render(width: number): string[] {
    // `escapeControl` on the two pieces that can carry text an extension or the daemon chose
    // (slot fills, notices): every other part is minted by this component itself from numbers
    // and a fixed enum, so nothing else here can carry a stray control byte to the terminal.
    const link = t(this.link === 'reconnecting' ? 'status.reconnecting' : 'status.catchingUp', this.locale)
    const notice = this.notice ? this.ansi.fg(NOTICE_TONE[this.noticeTone], escapeControl(this.notice)) : ''
    const parts = [
      ...this.slots.map(
        (s) =>
          `${this.ansi.fg(LEVEL_TONE[s.level] ?? 'muted', `[${s.level}]`)} ${this.ansi.dim(escapeControl(s.text))}`,
      ),
      this.budget
        ? this.ansi.bold(this.ansi.fg(this.budgetTier === 'error' ? 'danger' : 'warning', this.budget))
        : '',
      this.safeMode ? this.ansi.fg('warning', t('status.safeMode', this.locale)) : '',
      this.parked ? this.ansi.dim(this.parked) : '',
      notice,
      this.link === 'ok' ? '' : this.ansi.fg('warning', `⟳ ${link}`),
    ].filter(Boolean)
    const separator = this.ansi.fg('faint', ' · ')
    const content = parts.join(separator)
    const lines = [fitLine(content, width)]
    // A public refusal includes both a reason and an action; keep the action readable on narrow terminals.
    if (notice && this.noticeTone === 'error' && displayWidth(content) > width) {
      const context = parts.filter((part) => part !== notice).join(separator)
      lines.splice(
        0,
        lines.length,
        ...(context ? [fitLine(context, width)] : []),
        ...wrapText(escapeControl(this.notice), width).map((line) =>
          fitLine(this.ansi.fg(NOTICE_TONE.error, line), width),
        ),
      )
    }
    // The composer rail draws the context gauge at the same width; below its floor this line does.
    const usage =
      this.usage && formatUsageLine(this.usage, width, this.ansi, false, width < RAIL_MIN_WIDTH, this.locale)
    if (usage?.trim()) lines.push(usage)
    return lines
  }
}
