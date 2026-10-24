/**
 * Pure theme preference logic: read, write, resolve and apply.
 *
 * The DOM surface is deliberately limited to `classList` for tests without a DOM.
 * The stylesheet owns `color-scheme` through `:root` / `.dark` to avoid a first-frame race.
 */

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

/**
 * Applying a theme only needs to toggle a class, not the full `DOMTokenList`.
 * The smaller surface makes testing without a DOM easier.
 */
export type ThemeRoot = { classList: { toggle(token: string, force?: boolean): void } }

export const THEME_STORAGE_KEY = 'agnes-theme'

const PREFERENCES: readonly string[] = ['system', 'light', 'dark']

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && PREFERENCES.includes(value)
}

/**
 * Invalid or missing values and read failures fall back to `system`.
 * Accessing `localStorage` itself may throw in private mode, so read the property inside try.
 */
export function readThemePreference(storage: Pick<Storage, 'getItem'>): ThemePreference {
  try {
    const raw = storage.getItem(THEME_STORAGE_KEY)
    return isThemePreference(raw) ? raw : 'system'
  } catch {
    return 'system'
  }
}

/** Write failures do not propagate: apply the change immediately; only persistence is lost. */
export function writeThemePreference(storage: Pick<Storage, 'setItem'>, value: ThemePreference): void {
  try {
    storage.setItem(THEME_STORAGE_KEY, value)
  } catch {
    // Degrade silently when storage is full or disabled.
  }
}

/**
 * Return a storage view whose reads and writes never throw.
 *
 * In private mode, **reading the `localStorage` property itself** may throw, so access it inside try.
 * If unavailable, return a no-op implementation so preferences fall back to `system`.
 */
export function safeThemeStorage(
  source: { localStorage?: unknown } = globalThis,
): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  try {
    const value = source.localStorage
    const candidate = value as Partial<Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>> | null | undefined
    const get = candidate?.getItem
    const set = candidate?.setItem
    const remove = candidate?.removeItem
    // `removeItem` stays optional: widening this helper for the skin cache must not make an existing
    // storage that only reads and writes stop being usable.
    if (typeof get === 'function' && typeof set === 'function')
      return {
        getItem: (key) => get.call(candidate, key),
        setItem: (key, value) => set.call(candidate, key, value),
        removeItem: typeof remove === 'function' ? (key) => remove.call(candidate, key) : () => undefined,
      }
  } catch {
    // Fall through to the no-op implementation below.
  }
  return { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return prefersDark ? 'dark' : 'light'
  return preference
}

// ── Font size ──────────────────────────────────────────────────────────
// All site dimensions use rem, so changing the root font size scales everything without component rule changes.

export type FontScale = 'small' | 'normal' | 'large'

export const FONT_SCALE_STORAGE_KEY = 'agnes-font-scale'

const FONT_SCALES: readonly string[] = ['small', 'normal', 'large']
const FONT_SCALE_PERCENT: Record<FontScale, string> = {
  small: '87.5%',
  normal: '100%',
  large: '112.5%',
}

export function isFontScale(value: unknown): value is FontScale {
  return typeof value === 'string' && FONT_SCALES.includes(value)
}

export function readFontScale(storage: Pick<Storage, 'getItem'>): FontScale {
  try {
    const raw = storage.getItem(FONT_SCALE_STORAGE_KEY)
    return isFontScale(raw) ? raw : 'normal'
  } catch {
    return 'normal'
  }
}

export function writeFontScale(storage: Pick<Storage, 'setItem'>, value: FontScale): void {
  try {
    storage.setItem(FONT_SCALE_STORAGE_KEY, value)
  } catch {
    // As with writeThemePreference, write failures only lose persistence.
  }
}

/** Accept only the minimal fontSize surface for tests without a DOM. */
export type FontScaleRoot = { style: { fontSize: string } }

export function applyFontScale(root: FontScaleRoot, scale: FontScale): void {
  root.style.fontSize = FONT_SCALE_PERCENT[scale]
}

export function applyTheme(root: ThemeRoot, theme: ResolvedTheme): void {
  root.classList.toggle('dark', theme === 'dark')
}

/** Check whether the system prefers dark mode; assume light if `matchMedia` is unavailable. */
export function systemPrefersDark(target: { matchMedia?: unknown } = globalThis): boolean {
  if (typeof target.matchMedia !== 'function') return false
  const query = (target.matchMedia as (value: string) => MediaQueryList)('(prefers-color-scheme: dark)')
  return query.matches
}

/**
 * Subscribe to system theme changes and return an unsubscribe function.
 *
 * **Subscribe unconditionally**; the callback decides whether to follow by rereading the preference.
 * Subscribing only according to the initial preference would miss a later switch from light to system
 * until the next reload. Return a no-op when `matchMedia` is unavailable.
 */
export function watchSystemTheme(target: { matchMedia?: unknown }, onChange: () => void): () => void {
  if (typeof target.matchMedia !== 'function') return () => undefined
  const query = (target.matchMedia as (value: string) => MediaQueryList)('(prefers-color-scheme: dark)')
  const listener = (): void => onChange()
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}
