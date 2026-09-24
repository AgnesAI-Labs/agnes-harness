import type { Component } from '../component.js'
import { wrapText } from '../component.js'
import { fitLine } from '../components/line.js'
import { Select } from '../components/select.js'

const HINT = '↑↓ navigate  enter select  escape/ctrl+c cancel'

export type AuthMethodChoice = 'agnes-account' | 'api-key'

export type AuthMethodViewOptions = {
  suggested?: AuthMethodChoice
  onChoose(choice: AuthMethodChoice): void
  onCancel(): void
}

export class AuthMethodView implements Component {
  private readonly select: Select

  constructor(options: AuthMethodViewOptions) {
    this.select = new Select({
      title: 'Select authentication method:',
      options: [
        { id: 'agnes-account', label: 'Sign in with an Agnes account' },
        { id: 'api-key', label: 'Sign in with an API key / ChatGPT subscription' },
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
    return [...this.select.render(width), ...wrapText(HINT, width).map((line) => fitLine(line, width))]
  }
}
