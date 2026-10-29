import type { Branding } from '@agnes/sdk'
import type { Colour } from '../ansi.js'
import { slashCommand } from '../commands.js'
import { type Component, escapeControl } from '../component.js'
import { fitLine } from '../components/line.js'
import { boundKeys, keyText } from '../keymap.js'
import { type ExtendedKey, tt } from '../locale-extended.js'
import type { Tone } from '../palette.js'
import { displayWidth } from '../terminal.js'
import { blendColours, brandColour, paintsColour, type ThemedAnsi, type TuiTheme } from '../theme.js'
import { TIMELINE_RESERVED_ROWS } from './timeline.js'

// The AGNES wordmark, figlet's "ANSI Shadow": solid blocks with box-drawing strokes as their shadow.
const MARK = [
  ' █████╗  ██████╗ ███╗   ██╗███████╗███████╗',
  '██╔══██╗██╔════╝ ████╗  ██║██╔════╝██╔════╝',
  '███████║██║  ███╗██╔██╗ ██║█████╗  ███████╗',
  '██╔══██║██║   ██║██║╚██╗██║██╔══╝  ╚════██║',
  '██║  ██║╚██████╔╝██║ ╚████║███████╗███████║',
  '╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝╚══════╝╚══════╝',
]
const MARK_H = MARK.length
const MARK_W = Math.max(...MARK.map((row) => displayWidth(row)))

/** Diagonal brand gradient position of a wordmark pixel, 0..1. */
const diagonal = (x: number, y: number, w: number, h: number): number =>
  0.78 * (x / Math.max(1, w - 1)) + 0.22 * (y / Math.max(1, h - 1))

// The dust field: braille dots, stepped on the left edge, brighter to the right. The seed is fixed,
// so the same field is drawn at every width.
const DUST = ['⠁', '⠂', '⠄', '⡀', '⠈', '⠐', '⠠', '⢀', '⠃', '⠘', '⠆', '⠰', '⡠', '⢁']
const DUST_TONES: readonly Tone[] = ['border', 'borderStrong', 'accent', 'accentSoft']
const DUST_W = 34
const DUST_ROWS = 6
type Dust = { ch: string; t: number } | undefined
const FIELD: readonly (readonly Dust[])[] = (() => {
  let seed = 7
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  return Array.from({ length: DUST_ROWS }, (_, y) => {
    const start = (DUST_ROWS - 1 - y) * 3
    return Array.from({ length: DUST_W }, (_, x): Dust => {
      if (x < start) return undefined
      const t = (x - start) / Math.max(1, DUST_W - start)
      if (rand() >= 0.25 + t * 0.6) return undefined
      return { ch: DUST[Math.floor(rand() * DUST.length)] ?? '⠁', t: Math.min(1, t * 0.9 + rand() * 0.15) }
    })
  })
})()

/** A key as the tips spell it (`ctrl+alt+x`), from the keymap's own names so a rename cannot drift. */
const keyLabel = (name: string): string => keyText(name).toLowerCase()

const START_COMMANDS = [
  ['/model', 'welcome.cmdModel'],
  ['/resume', 'welcome.cmdResume'],
  ['/skills', 'welcome.cmdSkills'],
] as const

/**
 * The built-in tips. Each one names something that works in this build; `fresh` marks a feature new
 * in the current release and earns the NEW tag.
 */
export function welcomeTips(locale: string): { text: string; fresh: boolean }[] {
  return [
    {
      text: tt('welcome.tipToolDetails', locale, { key: keyLabel(boundKeys('card-toggle')[0] ?? 'ctrl-o') }),
      fresh: false,
    },
    {
      text: tt('welcome.tipQueue', locale, { key: keyLabel(boundKeys('steer')[0] ?? 'alt-enter') }),
      fresh: false,
    },
    { text: tt('welcome.tipMention', locale), fresh: false },
    { text: tt('welcome.tipTheme', locale), fresh: false },
    { text: tt('welcome.tipContext', locale), fresh: false },
  ]
}

/** What the banner knows beyond its constructor options; every field may be missing at any time. */
export type WelcomeFacts = {
  version?: string
  workspace?: { root: string; branch?: string; ahead?: number }
  /** Free-form detail after the model, e.g. `reasoning high · 128K context`. */
  modelDetail?: string | undefined
  resources?: { plugins?: number; skills?: number; mcp?: number }
  recent?: readonly { at: number; title: string }[]
  tip?: { text: string; fresh: boolean }
}

// Motion, all measured from `start()`: a diagonal shine over the wordmark that repeats, a hue cycle on
// the NEW tag and an idle blink. Every one of them rests on the frame the still layout draws.
const SHINE_MS = 1200
/** The shine starts again this long after the previous sweep started. */
const SHINE_PERIOD_MS = 5000
const SHINE_BAND = 0.18
const NEW_MS = 2400
const BLINK_MS = 150
const NEW_TONES: readonly Tone[] = ['accentSoft', 'info', 'code', 'danger', 'warning', 'accentSoft']

type Tier = 'full' | 'medium' | 'narrow'
type Variant = { tip: boolean; recent: boolean; tight: boolean }
const VARIANTS: readonly Variant[] = [
  { tip: true, recent: true, tight: false },
  { tip: true, recent: false, tight: false },
  { tip: false, recent: false, tight: false },
  { tip: false, recent: false, tight: true },
]

const clean = (s: string): string => escapeControl(s).replaceAll('\n', ' ')
const spaces = (n: number): string => ' '.repeat(Math.max(0, n))
const padTo = (s: string, n: number): string => s + spaces(n - displayWidth(s))

/**
 * The one expressive element in the TUI: a welcome that scrolls with the conversation. Fixed chrome
 * remains compact; this owns the first-screen hierarchy. The layout follows the terminal size
 * (see `render`) and degrades through half-block art and a single line down to plain text.
 */
export class WelcomeBanner implements Component {
  private model: string | undefined
  private facts: WelcomeFacts = {}

  constructor(
    private readonly o: {
      profile: string
      model?: string
      branding: Branding
      ansi: ThemedAnsi
      theme: TuiTheme
      locale?: string
      /** Terminal height and the rows below the timeline the welcome must leave free; omitted means no limit. */
      viewport?: () => { rows: number; reserved?: number }
      /** Wall clock (ms) for the greeting, relative times and motion; injected by tests. */
      now?: () => number
      /** Randomness for the blink interval; injected by tests. */
      random?: () => number
      /** Whether the output may animate (a TTY with colour); the theme can still rule it out. */
      motion?: boolean
    },
  ) {
    this.model = o.model
  }

  /** Projection truth replaces the optional argv hint as soon as the session opens. */
  setModel(model?: string): void {
    this.model = model
  }

  /** Merges newly known facts; a key set to `undefined` forgets it. */
  update(facts: WelcomeFacts): void {
    this.facts = { ...this.facts, ...facts }
  }

  invalidate(): void {}

  // ---- motion -------------------------------------------------------------------------------

  private startedAt: number | undefined
  private nextBlink = 0
  private blinkEnd = 0

  private get clock(): number {
    return this.o.now?.() ?? Date.now()
  }

  /** Motion needs a TTY with colour and a theme that paints; mono and the none tier stay still. */
  get animates(): boolean {
    return this.o.motion === true && paintsColour(this.o.ansi)
  }

  /** Starts the clock for the shine, the NEW tag and the blink; a second call does nothing. */
  start(): void {
    if (this.startedAt !== undefined) return
    this.startedAt = this.clock
    this.nextBlink = this.clock + 4000 + (this.o.random?.() ?? Math.random()) * 2000
  }

  /**
   * Moves the blink on to now and says how many ms until the picture next changes. Undefined when
   * nothing here animates. Asking is cheap; the caller repaints and calls again after that long.
   */
  tick(): number | undefined {
    if (!this.animates || this.startedAt === undefined) return undefined
    const now = this.clock
    if (now >= this.blinkEnd && now >= this.nextBlink) {
      this.blinkEnd = now + BLINK_MS
      this.nextBlink = this.blinkEnd + 4000 + (this.o.random?.() ?? Math.random()) * 2000
    }
    const elapsed = now - this.startedAt
    const phase = elapsed % SHINE_PERIOD_MS
    if (phase < SHINE_MS) return 60
    if (elapsed < NEW_MS && this.facts.tip?.fresh) return 80
    const blink = now < this.blinkEnd ? this.blinkEnd - now : this.nextBlink - now
    return Math.max(1, Math.ceil(Math.min(blink, SHINE_PERIOD_MS - phase)))
  }

  /** Back to the still picture, eyes open: for when the welcome leaves view or a turn begins. */
  settle(): void {
    this.blinkEnd = 0
  }

  private get elapsed(): number | undefined {
    return this.animates && this.startedAt !== undefined ? this.clock - this.startedAt : undefined
  }

  /** A wordmark pixel's colour: the gradient, lightened where the shine front is passing. */
  private pixel(d: number): Colour | 'accent' {
    const base = this.o.theme.rampAt(d)
    if (base === undefined) return 'accent'
    const elapsed = this.elapsed
    const phase = elapsed === undefined ? SHINE_MS : elapsed % SHINE_PERIOD_MS
    if (phase >= SHINE_MS) return base
    const front = (phase / SHINE_MS) * 1.5 - 0.25
    const k = Math.max(0, 1 - Math.abs(d - front) / SHINE_BAND)
    return k > 0 ? (blendColours([base, this.o.theme.ramp().at(-1)], k) ?? base) : base
  }

  /** NEW: a hue cycle over the first 2.4 s, then the plain accent. */
  private newTag(): string {
    const { ansi, theme } = this.o
    const elapsed = this.elapsed
    if (elapsed === undefined || elapsed >= NEW_MS) return ansi.bold(ansi.fg('accentSoft', 'NEW'))
    return [...'NEW']
      .map((ch, i) => {
        const t = Math.min(1, Math.max(0, (elapsed / NEW_MS) * 1.2 - i * 0.1))
        return ansi.bold(ansi.fg(theme.toneAt(NEW_TONES, t) ?? 'accentSoft', ch))
      })
      .join('')
  }

  private get locale(): string {
    return this.o.locale ?? 'en'
  }

  private get stock(): boolean {
    return this.o.branding.mark === 'agnes'
  }

  render(width: number): string[] {
    width = Math.max(1, Math.trunc(width))
    const { rows, reserved = TIMELINE_RESERVED_ROWS } = this.o.viewport?.() ?? {}
    if (width < 24) return [fitLine(` ${this.brand()} ${this.face()}`, width)]
    if (width < 60 || (rows !== undefined && rows < 24)) return this.compact(width)
    // The timeline keeps the bottom rows for the composer; a hero taller than what is left would lose
    // its top, so each tier sheds the tip, the recent list and then its spacing before giving way.
    const room = rows === undefined ? Number.POSITIVE_INFINITY : rows - reserved
    const tiers: Tier[] =
      width >= 120 && (rows === undefined || rows >= 36)
        ? ['full', 'medium', 'narrow']
        : width >= 80
          ? ['medium', 'narrow']
          : ['narrow']
    for (const tier of tiers)
      for (const v of VARIANTS) {
        const lines = this.hero(width, tier, v)
        if (lines.length <= room) return lines
      }
    return this.compact(width)
  }

  // ---- small styled pieces ------------------------------------------------------------------

  private brand(): string {
    const { ansi, branding } = this.o
    const label = this.stock ? 'agnes' : clean(branding.selfLabel)
    return ansi.bold(ansi.fg(brandColour(branding.accent), label))
  }

  private face(): string {
    const eyes = this.clock < this.blinkEnd ? '˘ᴗ˘' : '·ᴗ·'
    return this.o.ansi.bold(this.o.ansi.fg('accentSoft', eyes))
  }

  private version(): string | undefined {
    const v = this.facts.version
    return v ? clean(v.startsWith('v') ? v : `v${v}`) : undefined
  }

  private modelText(): string {
    const { ansi } = this.o
    return this.model === undefined
      ? ansi.fg('faint', tt('welcome.modelResolving', this.locale))
      : ansi.bold(ansi.fg('fg', clean(this.model)))
  }

  private workspaceText(): string | undefined {
    const { ansi } = this.o
    const ws = this.facts.workspace
    if (!ws) return undefined
    const ahead = ws.ahead !== undefined && ws.ahead > 0 ? ansi.fg('faint', `  +${ws.ahead} ahead`) : ''
    const branch = ws.branch ? `${ansi.fg('faint', ' • ')}${ansi.fg('accentSoft', clean(ws.branch))}` : ''
    return `${ansi.fg('faint', '⌂')} ${ansi.fg('muted', clean(ws.root))}${branch}${ahead}`
  }

  private healthText(): string | undefined {
    const { ansi } = this.o
    const r = this.facts.resources
    const count = (n: number | undefined, one: ExtendedKey, many: ExtendedKey): string | undefined =>
      n === undefined || n < 0
        ? undefined
        : `${ansi.fg('success', '◉')} ${ansi.fg('muted', tt(n === 1 ? one : many, this.locale, { n }))}`
    const parts = [
      count(r?.plugins, 'welcome.plugin1', 'welcome.pluginN'),
      count(r?.skills, 'welcome.skill1', 'welcome.skillN'),
      count(r?.mcp, 'welcome.mcp1', 'welcome.mcpN'),
    ].filter((part): part is string => part !== undefined)
    return parts.length > 0 ? parts.join('   ') : undefined
  }

  private status(): string {
    return this.face()
  }

  private identityName(): string {
    const { ansi, branding } = this.o
    const v = this.version()
    return `${ansi.bold(ansi.fg(brandColour(branding.accent), clean(branding.selfLabel)))}${v ? ansi.fg('faint', `  ${v}`) : ''}`
  }

  private greeting(): string {
    const hour = new Date(this.o.now?.() ?? Date.now()).getHours()
    const key =
      hour >= 5 && hour < 12
        ? 'welcome.greetMorning'
        : hour >= 12 && hour < 18
          ? 'welcome.greetAfternoon'
          : 'welcome.greetEvening'
    return this.o.ansi.bold(this.o.ansi.fg('fg', tt(key, this.locale)))
  }

  private since(at: number): string {
    const s = Math.max(0, ((this.o.now?.() ?? Date.now()) - at) / 1000)
    if (s < 60) return 'now'
    if (s < 3600) return `${Math.floor(s / 60)}m`
    if (s < 86400) return `${Math.floor(s / 3600)}h`
    return `${Math.floor(s / 86400)}d`
  }

  // ---- wordmark -----------------------------------------------------------------------------

  /**
   * The wordmark: `█` cells take the diagonal brand gradient (and the shine), the box-drawing strokes
   * one quieter tone as their shadow. Without colour the blocks are bold and the strokes dim.
   */
  private mark(): string[] {
    const { ansi } = this.o
    const colour = paintsColour(ansi)
    return MARK.map((row, y) => {
      let line = ''
      let run = ''
      let solid = false
      const flush = (): void => {
        if (run) line += solid ? ansi.bold(run) : ansi.fg('faint', run)
        run = ''
      }
      for (const [x, ch] of [...row.padEnd(MARK_W)].entries()) {
        if (!colour) {
          if (ch === ' ' || (ch === '█') === solid) run += ch
          else {
            flush()
            solid = ch === '█'
            run = ch
          }
        } else if (ch === '█') line += ansi.fg(this.pixel(diagonal(x, y, MARK_W, MARK_H)), ch)
        else line += ch === ' ' ? ch : ansi.fg('borderStrong', ch)
      }
      flush()
      return line
    })
  }

  private dustRow(y: number): string[] {
    const { ansi, theme } = this.o
    if (!paintsColour(ansi)) return []
    return (FIELD[y] ?? []).map((cell) =>
      cell === undefined ? ' ' : ansi.fg(theme.toneAt(DUST_TONES, cell.t) ?? 'border', cell.ch),
    )
  }

  // ---- layouts ------------------------------------------------------------------------------

  private compact(width: number): string[] {
    const { ansi } = this.o
    const v = this.version()
    const first = `${this.brand()} ${this.face()}${v ? ansi.fg('faint', ` ${v} · `) : '  '}${this.modelText()}`
    const ws = this.facts.workspace
    const where = [
      clean(this.o.profile),
      ws && `${clean(ws.root)}${ws.branch ? ` • ${clean(ws.branch)}` : ''}`,
    ]
      .filter(Boolean)
      .join(' · ')
    return [fitLine(` ${first}`, width), ...(where ? [fitLine(` ${ansi.fg('faint', where)}`, width)] : [])]
  }

  private hero(width: number, tier: Tier, v: Variant): string[] {
    const { ansi } = this.o
    const lines: string[] = []
    const name = this.identityName()
    const tagline = ansi.fg('muted', tt('welcome.tagline', this.locale))
    const status = this.status()
    if (!this.stock) {
      // A supplied brand never wears the AGNES glyphs: its own name takes the wordmark's place.
      lines.push(fitLine(` ${name}`, width), fitLine(` ${tagline}`, width), fitLine(` ${status}`, width))
    } else if (tier === 'full') {
      // The identity sits in the middle of the mark's six rows.
      const identity = ['', name, tagline, '', status, '']
      const fieldStart = width - 1 - DUST_W
      for (const [y, row] of this.mark().entries()) {
        const id = identity[y] ?? ''
        const left = ` ${row}${id ? `   ${id}` : ''}`
        const leftW = displayWidth(left)
        // The field gives way to the identity text sharing its row.
        const cut = Math.max(0, leftW + 2 - fieldStart)
        const dust = this.dustRow(y).slice(cut)
        const tail = dust.length > 0 ? spaces(fieldStart + cut - leftW) + dust.join('') : ''
        lines.push(fitLine(left + tail, width))
      }
    } else if (tier === 'medium') {
      const identity = ['', name, tagline, '', status, '']
      for (const [i, row] of this.mark().entries()) {
        const id = identity[i] ?? ''
        lines.push(fitLine(` ${row}${id ? `   ${id}` : ''}`, width))
      }
    } else {
      lines.push(...this.mark().map((row) => fitLine(` ${row}`, width)))
      lines.push(fitLine(` ${name}   ${status}`, width))
    }
    if (!v.tight) lines.push(fitLine('', width))
    const tip = this.facts.tip
    if (tip && v.tip && tier !== 'narrow') {
      const fresh = tip.fresh ? `  ${this.newTag()}` : ''
      const head = ansi.bold(ansi.fg('accent', `✦ ${tt('welcome.tip', this.locale)}`))
      lines.push(
        fitLine(` ${head}${ansi.fg('muted', `  ${clean(tip.text)}`)}${fresh}`, width),
        fitLine('', width),
      )
    }
    lines.push(...this.card(width, tier, v))
    if (tier === 'medium' && v.recent) {
      const recent = this.recentLines()
      if (recent.length > 0) lines.push(fitLine('', width), ...recent.map((l) => fitLine(` ${l}`, width)))
    }
    return lines
  }

  private startHere(): string[] {
    const { ansi } = this.o
    const items = START_COMMANDS.filter(([name]) => slashCommand(name) !== undefined).map(
      ([name, key]) => `${ansi.fg('fg', padTo(name, 8))}${ansi.fg('faint', `  ${tt(key, this.locale)}`)}`,
    )
    return [ansi.bold(ansi.fg('accent', tt('welcome.startHere', this.locale))), ...items]
  }

  private recentLines(): string[] {
    const { ansi } = this.o
    const recent = (this.facts.recent ?? []).slice(0, 2)
    if (recent.length === 0) return []
    return [
      ansi.bold(ansi.fg('accent', tt('welcome.recent', this.locale))),
      ...recent.map(
        (r) => `${ansi.fg('faint', `  ${padTo(this.since(r.at), 2)}`)}  ${ansi.fg('muted', clean(r.title))}`,
      ),
      ansi.italic(ansi.fg('faint', tt('welcome.moreSessions', this.locale))),
    ]
  }

  private card(width: number, tier: Tier, v: Variant): string[] {
    const { ansi } = this.o
    const edge = (s: string): string => ansi.fg('border', s)
    const cardW = width - 2
    const ws = this.workspaceText()
    const health = this.healthText()
    const detail = this.facts.modelDetail
    const gap = v.tight ? [] : ['']
    const left = [
      this.greeting(),
      ...gap,
      `${ansi.fg('success', '●')} ${this.modelText()}${detail ? ansi.fg('muted', `   ${clean(detail)}`) : ''}`,
      ...(ws ? [ws] : []),
      ...(health ? [...gap, health] : []),
    ]
    const start = this.startHere()
    let body: string[]
    if (tier === 'narrow') {
      body = [...left, ...gap, ...start].map((l) => `${edge('│')} ${fitLine(l, cardW - 4)} ${edge('│')}`)
    } else {
      const rw = tier === 'full' ? 46 : width >= 100 ? 40 : 34
      const lw = cardW - 2 - 3 - rw - 2
      const right = [...start, ...(tier === 'full' ? this.recentLines() : [])]
      body = Array.from(
        { length: Math.max(left.length, right.length) },
        (_, i) =>
          `${edge('│')} ${fitLine(left[i] ?? '', lw)} ${edge('│')} ${fitLine(right[i] ?? '', rw)} ${edge('│')}`,
      )
    }
    const top = edge(`╭${'─'.repeat(cardW - 2)}╮`)
    return [top, ...body, edge(`╰${'─'.repeat(cardW - 2)}╯`)].map((line) => fitLine(` ${line}`, width))
  }
}
