import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DALTONIZED, isDaltonized, PALETTE, type Tone } from './palette.js'
import { type Background, resolveAuto } from './terminal-background.js'
import type { TuiThemeName } from './theme.js'

/** A user theme: one of the built-in palettes with some of its tones replaced. */
export type CustomTheme = { base: 'light' | 'dark'; tones: Partial<Record<Tone, string>> }

export type ThemeProblem = {
  code: 'name' | 'missing' | 'symlink' | 'size' | 'json' | 'shape' | 'unknownKey' | 'badValue' | 'extends'
  detail?: string
}

export const CUSTOM_PREFIX = 'custom:'
export const MAX_THEME_BYTES = 8 * 1024
const NAME = /^[a-z0-9-]{1,32}$/
const HEX = /^#[0-9a-fA-F]{6}$/
const TONES: ReadonlySet<string> = new Set(Object.keys(PALETTE.dark))

/** The folder of user themes, beside the preferences file. */
export const themesDir = (prefsPath: string): string => join(dirname(prefsPath), 'tui-themes')

/** The theme name inside a `custom:<name>` preference; undefined for anything else, a bad name included. */
export function customName(preference: string): string | undefined {
  const name = preference.startsWith(CUSTOM_PREFIX) ? preference.slice(CUSTOM_PREFIX.length) : undefined
  return name !== undefined && NAME.test(name) ? name : undefined
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * Reads `<dir>/<name>.json`. The whole file is refused for the first thing wrong with it, so a theme
 * is never half applied: a name outside `[a-z0-9-]{1,32}` (nothing is joined to a path before it
 * passes), a symbolic link, a file over 8 KB, bad JSON, a key that is not `extends` or `tones`, a
 * tone the palette does not have, or a value that is not `#rrggbb`.
 */
export function loadCustomTheme(
  dir: string,
  name: string,
): { theme: CustomTheme } | { problem: ThemeProblem } {
  if (!NAME.test(name)) return { problem: { code: 'name' } }
  let text: string
  try {
    // ponytail: lstat then read is two steps; a link swapped in between is read once. Fine for a file the user owns.
    if (lstatSync(dir).isSymbolicLink()) return { problem: { code: 'symlink' } }
    const file = join(dir, `${name}.json`)
    const stat = lstatSync(file)
    if (stat.isSymbolicLink()) return { problem: { code: 'symlink' } }
    if (!stat.isFile()) return { problem: { code: 'missing' } }
    if (stat.size > MAX_THEME_BYTES) return { problem: { code: 'size' } }
    text = readFileSync(file, 'utf8')
  } catch {
    return { problem: { code: 'missing' } }
  }
  if (Buffer.byteLength(text) > MAX_THEME_BYTES) return { problem: { code: 'size' } }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { problem: { code: 'json' } }
  }
  if (!isObject(value)) return { problem: { code: 'shape' } }
  for (const key of Object.keys(value))
    if (key !== 'extends' && key !== 'tones') return { problem: { code: 'unknownKey', detail: key } }
  const base = value.extends ?? 'dark'
  if (base !== 'dark' && base !== 'light') return { problem: { code: 'extends' } }
  const given = value.tones ?? {}
  if (!isObject(given)) return { problem: { code: 'shape' } }
  const tones: Partial<Record<Tone, string>> = {}
  for (const [tone, colour] of Object.entries(given)) {
    if (!TONES.has(tone)) return { problem: { code: 'unknownKey', detail: tone } }
    if (typeof colour !== 'string' || !HEX.test(colour))
      return { problem: { code: 'badValue', detail: tone } }
    tones[tone as Tone] = colour.toLowerCase()
  }
  return { theme: { base, tones } }
}

/** The names the picker offers: every `<name>.json` regular file whose name is allowed, in order. */
export function listCustomThemes(dir: string): string[] {
  try {
    if (lstatSync(dir).isSymbolicLink()) return []
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.json') && NAME.test(e.name.slice(0, -5)))
      .map((e) => e.name.slice(0, -5))
      .sort()
  } catch {
    return []
  }
}

export type ResolvedTheme = { name: TuiThemeName; tones?: CustomTheme['tones'] }

/** What a saved or chosen preference looks like now: a built-in name, or a custom theme read from `path`'s folder. */
export function resolvePreference(
  preference: string,
  path: string | undefined,
  background: Background | undefined,
): ResolvedTheme | { problem: ThemeProblem } {
  if (preference === 'auto') return { name: resolveAuto(background) }
  if (isDaltonized(preference))
    return { name: DALTONIZED[preference].base, tones: DALTONIZED[preference].tones }
  if (!preference.startsWith(CUSTOM_PREFIX)) return { name: preference as TuiThemeName }
  const name = customName(preference)
  if (name === undefined) return { problem: { code: 'name' } }
  if (!path) return { problem: { code: 'missing' } }
  const loaded = loadCustomTheme(themesDir(path), name)
  return 'problem' in loaded ? loaded : { name: loaded.theme.base, tones: loaded.theme.tones }
}
