import type { UsageView } from '@agnes/protocol'
import { type Component, padLine } from '../component.js'
import type { StatusLineConfig } from '../statusline-config.js'
import type { ThemedAnsi } from '../theme.js'
import type { WorkspaceInfo } from '../workspace-info.js'
import { bottomRail, RAIL_MIN_WIDTH, topRail } from './composer-rail.js'

/**
 * Full-width composer as an open rail: four corners and no sides. The top edge carries the model,
 * workspace and context gauge; the bottom edge the thinking level and key hints.
 */
export class Composer implements Component {
  private usage: UsageView | undefined
  private workspace: WorkspaceInfo = { root: '', subpath: '' }

  constructor(
    private readonly editor: Component,
    private readonly ansi: ThemedAnsi,
    private readonly locale = 'en',
    private readonly fields?: Pick<StatusLineConfig, 'shows'>,
  ) {}

  setUsage(usage?: UsageView): void {
    this.usage = usage
  }

  setWorkspace(workspace: WorkspaceInfo): void {
    this.workspace = workspace
  }

  render(width: number): string[] {
    width = Math.max(1, Math.trunc(width))
    if (width < RAIL_MIN_WIDTH) return this.editor.render(width)
    const frameWidth = width - 1
    const inner = frameWidth - 4
    const state = { workspace: this.workspace, usage: this.usage, locale: this.locale, fields: this.fields }
    return [
      ` ${topRail(state, frameWidth, this.ansi)}`,
      ...this.editor.render(inner).map((line) => `   ${padLine(line, inner)}  `),
      ` ${bottomRail(state, frameWidth, this.ansi)}`,
    ]
  }

  handleInput(data: string): boolean {
    return this.editor.handleInput?.(data) ?? false
  }

  invalidate(): void {
    this.editor.invalidate()
  }
}
