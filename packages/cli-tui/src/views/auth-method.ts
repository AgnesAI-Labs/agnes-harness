import { createAnsi } from '../ansi.js'
import type { Component } from '../component.js'
import { keyHints } from '../components/key-hints.js'
import { fitLine } from '../components/line.js'
import { Select } from '../components/select.js'
import { tt } from '../locale-extended.js'
import { TuiTheme } from '../theme.js'

// Onboarding draws before any theme is chosen, so its key row is plain.
const PLAIN = new TuiTheme('mono').ansi(createAnsi('none'))

export type AuthMethodChoice = 'agnes-account' | 'api-key' | 'demo'

export type AuthMethodViewOptions = {
  locale?: string
  suggested?: AuthMethodChoice
  allowDemo?: boolean
  onChoose(choice: AuthMethodChoice): void
  onCancel(): void
}

export class AuthMethodView implements Component {
  private readonly select: Select
  private readonly locale: string

  constructor(options: AuthMethodViewOptions) {
    const locale = options.locale ?? 'en'
    this.locale = locale
    this.select = new Select({
      title: tt('authMethod.title', locale),
      options: [
        { id: 'agnes-account', label: tt('authMethod.agnesAccount', locale) },
        { id: 'api-key', label: tt('authMethod.apiKey', locale) },
        ...(options.allowDemo ? [{ id: 'demo', label: tt('authMethod.demo', locale) }] : []),
      ],
      onChoose: (id) => {
        if (id === 'agnes-account' || id === 'api-key' || id === 'demo') options.onChoose(id)
      },
      onCancel: options.onCancel,
    })
    if (options.suggested === 'api-key' || (options.suggested === 'demo' && options.allowDemo))
      this.select.handleInput('\x1b[B')
    if (options.suggested === 'demo' && options.allowDemo) this.select.handleInput('\x1b[B')
  }

  invalidate(): void {
    this.select.invalidate()
  }

  handleInput(data: string): boolean {
    return this.select.handleInput(data)
  }

  render(width: number): string[] {
    return [
      ...this.select.render(width),
      fitLine(
        keyHints(
          [
            { key: '↑↓', label: tt('dialog.select', this.locale) },
            { key: '⏎', label: tt('dialog.confirm', this.locale) },
            { key: 'esc', label: tt('dialog.close', this.locale) },
          ],
          PLAIN,
          width,
        ),
        width,
      ),
    ]
  }
}
