import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** The TUI preferences file: one small JSON object that the theme, the status line and the window title share. */
export type Prefs = Record<string, unknown>

/** The file's keys; `{}` when there is no path, no file, or what is there is not a JSON object. */
export function readPrefs(path?: string): Prefs {
  try {
    const value: unknown = JSON.parse(readFileSync(path ?? '', 'utf8').replace(/^\uFEFF/, ''))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Prefs) : {}
  } catch {
    return {}
  }
}

/**
 * Reads the file again, lays `patch` over what it holds (a key set to `undefined` is removed) and
 * writes the result through a temporary file and a rename, so a reader never sees half a file and
 * a key this caller does not know about is never dropped. False when nothing could be written, including
 * when the file exists but cannot be read as an object.
 */
export function updatePrefs(path: string | undefined, patch: Prefs): boolean {
  if (!path) return false
  // A file that exists but is not a JSON object (a hand edit left a trailing comma) is never replaced:
  // writing only the patch would silently drop every other setting. The caller reports "not saved".
  let current: Prefs = {}
  try {
    // An empty file (a `touch`, an interrupted editor save) holds no settings to lose.
    const text = readFileSync(path, 'utf8')
      .replace(/^\uFEFF/, '')
      .trim()
    const value: unknown = text ? JSON.parse(text) : {}
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    current = value as Prefs
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
  }
  const merged: Prefs = { ...current, ...patch }
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key]
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(merged)}\n`, { mode: 0o600 })
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
