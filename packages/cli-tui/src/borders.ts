import { tt } from './locale-extended.js'
import { readPrefs, updatePrefs } from './prefs.js'

/** Which glyphs the frame is drawn with: the Unicode ones, or the ASCII look of every glyph in `glyphs.ts`. */
export const BORDER_MODES = ['unicode', 'ascii'] as const
export type BorderMode = (typeof BORDER_MODES)[number]

/**
 * `/borders unicode|ascii`, kept under the `borders` key of the preferences file. With nothing saved the
 * Linux console (`TERM=linux`), which has no glyph for most of them, starts in ascii and everything else in unicode.
 */
export class Borders {
  mode: BorderMode

  constructor(
    private readonly o: {
      path?: string | undefined
      env?: Readonly<Record<string, string | undefined>>
      /** The mode changed: the screen is drawn again from scratch. */
      changed?: () => void
    },
  ) {
    const saved = readPrefs(o.path).borders
    this.mode = BORDER_MODES.find((mode) => mode === saved) ?? (o.env?.TERM === 'linux' ? 'ascii' : 'unicode')
  }

  get ascii(): boolean {
    return this.mode === 'ascii'
  }

  /** `/borders [unicode|ascii]`: sets and saves the mode, or says which one is in force. */
  command(args: readonly string[], locale: string): string {
    const [arg] = args
    const mode = BORDER_MODES.find((m) => m === arg)
    if (args.length > 1 || (arg !== undefined && mode === undefined)) return tt('borders.usage', locale)
    if (mode === undefined) return `${tt(`borders.${this.mode}`, locale)} · ${tt('borders.usage', locale)}`
    this.mode = mode
    this.o.changed?.()
    const saved = updatePrefs(this.o.path, { borders: mode })
    return `${tt(`borders.${mode}`, locale)}${saved ? '' : tt('borders.unsaved', locale)}`
  }
}
