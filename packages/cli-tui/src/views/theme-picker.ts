import { tt } from '../locale-extended.js'
import type { Ansi } from '../ansi.js'
import type { Component } from '../component.js'
import { Box } from '../components/box.js'
import { Select } from '../components/select.js'
import type { TuiThemeName } from '../theme.js'

export class ThemePicker implements Component {
  private box: Box | undefined
  constructor(
    private readonly ansi: Ansi,
    private readonly locale: string,
    private readonly choose: (name: TuiThemeName) => void,
  ) {}
  show(current: TuiThemeName): void {
    const locale = this.locale
    const names: TuiThemeName[] = ['light', 'dark', 'mono']
    const labels = [tt('theme.light', locale), tt('theme.dark', locale), tt('theme.mono', locale)]
    const select = new Select({
      options: names.map((id, i) => ({ id, label: `${labels[i]}${id === current ? tt('theme.current', locale) : ''}` })),
      onChoose: (id) => {
        this.close()
        this.choose(id as TuiThemeName)
      },
      onCancel: () => this.close(),
    })
    for (let i = 0; i < names.indexOf(current); i++) select.handleInput('\x1b[B')
    this.box = new Box(select, {
      title: tt('theme.pickerTitle', locale),
      rounded: true,
      border: this.ansi.dim,
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
