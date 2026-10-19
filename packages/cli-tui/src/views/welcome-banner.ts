import type { Branding } from '@agnes/sdk'
import { type Component, escapeControl } from '../component.js'
import { fitLine } from '../components/line.js'
import { tt } from '../locale-extended.js'
import { displayWidth } from '../terminal.js'
import { brandColour, type ThemedAnsi, type TuiTheme } from '../theme.js'

// "agnes" in half blocks: a 4×6 pixel cell per letter, x-height on the middle four pixel rows so
// only the g descends.
const WORDMARK = ['▄▀▀▄ ▄▀▀▀ █▄ █ █▀▀▀ ▄▀▀▀', '█▀▀█ █ ▀█ █ ▀█ █▀▀   ▀▀▄', '▀  ▀  ▀▀▀ ▀  ▀ ▀▀▀▀ ▀▀▀']

/**
 * The one expressive element in the TUI: a quiet session card that scrolls with the conversation.
 * Fixed chrome remains compact; this card owns the welcoming voice and first-screen hierarchy.
 */
export class WelcomeBanner implements Component {
  private model: string | undefined

  constructor(
    private readonly o: {
      profile: string
      preset?: string
      model?: string
      branding: Branding
      ansi: ThemedAnsi
      theme: TuiTheme
      locale?: string
    },
  ) {
    this.model = o.model
  }

  /** Projection truth replaces the optional argv hint as soon as the session opens. */
  setModel(model?: string): void {
    this.model = model
  }

  invalidate(): void {}

  render(width: number): string[] {
    width = Math.max(1, Math.trunc(width))
    const { ansi, branding } = this.o
    const locale = this.o.locale ?? 'en'
    const brand = ansi.bold(ansi.fg(brandColour(branding.accent), escapeControl(branding.selfLabel)))
    if (width < 24) return [fitLine(tt('welcome.brandTagline', locale, { brand }), width)]

    const face = ansi.fg('accentSoft', '·ᴗ·')
    const ramp = this.o.theme.ramp()
    // The glyphs spell the default brand, so a supplied brand never wears them.
    const wordmark =
      width >= 60 && branding.mark === 'agnes'
        ? WORDMARK.map((line, i) => {
            const colour = ramp[i]
            const glyphs = ansi.bold(colour === undefined ? line : ansi.fg(colour, line))
            return ` ${glyphs}${i === 1 ? ` ${face}` : ''}`
          })
        : []
    const cardWidth = Math.min(78, width - 2)
    const inner = cardWidth - 4
    const edge = (s: string): string => ansi.fg('border', s)
    const row = (content: string): string => ` ${edge('│')} ${fitLine(content, inner)} ${edge('│')}`
    const context = [this.o.profile, this.o.preset]
      .filter((field): field is string => Boolean(field))
      .map(escapeControl)
      .join(' · ')
    const model = `${ansi.fg('success', '●')} ${escapeControl(this.model ?? tt('welcome.modelResolving', locale))}`
    const hint = ansi.fg('faint', tt('welcome.commandHint', locale))
    const gap = inner - displayWidth(model) - displayWidth(hint)
    return [
      ...wordmark,
      fitLine(` ${brand} ${face}`, width),
      ` ${edge(`╭${'─'.repeat(cardWidth - 2)}╮`)}`,
      row(ansi.bold(tt('welcome.heading', locale))),
      row(ansi.dim(context)),
      row(gap >= 2 ? `${model}${' '.repeat(gap)}${hint}` : model),
      ` ${edge(`╰${'─'.repeat(cardWidth - 2)}╯`)}`,
    ]
  }
}
