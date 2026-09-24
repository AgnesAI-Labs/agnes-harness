import type { ThinkingLevel } from '@agnes/protocol'
import type { Ansi } from '../ansi.js'
import type { ModelChoice } from '../commands.js'
import type { Component } from '../component.js'
import { Box } from '../components/box.js'
import { Select } from '../components/select.js'

/** What the picker finally delivers — a model, and a thinking level only when the model has one. */
export type ModelSelection = { route: string; model: string; thinking?: ThinkingLevel }

const THINKING_FALLBACK: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high']

/** Transient, connection-local model chooser. It owns all input while open and never writes UI rows. */
export class ModelPicker implements Component {
  private box: Box | undefined
  private choices: readonly ModelChoice[] = []

  constructor(
    private readonly o: {
      ansi: Ansi
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
    const select = new Select({
      options: [...byId.keys()].map((id) => ({ id, label: id })),
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
    this.box = new Box(select, {
      title: 'Select Model',
      rounded: true,
      border: this.o.ansi.dim,
      titleStyle: (text) => this.o.ansi.bold(text),
    })
    this.o.changed()
  }

  private showThinking(choice: ModelChoice): void {
    const levels: readonly ThinkingLevel[] =
      choice.thinkingLevelMap && Object.keys(choice.thinkingLevelMap).length > 0
        ? (Object.keys(choice.thinkingLevelMap) as ThinkingLevel[])
        : THINKING_FALLBACK
    const select = new Select({
      options: levels.map((level) => ({ id: level, label: level })),
      maxRows: () => Math.max(1, this.o.maxRows() - 3),
      onChoose: (id) => {
        this.close()
        this.o.onChoose({ route: choice.route, model: choice.model, thinking: id as ThinkingLevel })
      },
      // Esc here goes back to the model list, matching Codex's own "esc to go back" — only the
      // outermost (model-list) screen actually closes the picker.
      onCancel: () => this.show(this.choices),
    })
    this.box = new Box(select, {
      title: `Select Reasoning Level for ${choice.route}/${choice.model}`,
      rounded: true,
      border: this.o.ansi.dim,
      titleStyle: (text) => this.o.ansi.bold(text),
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
