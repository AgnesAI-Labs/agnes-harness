import type { SessionChoice } from '../commands.js'
import type { Component } from '../component.js'
import { Box } from '../components/box.js'
import { FilterSelect } from '../components/filter-select.js'
import { type ExtendedKey, tt } from '../locale-extended.js'
import type { ThemedAnsi } from '../theme.js'

function label(choice: SessionChoice, locale: string): string {
  const parsed = Date.parse(choice.createdAt)
  const time = Number.isFinite(parsed)
    ? `${new Date(parsed).toISOString().slice(0, 16).replace('T', ' ')}Z`
    : tt('picker.timeUnknown', locale)
  return [time, choice.title?.trim(), choice.preset, `seq ${choice.lastSeq}`, choice.sessionId]
    .filter((part): part is string => Boolean(part))
    .join(' · ')
}

/** Transient session chooser. It renders metadata only and returns the original immutable id. */
export class SessionPicker implements Component {
  private box: Box | undefined

  constructor(
    private readonly o: {
      ansi: ThemedAnsi
      locale?: string
      maxRows(): number
      onChoose(choice: SessionChoice): void
      changed(): void
    },
  ) {}

  get open(): boolean {
    return this.box !== undefined
  }

  show(choices: readonly SessionChoice[], titleKey: ExtendedKey = 'picker.sessionTitle'): void {
    // A rewind row is one turn of the same session, so its key carries the boundary.
    const keyOf = (choice: SessionChoice): string =>
      choice.forkAt === undefined ? choice.sessionId : `${choice.sessionId}@${choice.forkAt}`
    const byId = new Map(choices.map((choice) => [keyOf(choice), structuredClone(choice)]))
    const select = new FilterSelect({
      options: [...byId.entries()].map(([id, choice]) => {
        const text = label(choice, this.o.locale ?? 'en')
        return { id, label: text, search: `${text} ${choice.sessionId}` }
      }),
      locale: this.o.locale ?? 'en',
      ansi: this.o.ansi,
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
      title: tt(titleKey, this.o.locale ?? 'en'),
      ansi: this.o.ansi,
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
