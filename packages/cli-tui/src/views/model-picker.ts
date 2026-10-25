import type { ThinkingLevel } from '@agnes/protocol'
import type { ModelChoice } from '../commands.js'
import type { Component } from '../component.js'
import { type Box, dialogBox } from '../components/box.js'
import { FilterSelect } from '../components/filter-select.js'
import { Select } from '../components/select.js'
import { tt } from '../locale-extended.js'
import type { ThemedAnsi } from '../theme.js'

/** What the picker finally delivers — a model, and a thinking level only when the model has one. */
export type ModelSelection = { route: string; model: string; thinking?: ThinkingLevel }

const THINKING_FALLBACK: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high']

/** The thinking levels a model offers: its own map when it has one, otherwise the common four. */
export function thinkingLevelsOf(choice: Pick<ModelChoice, 'thinkingLevelMap'>): readonly ThinkingLevel[] {
  return choice.thinkingLevelMap && Object.keys(choice.thinkingLevelMap).length > 0
    ? (Object.keys(choice.thinkingLevelMap) as ThinkingLevel[])
    : THINKING_FALLBACK
}

/** Transient, connection-local model chooser. It owns all input while open and never writes UI rows. */
export class ModelPicker implements Component {
  private box: Box | undefined
  private choices: readonly ModelChoice[] = []

  constructor(
    private readonly o: {
      ansi: ThemedAnsi
      locale?: string
      maxRows(): number
      onChoose(choice: ModelSelection): void
      changed(): void
    },
  ) {}

  get open(): boolean {
    return this.box !== undefined
  }

  show(choices: readonly ModelChoice[]): void {
    this.choices = choices
    const byId = new Map(choices.map((choice) => [`${choice.route}/${choice.model}`, { ...choice }]))
    const select = new FilterSelect({
      options: [...byId.keys()].map((id) => ({ id, label: id })),
      locale: this.o.locale ?? 'en',
      ansi: this.o.ansi,
      maxRows: () => Math.max(1, this.o.maxRows() - 3),
      onChoose: (id) => {
        const choice = byId.get(id)
        if (!choice) return
        if (!choice.reasoning) {
          this.close()
          this.o.onChoose({ route: choice.route, model: choice.model })
          return
        }
        this.showThinking(choice)
      },
      onCancel: () => this.close(),
    })
    this.box = dialogBox(select, {
      title: tt('picker.modelTitle', this.o.locale ?? 'en'),
      ansi: this.o.ansi,
      hints: this.hints('dialog.close'),
    })
    this.o.changed()
  }

  /** Move, confirm, then the way out: Esc closes the model list but only steps back from the reasoning list. */
  private hints(out: 'dialog.close' | 'dialog.back') {
    const locale = this.o.locale ?? 'en'
    return [
      { key: '↑↓', label: tt('dialog.select', locale) },
      { key: '⏎', label: tt('dialog.confirm', locale) },
      { key: 'esc', label: tt(out, locale) },
    ]
  }

  private showThinking(choice: ModelChoice): void {
    const levels = thinkingLevelsOf(choice)
    const select = new Select({
      options: levels.map((level) => ({ id: level, label: level })),
      ansi: this.o.ansi,
      locale: this.o.locale ?? 'en',
      maxRows: () => Math.max(1, this.o.maxRows() - 3),
      onChoose: (id) => {
        this.close()
        this.o.onChoose({ route: choice.route, model: choice.model, thinking: id as ThinkingLevel })
      },
      // Esc here goes back to the model list, matching Codex's own "esc to go back" — only the
      // outermost (model-list) screen actually closes the picker.
      onCancel: () => this.show(this.choices),
    })
    this.box = dialogBox(select, {
      title: tt('picker.reasoningTitle', this.o.locale ?? 'en', {
        model: `${choice.route}/${choice.model}`,
      }),
      ansi: this.o.ansi,
      hints: this.hints('dialog.back'),
    })
    this.o.changed()
  }

  close(): void {
    if (!this.box) return
    this.box = undefined
    this.o.changed()
  }

  invalidate(): void {
    this.box?.invalidate()
  }

  handleInput(data: string): boolean {
    if (!this.box) return false
    this.box.handleInput(data)
    // While visible the chooser, rather than the editor or an older card, owns every key.
    return true
  }

  render(width: number): string[] {
    return this.box?.render(width) ?? []
  }
}
