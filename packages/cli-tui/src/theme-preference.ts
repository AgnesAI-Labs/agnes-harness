import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { TuiThemeName } from './theme.js'

/** What the user chose; `auto` follows the terminal background and is what no saved choice means. */
export type ThemePreference = TuiThemeName | 'auto'

export function readTheme(path?: string): ThemePreference {
  try {
    const name: unknown = JSON.parse(readFileSync(path ?? '', 'utf8')).theme
    return name === 'light' || name === 'mono' || name === 'dark' ? name : 'auto'
  } catch {
    return 'auto'
  }
}

export function saveTheme(path: string | undefined, theme: ThemePreference): boolean {
  if (!path) return false
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify({ theme })}\n`, { mode: 0o600 })
    renameSync(temporary, path)
    return true
  } catch {
    return false
  } finally {
    try {
      rmSync(temporary, { force: true })
    } catch {
      /* Best-effort temporary cleanup. */
    }
  }
}
