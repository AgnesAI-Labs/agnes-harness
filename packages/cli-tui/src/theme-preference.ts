import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { TuiThemeName } from './theme.js'

export function readTheme(path?: string): TuiThemeName {
  try {
    const name: unknown = JSON.parse(readFileSync(path ?? '', 'utf8')).theme
    return name === 'dark' || name === 'mono' ? name : 'light'
  } catch {
    return 'light'
  }
}

export function saveTheme(path: string | undefined, theme: TuiThemeName): boolean {
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
