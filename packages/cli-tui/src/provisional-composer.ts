import { createAnsi } from './ansi.js'
import { type Component, escapeControl } from './component.js'
import { Editor } from './editor.js'
import { parseKey } from './keys.js'
import type { Locale } from './locale.js'
import { tt } from './locale-extended.js'
import { Renderer } from './renderer.js'
import type { Terminal } from './terminal.js'
import { resolveAuto } from './terminal-background.js'
import { TuiTheme } from './theme.js'
import { readTheme } from './theme-preference.js'
import { Composer } from './views/composer.js'
import { StatusBar } from './views/status-bar.js'
import { tildePath } from './workspace-info.js'

/**
 * The composer drawn while the daemon connects and the session opens. It takes typing and keeps the
 * draft, but nothing it holds can be sent: Enter says so and leaves the text where it is. `release`
 * hands the draft to the real TuiApp without leaving the alternate screen; `abandon` gives the
 * terminal back and returns the draft so a failed start can print it instead of swallowing it.
 */
export class ProvisionalComposer {
  private readonly editor: Editor
  private readonly status: StatusBar
  private readonly renderer: Renderer
  private readonly theme: TuiTheme
  private readonly followBackground: boolean

  constructor(
    private readonly term: Terminal,
    private readonly o: {
      locale: Locale
      cwd: string
      themePreferencePath?: string
      /** Ctrl-C, or Ctrl-D on an empty draft: the user gave up waiting. */
      onInterrupt(): void
    },
  ) {
    const preference = readTheme(o.themePreferencePath)
    this.followBackground = preference === 'auto'
    const theme = new TuiTheme(preference === 'auto' ? resolveAuto(term.background) : preference)
    this.theme = theme
    const ansi = theme.ansi(createAnsi(term.caps.color))
    this.status = new StatusBar(ansi, o.locale)
    this.status.setNotice(tt('app.connecting', o.locale))
    this.editor = new Editor({
      maxRows: () => Math.max(1, Math.floor(term.size().rows / 3)),
      placeholder: tt('app.composerPlaceholder', o.locale),
      locale: o.locale,
      ansi,
      onSubmit: (text) => {
        // The editor has already cleared itself; the draft stays, and only a notice answers Enter.
        this.editor.setText(text)
        this.status.setNotice(tt('app.connectingHold', o.locale), 'warning')
      },
    })
    this.editor.setKitty(term.caps.kittyKeyboard)
    const composer = new Composer(this.editor, ansi, o.locale)
    composer.setWorkspace({ root: tildePath(o.cwd), subpath: '' })
    const root: Component = {
      invalidate: () => this.editor.invalidate(),
      // The input area sits on the bottom edge, as it does once the session is open.
      render: (width) => {
        const below = [...composer.render(width), ...this.status.render(width)]
        const gap = Math.max(0, term.size().rows - below.length)
        return theme.frame(
          createAnsi(term.caps.color),
          [...Array.from({ length: gap }, () => ''), ...below],
          width,
          term.size().rows,
        )
      },
      handleInput: (data) => {
        const key = parseKey(data, term.caps.kittyKeyboard).name
        if (key === 'ctrl-c' || (key === 'ctrl-d' && !this.editor.text)) {
          o.onInterrupt()
          return true
        }
        return composer.handleInput(data)
      },
    }
    this.renderer = new Renderer(term, root)
  }

  /** Draws the first frame and starts reading keys. */
  start(): void {
    this.renderer.start()
    // The first frame uses COLORFGBG; the terminal's own answer, if it comes within 100 ms, restyles it.
    if (this.followBackground)
      void this.term.queryBackground?.().then((background) => {
        if (resolveAuto(background) === this.theme.name) return
        this.theme.set(resolveAuto(background))
        this.editor.invalidate()
        this.renderer.requestRender()
      })
  }

  /** What Enter would send, paste chips expanded. */
  get draft(): string {
    return this.editor.expanded()
  }

  /** Stops reading keys and drawing, leaving the screen for the app that takes over; returns the draft. */
  release(): string {
    const draft = this.draft
    this.renderer.release()
    return draft
  }

  /** Gives the terminal back and says what was typed, for a start that failed or was interrupted. */
  abandon(): string | undefined {
    const draft = this.draft
    this.renderer.stop()
    return draft.trim() ? tt('app.unsentDraft', this.o.locale, { draft: escapeControl(draft) }) : undefined
  }
}
