import { customName } from './custom-theme.js'
import { type DaltonizedName, isDaltonized } from './palette.js'
import { readPrefs, updatePrefs } from './prefs.js'
import type { TuiThemeName } from './theme.js'

/** What the user chose; `auto` follows the terminal background and is what no saved choice means. `custom:<name>` is a file in tui-themes/. */
export type ThemePreference = TuiThemeName | DaltonizedName | 'auto' | `custom:${string}`

export function readTheme(path?: string): ThemePreference {
  const name = readPrefs(path).theme
  if (typeof name === 'string' && customName(name) !== undefined) return name as ThemePreference
  if (typeof name === 'string' && isDaltonized(name)) return name
  return name === 'light' || name === 'mono' || name === 'dark' ? name : 'auto'
}

/** Saves the theme and leaves every other key of the preferences file as it was. */
export function saveTheme(path: string | undefined, theme: ThemePreference): boolean {
  return updatePrefs(path, { theme })
}
