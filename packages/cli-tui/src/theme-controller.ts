import type { Ansi } from './ansi.js'
import { tt } from './locale-extended.js'
import type { Terminal } from './terminal.js'
import { resolveAuto } from './terminal-background.js'
import { TuiTheme } from './theme.js'
import { readTheme, saveTheme, type ThemePreference } from './theme-preference.js'
import { ThemePicker } from './views/theme-picker.js'

/**
 * The session's theme: the choice the user made, the picker that changes it and the terminal's own
 * background answer that `auto` follows. Changing it repaints through `repaint`; nothing else is touched.
 */
export class ThemeController {
  readonly theme: TuiTheme
  readonly picker: ThemePicker
  private preference: ThemePreference

  constructor(
    private readonly o: {
      term: Pick<Terminal, 'background' | 'queryBackground'>
      path: string | undefined
      locale: string
      repaint: () => void
      notice: (text: string) => void
      /** The colour tier's escapes, which the theme this controller owns resolves tones against. */
      base: Ansi
    },
  ) {
    this.preference = readTheme(o.path)
    this.theme = new TuiTheme(this.resolve(this.preference))
    this.picker = new ThemePicker(this.theme.ansi(o.base), o.locale, (name) => o.notice(this.set(name)))
  }

  private resolve(preference: ThemePreference) {
    return preference === 'auto' ? resolveAuto(this.o.term.background) : preference
  }

  show(): void {
    this.picker.show(this.preference)
  }

  /** Changes local presentation and persists the preference without touching session data. */
  set(preference: ThemePreference): string {
    this.picker.close()
    this.preference = preference
    this.restyle(this.resolve(preference))
    return saveTheme(this.o.path, preference)
      ? tt('app.themeSaved', this.o.locale, { name: preference })
      : tt('app.themeEphemeral', this.o.locale, { name: preference })
  }

  private restyle(name: TuiTheme['name']): void {
    this.theme.set(name)
    this.o.repaint()
  }

  /** `auto` takes the terminal's own answer when it comes; a choice made meanwhile wins. */
  follow(): void {
    if (this.preference !== 'auto') return
    void this.o.term.queryBackground?.().then((background) => {
      if (this.preference === 'auto' && resolveAuto(background) !== this.theme.name)
        this.restyle(resolveAuto(background))
    })
  }
}
