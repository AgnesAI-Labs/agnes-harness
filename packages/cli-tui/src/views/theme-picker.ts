import type { Ansi } from '../ansi.js'
import type { Component } from '../component.js'
import { Box } from '../components/box.js'
import { Select } from '../components/select.js'
import type { TuiThemeName } from '../theme.js'

export class ThemePicker implements Component {
  private box: Box | undefined
  constructor(
    private readonly ansi: Ansi,
    private readonly choose: (name: TuiThemeName) => void,
  ) {}
  show(current: TuiThemeName): void {
    const names: TuiThemeName[] = ['light', 'dark', 'mono']
    const labels = ['明亮 · 白底深字', '深色 · 炭灰底浅字', '无色 · 终端默认色']
    const select = new Select({
      options: names.map((id, i) => ({ id, label: `${labels[i]}${id === current ? ' ✓ 当前' : ''}` })),
      onChoose: (id) => {
        this.close()
        this.choose(id as TuiThemeName)
      },
      onCancel: () => this.close(),
    })
    for (let i = 0; i < names.indexOf(current); i++) select.handleInput('\x1b[B')
    this.box = new Box(select, {
      title: '主题 · ↑↓ 选择 / Enter 确认 / Esc 取消',
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
