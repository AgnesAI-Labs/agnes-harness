import type { SessionChoice, SessionScopeView } from '../commands.js'
import { type Component, escapeControl } from '../component.js'
import { type Box, dialogBox } from '../components/box.js'
import { FilterSelect } from '../components/filter-select.js'
import { fitLine } from '../components/line.js'
import { type ExtendedKey, tt } from '../locale-extended.js'
import type { ThemedAnsi } from '../theme.js'

const pad = (n: number): string => String(n).padStart(2, '0')

/** Last activity in the viewer's local time zone: the row's own time, not the session's creation. */
function absolute(parsed: number, locale: string): string {
  const at = new Date(parsed)
  return Number.isFinite(parsed)
    ? `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
    : tt('picker.timeUnknown', locale)
}

/** `3h ago` for the last month, the local date after that; a future or unreadable time falls back to the absolute one. */
function relative(parsed: number, now: number, locale: string): string {
  const minutes = Math.floor((now - parsed) / 60_000)
  if (!Number.isFinite(parsed) || minutes < 0 || minutes >= 30 * 1440) return absolute(parsed, locale)
  if (minutes < 1) return tt('dialog.ago.now', locale)
  if (minutes < 60) return tt('dialog.ago.minutes', locale, { n: minutes })
  if (minutes < 1440) return tt('dialog.ago.hours', locale, { n: Math.floor(minutes / 60) })
  return tt('dialog.ago.days', locale, { n: Math.floor(minutes / 1440) })
}

/** The row: the title, with how long ago and the preset beside it. The id and seq stay searchable, not shown. */
function row(choice: SessionChoice, locale: string, now: number) {
  const parsed = Date.parse(choice.lastMessageAt ?? choice.createdAt)
  const title = choice.title?.trim()
  return {
    label: title || tt('dialog.untitled', locale),
    description: [relative(parsed, now, locale), choice.preset].filter(Boolean).join(' · '),
    search: [
      absolute(parsed, locale),
      title,
      choice.preset,
      choice.importFile === undefined ? `seq ${choice.lastSeq}` : undefined,
      choice.sessionId,
    ]
      .filter(Boolean)
      .join(' '),
  }
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
      /** The clock the relative times count from; the wall clock when left out. */
      now?(): number
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
      options: [...byId.entries()].map(([id, choice]) => ({
        id,
        ...row(choice, this.o.locale ?? 'en', (this.o.now ?? Date.now)()),
      })),
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
    const locale = this.o.locale ?? 'en'
    this.box = dialogBox(select, {
      // Which scope the list shows is part of the title; Tab names the other one in the hints.
      title: scoped
        ? `${tt(titleKey, locale)} · ${tt(scoped.scope === 'all' ? 'picker.scopeAll' : 'picker.scopeWorkspace', locale)}`
        : tt(titleKey, locale),
      ansi: this.o.ansi,
      hints: [
        { key: '↑↓', label: tt('dialog.select', locale) },
        { key: '⏎', label: tt('dialog.confirm', locale) },
        ...(scoped
          ? [
              {
                key: 'tab',
                label: tt(scoped.scope === 'all' ? 'dialog.tabWorkspace' : 'dialog.tabAll', locale),
              },
            ]
          : []),
        { key: 'esc', label: tt('dialog.close', locale) },
      ],
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
