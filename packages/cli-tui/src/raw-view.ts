import { tt } from './locale-extended.js'
import type { ScreenRenderer } from './renderer.js'
import type { TuiTheme } from './theme.js'
import type { StatusBar } from './views/status-bar.js'

/**
 * `/raw`: the copy-friendly view, for this run only. Mouse reporting goes off so the terminal selects text
 * itself; views read `theme.raw` and leave out the bars, rails and shading a copy would carry along; the
 * status bar says RAW. Switching it off puts the mouse back the way it was, and redraws the conversation.
 */
export class RawView {
  private mouseWas = false

  constructor(
    private readonly o: {
      theme: TuiTheme
      renderer: ScreenRenderer
      statusBar: Pick<StatusBar, 'setRaw'>
      /** Draws the conversation again with the views now in force. */
      refresh(): void
    },
  ) {}

  get on(): boolean {
    return this.o.theme.raw
  }

  toggle(locale: string): string {
    const on = !this.on
    if (on) this.mouseWas = this.o.renderer.mouseReporting
    this.o.theme.raw = on
    this.o.renderer.setMouse(on ? false : this.mouseWas)
    this.o.statusBar.setRaw(on)
    this.o.refresh()
    return tt(on ? 'raw.on' : 'raw.off', locale)
  }
}
