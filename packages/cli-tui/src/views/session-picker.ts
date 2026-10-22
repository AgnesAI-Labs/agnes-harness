import type { SessionChoice, SessionScopeView } from '../commands.js'
import { type Component, escapeControl } from '../component.js'
import { Box } from '../components/box.js'
import { FilterSelect } from '../components/filter-select.js'
import { fitLine } from '../components/line.js'
import { type ExtendedKey, tt } from '../locale-extended.js'
import type { ThemedAnsi } from '../theme.js'

const pad = (n: number): string => String(n).padStart(2, '0')

/** Last activity in the viewer's local time zone: the row's own time, not the session's creation. */
function label(choice: SessionChoice, locale: string): string {
  const parsed = Date.parse(choice.lastMessageAt ?? choice.createdAt)
  const at = new Date(parsed)
  const time = Number.isFinite(parsed)
    ? `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
    : tt('picker.timeUnknown', locale)
  return [
    time,
    choice.title?.trim(),
    choice.preset,
    choice.importFile === undefined ? `seq ${choice.lastSeq}` : undefined,
    choice.sessionId,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ')
}

/** Transient session chooser. It renders metadata only and returns the original immutable id. */
export class SessionPicker implements Component {
  private box: Box | undefined
  // Why the last Tab did not switch; shown under the list until the next show or close.
  private failure: string | undefined

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

  show(
    choices: readonly SessionChoice[],
    titleKey: ExtendedKey = 'picker.sessionTitle',
    scoped?: SessionScopeView,
    filter = '',
  ): void {
    this.failure = undefined
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
      ...(scoped
        ? {
            initialFilter: filter,
            emptyText: tt('picker.noSessions', this.o.locale ?? 'en'),
            onScope: (typed: string) => void this.switchScope(scoped, typed),
          }
        : {}),
    })
    this.box = new Box(select, {
      title: scoped
        ? `${tt(titleKey, this.o.locale ?? 'en')} · ${tt(scoped.scope === 'all' ? 'picker.scopeAll' : 'picker.scopeWorkspace', this.o.locale ?? 'en')}`
        : tt(titleKey, this.o.locale ?? 'en'),
      ansi: this.o.ansi,
    })
    this.o.changed()
  }

  // Tab: list the other scope again, keep what was typed, and keep the current list if that fails.
  private async switchScope(view: SessionScopeView, filter: string): Promise<void> {
    const scope = view.scope === 'all' ? 'workspace' : 'all'
    try {
      const choices = await view.reload(scope)
      if (this.box) this.show(choices, undefined, { ...view, scope }, filter)
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error)
      this.o.changed()
    }
  }

  close(): void {
    if (!this.box) return
    this.failure = undefined
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
    const rows = this.box?.render(width) ?? []
    return this.failure ? [...rows, fitLine(escapeControl(this.failure), width)] : rows
  }
}
