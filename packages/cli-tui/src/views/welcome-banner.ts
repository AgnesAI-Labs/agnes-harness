import type { Branding } from '@agnes/sdk'
import type { Ansi } from '../ansi.js'
import { xterm256 } from '../ansi.js'
import { type Component, escapeControl } from '../component.js'
import { fitLine } from '../components/line.js'
import { displayWidth } from '../terminal.js'
import { tt } from '../locale-extended.js'
import { tuiColor } from '../theme.js'

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
      ansi: Ansi
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
    const brand = ansi.bold(ansi.fg(xterm256(branding.accent), escapeControl(branding.selfLabel)))
    if (width < 24) return [fitLine(tt('welcome.brandTagline', locale, { brand }), width)]

    const cardWidth = Math.min(78, width - 2)
    const inner = cardWidth - 4
    const row = (content: string): string => ` ${ansi.dim('│')} ${fitLine(content, inner)} ${ansi.dim('│')}`
    const title = ` ${brand} ·ᴗ· `
    const top = ` ${ansi.dim('╭─')}${title}${ansi.dim(
      `${'─'.repeat(Math.max(0, cardWidth - 3 - displayWidth(title)))}╮`,
    )}`
    const context = [this.o.profile, this.o.preset]
      .filter((field): field is string => Boolean(field))
      .map(escapeControl)
      .join(' · ')
    const model = `${ansi.fg(tuiColor.success, '●')} ${escapeControl(this.model ?? tt('welcome.modelResolving', locale))}`
    const hint = ansi.dim(tt('welcome.commandHint', locale))
    const gap = inner - displayWidth(model) - displayWidth(hint)
    return [
      top,
      row(ansi.bold(tt('welcome.heading', locale))),
      row(ansi.dim(context)),
      row(gap >= 2 ? `${model}${' '.repeat(gap)}${hint}` : model),
      ` ${ansi.dim(`╰${'─'.repeat(cardWidth - 2)}╯`)}`,
    ]
  }
}
