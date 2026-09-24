import type { UsageView } from '@agnes/protocol'
import type { Branding } from '@agnes/sdk'
import type { Ansi } from '../ansi.js'
import { xterm256 } from '../ansi.js'
import { type Component, escapeControl } from '../component.js'
import { fitLine } from '../components/line.js'
import {
  formatCredits,
  formatUsageLine,
  PRESSURE_ERROR_FRACTION,
  PRESSURE_WARNING_FRACTION,
} from '../format-usage.js'
import { type Locale, t } from '../locale.js'
import type { StatusItem } from '../slots.js'
import { tuiColor } from '../theme.js'

export type LinkState = 'ok' | 'reconnecting' | 'catching-up'
export type NoticeTone = 'info' | 'success' | 'warning' | 'error'
const NOTICE_COLOR = { success: tuiColor.success, warning: tuiColor.warning, error: tuiColor.danger } as const

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
  private usage: UsageView | undefined

  constructor(
    private readonly ansi: Ansi,
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
    // Each segment carries its own emphasis instead of one dim blanket: the budget is the number
    // a user watches, a notice is always worth attention, and a broken link spins yellow.
    const paintedNotice =
      this.noticeTone === 'info'
        ? this.ansi.dim(escapeControl(this.notice))
        : this.ansi.fg(NOTICE_COLOR[this.noticeTone], escapeControl(this.notice))
    const parts = [
      ...this.slots.map((s) => this.ansi.dim(`[${s.level}] ${escapeControl(s.text)}`)),
      this.budget ? this.ansi.bold(this.ansi.fg(this.budgetTier === 'error' ? 196 : 214, this.budget)) : '',
      this.parked ? this.ansi.dim(this.parked) : '',
      this.notice ? paintedNotice : '',
      this.link === 'ok'
        ? ''
        : `${this.ansi.fg(178, '⟳')}${this.ansi.dim(
            ` ${t(this.link === 'reconnecting' ? 'status.reconnecting' : 'status.catchingUp', this.locale)}`,
          )}`,
    ].filter(Boolean)
    const lines = [fitLine(parts.join(this.ansi.dim(' · ')), width)]
    if (this.usage) lines.push(formatUsageLine(this.usage, width, this.ansi, false))
    return lines
  }
}

export type HeaderState = {
  profile: string
  preset: string
  model?: string
  sessionId: string
  generation: number
  opState?: { turn: number; step: number; phase: string }
}

/** One header line: the brand segment, then profile, preset, session id's last 8 characters,
 * generation, and op state, with dim separators between the segments. */
export class Header implements Component {
  private state: HeaderState | undefined

  constructor(
    private readonly ansi: Ansi,
    private readonly branding: Branding,
  ) {}

  set(h: HeaderState): void {
    this.state = { ...h, ...(h.opState ? { opState: { ...h.opState } } : {}) }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const h = this.state
    if (!h) return ['']
    const op = h.opState ? `turn ${h.opState.turn} step ${h.opState.step} ${h.opState.phase}` : ''
    const fields = [
      this.ansi.fg(tuiColor.muted, h.profile),
      this.ansi.fg(tuiColor.muted, h.preset),
      ...(h.model ? [this.ansi.bold(h.model)] : []),
      this.ansi.fg(tuiColor.muted, h.sessionId.slice(-8)),
      this.ansi.fg(tuiColor.muted, `g${h.generation}`),
      op ? this.ansi.fg(tuiColor.warning, op) : '',
    ].filter(Boolean)
    const label = this.branding.mark || this.branding.selfLabel
    const brand = this.ansi.bold(this.ansi.fg(xterm256(this.branding.accent), escapeControl(label)))
    const line = [brand, ...fields].join(this.ansi.dim(' · '))
    return [fitLine(line, width)]
  }
}
