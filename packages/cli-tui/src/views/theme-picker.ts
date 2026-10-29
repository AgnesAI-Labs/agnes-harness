import type { Component } from '../component.js'
import { type Box, dialogBox } from '../components/box.js'
import { FilterSelect } from '../components/filter-select.js'
import { tt } from '../locale-extended.js'
import type { ThemedAnsi } from '../theme.js'
import type { ThemePreference } from '../theme-preference.js'

export class ThemePicker implements Component {
  private box: Box | undefined
  constructor(
    private readonly ansi: ThemedAnsi,
    private readonly locale: string,
    private readonly choose: (name: ThemePreference) => void,
  ) {}
  /** The built-in themes, then `custom` (the names of the user's theme files). */
  show(current: ThemePreference, custom: readonly string[] = []): void {
    const locale = this.locale
    const names: ThemePreference[] = [
      'auto',
      'light',
      'dark',
      'dark-daltonized',
      'light-daltonized',
      'mono',
      ...custom.map((n) => `custom:${n}` as const),
    ]
    const labels = [
      tt('theme.auto', locale),
      tt('theme.light', locale),
      tt('theme.dark', locale),
      tt('theme.darkDaltonized', locale),
      tt('theme.lightDaltonized', locale),
      tt('theme.mono', locale),
      ...custom.map((name) => tt('theme.custom', locale, { name })),
    ]
    const select = new FilterSelect({
      // A built-in name is `Name · what it looks like`: the second half goes in the description column.
      // A custom one is `Custom · <file>`, whose file name is the name itself and stays whole.
      options: names.map((id, i) => {
        const text = labels[i] ?? id
        const [label = id, description] = id.startsWith('custom:') ? [text] : text.split(' · ')
        return {
          id,
          label,
          ...(description ? { description } : {}),
          ...(id === current ? { current: true } : {}),
          search: id,
        }
      }),
      locale,
      ansi: this.ansi,
      onChoose: (id) => {
        this.close()
        this.choose(id as ThemePreference)
      },
      onCancel: () => this.close(),
    })
    for (let i = 0; i < names.indexOf(current); i++) select.handleInput('\x1b[B')
    this.box = dialogBox(select, {
      title: tt('theme.pickerTitle', locale),
      ansi: this.ansi,
      hints: [
        { key: '↑↓', label: tt('dialog.select', locale) },
        { key: '⏎', label: tt('dialog.confirm', locale) },
        { key: 'esc', label: tt('dialog.close', locale) },
      ],
    })
  }
  close(): void {
    this.box = undefined
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
