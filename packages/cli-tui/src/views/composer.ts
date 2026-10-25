import type { UsageView } from '@agnes/protocol'
import { ANSI_RE, CURSOR_MARKER } from '../ansi.js'
import { type Component, padLine } from '../component.js'
import { tt } from '../locale-extended.js'
import type { StatusLineConfig } from '../statusline-config.js'
import { displayWidth } from '../terminal.js'
import type { ThemedAnsi } from '../theme.js'
import type { WorkspaceInfo } from '../workspace-info.js'
import { bottomRail, RAIL_MIN_WIDTH, type RailState, topRail } from './composer-rail.js'

/**
 * Full-width composer as an open rail: four corners and no sides. The top edge carries the model,
 * workspace and context gauge; the bottom edge the thinking level and key hints.
 */
export class Composer implements Component {
  private usage: UsageView | undefined
  private workspace: WorkspaceInfo = { root: '', subpath: '' }

  constructor(
    private readonly editor: Component & { readonly vimBadge?: RailState['mode'] },
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
    const state: RailState = {
      workspace: this.workspace,
      usage: this.usage,
      locale: this.locale,
      fields: this.fields,
      mode: this.editor.vimBadge,
    }
    return [
      ` ${topRail(state, frameWidth, this.ansi)}`,
      ...this.marked(this.editor.render(inner), inner).map((line) => `   ${padLine(line, inner)}  `),
      ` ${bottomRail(state, frameWidth, this.ansi)}`,
    ]
  }

  /** An empty prompt shows the placeholder cut to the row; say so with `…` instead of ending mid-word. */
  private marked(rows: string[], inner: number): string[] {
    const placeholder = tt('app.composerPlaceholder', this.locale)
    const first = rows[0]
    if (rows.length !== 1 || first === undefined) return rows
    const shown = first.replace(ANSI_RE, '').replaceAll(CURSOR_MARKER, '').slice(2).trimEnd()
    if (shown === '' || shown.length >= placeholder.length || !placeholder.startsWith(shown)) return rows
    const kept = displayWidth(shown) + 1 <= inner - 2 ? shown : Array.from(shown).slice(0, -1).join('')
    return [first.replace(shown, `${kept}…`)]
  }

  handleInput(data: string): boolean {
    return this.editor.handleInput?.(data) ?? false
  }

  invalidate(): void {
    this.editor.invalidate()
  }
}
