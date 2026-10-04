import type { Component } from '../component.js'
import { wrapText } from '../component.js'
import { fitLine } from '../components/line.js'
import { Select } from '../components/select.js'
import { tt } from '../locale-extended.js'

export type AuthMethodChoice = 'agnes-account' | 'api-key'

export type AuthMethodViewOptions = {
  locale?: string
  suggested?: AuthMethodChoice
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
      ],
      onChoose: (id) => {
        if (id === 'agnes-account' || id === 'api-key') options.onChoose(id)
      },
      onCancel: options.onCancel,
    })
    if (options.suggested === 'api-key') this.select.handleInput('\x1b[B')
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
      ...wrapText(tt('authMethod.hint', this.locale), width).map((line) => fitLine(line, width)),
    ]
  }
}
