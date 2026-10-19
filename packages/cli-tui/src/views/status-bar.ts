import type { UsageView } from '@agnes/protocol'
import type { Branding } from '@agnes/sdk'
import { type Component, escapeControl } from '../component.js'
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
import { brandColour, type ThemedAnsi } from '../theme.js'
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
    const parts = [
      ...this.slots.map(
        (s) =>
          `${this.ansi.fg(LEVEL_TONE[s.level] ?? 'muted', `[${s.level}]`)} ${this.ansi.dim(escapeControl(s.text))}`,
      ),
      this.budget
        ? this.ansi.bold(this.ansi.fg(this.budgetTier === 'error' ? 'danger' : 'warning', this.budget))
        : '',
      this.parked ? this.ansi.dim(this.parked) : '',
      this.notice ? this.ansi.fg(NOTICE_TONE[this.noticeTone], escapeControl(this.notice)) : '',
      this.link === 'ok' ? '' : this.ansi.fg('warning', `⟳ ${link}`),
    ].filter(Boolean)
    const lines = [fitLine(parts.join(this.ansi.fg('faint', ' · ')), width)]
    // The composer rail draws the context gauge at the same width; below its floor this line does.
    const usage = this.usage && formatUsageLine(this.usage, width, this.ansi, false, width < RAIL_MIN_WIDTH)
    if (usage?.trim()) lines.push(usage)
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

/** One header line: the brand and mascot, then profile, preset, model, session id's last 8
 * characters, generation, and op state, with faint separators between the segments. */
export class Header implements Component {
  private state: HeaderState | undefined

  constructor(
    private readonly ansi: ThemedAnsi,
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
      h.profile && this.ansi.fg('muted', h.profile),
      h.preset && this.ansi.fg('muted', h.preset),
      h.model && this.ansi.bold(this.ansi.fg('fg', h.model)),
      this.ansi.fg('faint', `#${h.sessionId.slice(-8)}`),
      this.ansi.fg('faint', `g${h.generation}`),
      op && this.ansi.fg('warning', op),
    ].filter(Boolean)
    const label = this.branding.mark || this.branding.selfLabel
    const brand = `${this.ansi.bold(
      this.ansi.fg(brandColour(this.branding.accent), escapeControl(label)),
    )}${this.ansi.fg('faint', ' ·ᴗ·')}`
    return [fitLine([brand, fields.join(this.ansi.fg('faint', ' · '))].filter(Boolean).join('  '), width)]
  }
}
