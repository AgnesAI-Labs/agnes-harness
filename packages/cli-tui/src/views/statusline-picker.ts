import type { Component } from '../component.js'
import { type Box, dialogBox } from '../components/box.js'
import { fitLine } from '../components/line.js'
import { actionFor } from '../keymap.js'
import { parseKey } from '../keys.js'
import { tt } from '../locale-extended.js'
import { STATUS_FIELDS, type StatusLineConfig } from '../statusline-config.js'
import type { ThemedAnsi } from '../theme.js'

/**
 * `/statusline`: every field of the status line with a check box. Space or Enter flips the one under
 * the cursor and saves at once; Esc closes. What is never hidden (the budget warning, a parked
 * approval ticket, error notices) is named under the list so nobody looks for a box that is not there.
 */
export class StatusLinePicker implements Component {
  private box: Box | undefined
  private at = 0
  private saved = true

  constructor(
    private readonly o: { config: StatusLineConfig; ansi: ThemedAnsi; locale: string; changed(): void },
  ) {}

  get config(): StatusLineConfig {
    return this.o.config
  }

  show(): void {
    this.at = 0
    this.saved = true
    const { ansi, locale } = this.o
    const rows = (width: number): string[] => [
      ...STATUS_FIELDS.map((field, i) => {
        const line = fitLine(
          `${i === this.at ? '❯' : ' '} [${this.o.config.shows(field) ? 'x' : ' '}] ${tt(`statusline.field.${field}`, locale)}`,
          width,
        )
        return i === this.at ? ansi.bg('selection', ansi.bold(ansi.fg('accent', line))) : line
      }),
      ansi.dim(fitLine(tt('statusline.always', locale), width)),
      ...(this.saved ? [] : [ansi.dim(fitLine(tt('statusline.unsaved', locale), width))]),
    ]
    this.box = dialogBox(
      { render: rows, invalidate: () => {} },
      {
        title: tt('statusline.title', locale),
        ansi,
        hints: [
          { key: '↑↓', label: tt('dialog.select', locale) },
          { key: 'space/⏎', label: tt('dialog.toggle', locale) },
          { key: 'esc', label: tt('dialog.close', locale) },
        ],
      },
    )
    this.o.changed()
  }

  /** `/statusline [reset]`: opens the list, or puts every field back; the notice to show, if there is one. */
  command(args: readonly string[]): string | undefined {
    const { locale } = this.o
    if (args.length > 1 || (args[0] !== undefined && args[0] !== 'reset'))
      return tt('statusline.usage', locale)
    if (args[0] === undefined) {
      this.show()
      return undefined
    }
    return tt(this.o.config.reset() ? 'statusline.reset' : 'statusline.resetUnsaved', locale)
  }

  close(): void {
    this.box = undefined
    this.o.changed()
  }

  invalidate(): void {
    this.box?.invalidate()
  }

  handleInput(data: string): boolean {
    if (!this.box) return false
    const key = parseKey(data, false)
    const action = actionFor('picker', key.name)
    if (action === 'picker-up') this.at = Math.max(0, this.at - 1)
    else if (action === 'picker-down') this.at = Math.min(STATUS_FIELDS.length - 1, this.at + 1)
    else if (action === 'picker-cancel') {
      this.close()
      return true
    } else if (action === 'picker-choose' || (key.name === 'char' && key.ch === ' ')) {
      const field = STATUS_FIELDS[this.at]
      if (field !== undefined) this.saved = this.o.config.toggle(field)
    }
    this.o.changed()
    return true
  }

  render(width: number): string[] {
    return this.box?.render(width) ?? []
  }
}
