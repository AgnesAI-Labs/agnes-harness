import type { Component } from '../component.js'
import { Box } from '../components/box.js'
import { FilterSelect } from '../components/filter-select.js'
import { tt } from '../locale-extended.js'
import type { ThemedAnsi, TuiThemeName } from '../theme.js'

export class ThemePicker implements Component {
  private box: Box | undefined
  constructor(
    private readonly ansi: ThemedAnsi,
    private readonly locale: string,
    private readonly choose: (name: TuiThemeName) => void,
  ) {}
  show(current: TuiThemeName): void {
    const locale = this.locale
    const names: TuiThemeName[] = ['light', 'dark', 'mono']
    const labels = [tt('theme.light', locale), tt('theme.dark', locale), tt('theme.mono', locale)]
    const select = new FilterSelect({
      options: names.map((id, i) => ({
        id,
        label: `${labels[i]}${id === current ? tt('theme.current', locale) : ''}`,
        search: id,
      })),
      locale,
      ansi: this.ansi,
      onChoose: (id) => {
        this.close()
        this.choose(id as TuiThemeName)
      },
      onCancel: () => this.close(),
    })
    for (let i = 0; i < names.indexOf(current); i++) select.handleInput('\x1b[B')
    this.box = new Box(select, {
      title: tt('theme.pickerTitle', locale),
      ansi: this.ansi,
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
