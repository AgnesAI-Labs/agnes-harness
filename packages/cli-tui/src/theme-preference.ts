import { readPrefs, updatePrefs } from './prefs.js'
import type { TuiThemeName } from './theme.js'

/** What the user chose; `auto` follows the terminal background and is what no saved choice means. */
export type ThemePreference = TuiThemeName | 'auto'

export function readTheme(path?: string): ThemePreference {
  const name = readPrefs(path).theme
  return name === 'light' || name === 'mono' || name === 'dark' ? name : 'auto'
}

/** Saves the theme and leaves every other key of the preferences file as it was. */
export function saveTheme(path: string | undefined, theme: ThemePreference): boolean {
  return updatePrefs(path, { theme })
}
