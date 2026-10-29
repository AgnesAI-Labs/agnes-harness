import type { Ansi } from './ansi.js'
import { listCustomThemes, resolvePreference, type ThemeProblem, themesDir } from './custom-theme.js'
import { tt } from './locale-extended.js'
import type { Terminal } from './terminal.js'
import { resolveAuto } from './terminal-background.js'
import { TuiTheme } from './theme.js'
import { readTheme, saveTheme, type ThemePreference } from './theme-preference.js'
import { ThemePicker } from './views/theme-picker.js'

/**
 * The session's theme: the choice the user made, the picker that changes it and the terminal's own
 * background answer that `auto` follows. Changing it repaints through `repaint`; nothing else is touched.
 * A custom theme (`custom:<name>`, see custom-theme.ts) that cannot be loaded is refused whole: the
 * session keeps the theme it had, or starts on `auto` and says so once.
 */
export class ThemeController {
  readonly theme: TuiTheme
  readonly picker: ThemePicker
  private preference: ThemePreference
  private startupNotice: string | undefined

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
    const saved = readTheme(o.path)
    const resolved = resolvePreference(saved, o.path, o.term.background)
    this.preference = saved
    if ('problem' in resolved) {
      this.preference = 'auto'
      this.startupNotice = tt('theme.fellBack', o.locale, {
        name: saved,
        reason: this.reason(resolved.problem),
      })
    }
    const { name, tones } =
      'problem' in resolved ? { name: resolveAuto(o.term.background), tones: undefined } : resolved
    this.theme = new TuiTheme(name, tones)
    this.picker = new ThemePicker(this.theme.ansi(o.base), o.locale, (choice) => o.notice(this.set(choice)))
  }

  private reason(problem: ThemeProblem): string {
    return tt(`theme.problem.${problem.code}`, this.o.locale, { detail: problem.detail ?? '' })
  }

  /** The saved choice (`auto`, a built-in name or `custom:<name>`), read by `/config`. */
  get current(): ThemePreference {
    return this.preference
  }

  show(): void {
    this.picker.show(this.preference, this.o.path ? listCustomThemes(themesDir(this.o.path)) : [])
  }

  /** Changes local presentation and persists the preference without touching session data. */
  set(preference: ThemePreference): string {
    this.picker.close()
    const resolved = resolvePreference(preference, this.o.path, this.o.term.background)
    if ('problem' in resolved)
      return tt('theme.rejected', this.o.locale, { name: preference, reason: this.reason(resolved.problem) })
    this.preference = preference
    this.restyle(resolved.name, resolved.tones)
    return saveTheme(this.o.path, preference)
      ? tt('app.themeSaved', this.o.locale, { name: preference })
      : tt('app.themeEphemeral', this.o.locale, { name: preference })
  }

  private restyle(name: TuiTheme['name'], tones?: Parameters<TuiTheme['set']>[1]): void {
    this.theme.set(name, tones)
    this.o.repaint()
  }

  /** Called once the app is up: says why a saved custom theme was not used, then lets `auto` follow the terminal. */
  follow(): void {
    if (this.startupNotice) this.o.notice(this.startupNotice)
    this.startupNotice = undefined
    if (this.preference !== 'auto') return
    void this.o.term.queryBackground?.().then((background) => {
      if (this.preference === 'auto' && resolveAuto(background) !== this.theme.name)
        this.restyle(resolveAuto(background))
    })
  }
}
