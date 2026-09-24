import type { Ansi } from '../ansi.js'
import type { SessionChoice } from '../commands.js'
import type { Component } from '../component.js'
import { Box } from '../components/box.js'
import { Select } from '../components/select.js'

function label(choice: SessionChoice): string {
  const parsed = Date.parse(choice.createdAt)
  const time = Number.isFinite(parsed)
    ? `${new Date(parsed).toISOString().slice(0, 16).replace('T', ' ')}Z`
    : 'time unknown'
  return [time, choice.title?.trim(), choice.preset, `seq ${choice.lastSeq}`, choice.sessionId]
    .filter((part): part is string => Boolean(part))
    .join(' · ')
}

/** Transient session chooser. It renders metadata only and returns the original immutable id. */
export class SessionPicker implements Component {
  private box: Box | undefined

  constructor(
    private readonly o: {
      ansi: Ansi
      maxRows(): number
      onChoose(choice: SessionChoice): void
      changed(): void
    },
  ) {}

  get open(): boolean {
    return this.box !== undefined
  }

  show(choices: readonly SessionChoice[]): void {
    const byId = new Map(choices.map((choice) => [choice.sessionId, structuredClone(choice)]))
    const select = new Select({
      options: [...byId.values()].map((choice) => ({ id: choice.sessionId, label: label(choice) })),
      maxRows: () => Math.max(1, this.o.maxRows() - 3),
      onChoose: (id) => {
        const choice = byId.get(id)
        if (!choice) return
        this.close()
        this.o.onChoose(choice)
      },
      onCancel: () => this.close(),
    })
    this.box = new Box(select, {
      title: 'Select Session',
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
    return true
  }

  render(width: number): string[] {
    return this.box?.render(width) ?? []
  }
}
