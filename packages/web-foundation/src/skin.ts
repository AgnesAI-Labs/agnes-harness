/**
 * Pure skin preference logic: cache access, one-time overrides and root tokens for the current theme.
 *
 * The DOM surface only sets or removes a custom property, allowing tests without a DOM.
 * Constructed stylesheets and `adoptedStyleSheets` stay in `theme-boot`, which already accesses
 * `document`; this module does not own the document.
 */

import type { ResolvedTheme } from './theme.js'

export type SkinTokenModes = { light: string; dark: string }
/** Cached current skin: stylesheet text, token values and the producing manifest revision. */
export type SkinCache = {
  version: typeof SKIN_CACHE_VERSION
  id: string
  revision: string
  css: string
  tokens: Record<string, SkinTokenModes>
}

/**
 * A manifest entry normalized to the client minimum: identity, stylesheet location and tokens.
 * Missing `css` means the host did not inline it (too large or unreadable); use `cssUrl` instead.
 */
export type SkinRosterEntry = {
  id: string
  name: string
  packageName: string
  /** Source manifest digest for this entry; changes require cache reconciliation. */
  revision: string
  /** Same-origin stylesheet route, shaped as `/skins/<id>/skin.css`. */
  cssUrl: string
  /** Inline stylesheet text; absence means it must be fetched, not that no stylesheet exists. */
  css?: string
  tokens: Record<string, SkinTokenModes>
}

export const SKIN_STORAGE_KEY = 'agnes-skin'
/** The user's explicit choice: a skin id, or `none`. Unlike the cache it survives a skin going missing. */
export const SKIN_PREFERENCE_KEY = 'agnes-skin-preference'
/** Discard mismatched cache versions and treat as no skin; do not guess old formats. */
export const SKIN_CACHE_VERSION = 1
/** The `?skin=none` value that forces the built-in appearance. */
export const SKIN_NONE = 'none'
/** Same shape as the protocol `SkinId`. */
const SKIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const CUSTOM_PROPERTY = /^--[a-zA-Z0-9_-]+$/

/** Validate tokens: every key must have nonempty light and dark values. */
function readTokens(value: unknown): Record<string, SkinTokenModes> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const tokens: Record<string, SkinTokenModes> = {}
  for (const [name, modes] of Object.entries(value as Record<string, unknown>)) {
    // Only custom properties: a name like `display` would otherwise become an inline root style.
    if (!CUSTOM_PROPERTY.test(name)) return null
    if (typeof modes !== 'object' || modes === null || Array.isArray(modes)) return null
    const { light, dark } = modes as Record<string, unknown>
    if (typeof light !== 'string' || light === '' || typeof dark !== 'string' || dark === '') return null
    tokens[name] = { light, dark }
  }
  return tokens
}

/**
 * Read the cached skin. Invalid JSON, version mismatches, missing fields and invalid ids return `null`:
 * the cache is a disposable accelerator, not the authority.
 */
export function readSkinCache(storage: Pick<Storage, 'getItem'>): SkinCache | null {
  try {
    const raw = storage.getItem(SKIN_STORAGE_KEY)
    if (raw === null) return null
    const value = JSON.parse(raw) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    if (record.version !== SKIN_CACHE_VERSION) return null
    if (typeof record.id !== 'string' || !SKIN_ID.test(record.id)) return null
    if (typeof record.revision !== 'string' || typeof record.css !== 'string') return null
    const tokens = readTokens(record.tokens)
    if (tokens === null) return null
    return { version: SKIN_CACHE_VERSION, id: record.id, revision: record.revision, css: record.css, tokens }
  } catch {
    // Reads may throw in private mode; treat that and corrupt contents as no skin.
    return null
  }
}

/** Write failures only lose persistence; apply the change immediately. */
export function writeSkinCache(storage: Pick<Storage, 'setItem'>, cache: SkinCache): void {
  try {
    storage.setItem(SKIN_STORAGE_KEY, JSON.stringify(cache))
  } catch {
    // Degrade silently when storage is full or disabled.
  }
}

/** Clear the cache when the skin is removed, its manifest revision changes, or the user selects no skin. */
export function clearSkinCache(storage: Pick<Storage, 'removeItem'>): void {
  try {
    storage.removeItem(SKIN_STORAGE_KEY)
  } catch {
    // As with writeSkinCache, only persistence is lost.
  }
}

/**
 * Parse a one-time `?skin=` override. Accept only `none` and valid ids; **invalid or missing values return `null` (no override)**.
 * A typo therefore falls back to the user selection instead of unexpectedly disabling the skin.
 * @param search - `location.search`, with or without a leading `?`.
 */
export function skinOverride(search: string): string | null {
  let value: string | null
  try {
    value = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('skin')
  } catch {
    return null
  }
  if (value === null) return null
  const trimmed = value.trim()
  if (trimmed === SKIN_NONE) return SKIN_NONE
  return SKIN_ID.test(trimmed) ? trimmed : null
}

/**
 * One-time overrides take precedence over the cache.
 * `?skin=<id>` works only when that exact skin is cached: there is no network on the first frame.
 * An uncached skin falls back to the built-in appearance until it can be fetched at runtime.
 * @returns The skin for the first frame, or `null` for the built-in appearance.
 */
export function selectedSkin(cache: SkinCache | null, override: string | null): SkinCache | null {
  if (override === null) return cache
  if (override === SKIN_NONE) return null
  return cache !== null && cache.id === override ? cache : null
}

/** Minimal surface for setting/removing custom properties, allowing tests without a DOM. */
export type SkinTokenRoot = {
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): void }
}

/**
 * Write skin tokens for the current theme to the root element.
 *
 * **Clear precisely**: remove only properties previously written here that are no longer needed.
 * Never use a wildcard, which would also remove properties set by others, such as component-local tokens.
 * @param root - Root element or an equivalent custom-property surface.
 * @param cache - Skin to apply; `null` only clears old properties.
 * @param mode - Currently resolved light/dark theme.
 * @param applied - Property names returned by the previous call.
 * @returns Property names written now, to pass as `applied` next time.
 */
export function applySkinTokens(
  root: SkinTokenRoot,
  cache: SkinCache | null,
  mode: ResolvedTheme,
  applied: Iterable<string>,
): Set<string> {
  const wanted = new Map<string, string>()
  if (cache !== null)
    for (const [name, modes] of Object.entries(cache.tokens)) {
      const value = mode === 'dark' ? modes.dark : modes.light
      if (value !== '' && CUSTOM_PROPERTY.test(name)) wanted.set(name, value)
    }
  for (const name of applied) if (!wanted.has(name)) root.style.removeProperty(name)
  for (const [name, value] of wanted) root.style.setProperty(name, value)
  return new Set(wanted.keys())
}

/** The adopted stylesheet surface used here; `document` satisfies it. */
export type SkinSheetHost = { adoptedStyleSheets: CSSStyleSheet[] }

/**
 * The stylesheet **exclusively owned** by this module and its current CSS text.
 * `undefined` means never applied; `''` means no skin styles should currently apply.
 */
export type SkinSheetState = Readonly<{ sheet: CSSStyleSheet | undefined; css: string | undefined }>

/**
 * Keep the host's adopted stylesheet in sync with `css`, owning only one sheet.
 *
 * **Removal matters as much as installation**: disabling a skin or choosing one without inline CSS
 * must remove the old sheet, or it keeps coloring the page while tokens already reflect the new choice.
 * Never touch any sheet except this module's own.
 *
 * Fill the new sheet **before** adopting it so rejected CSS leaves the previous sheet active, not an empty one.
 * @returns State for the next call; on error the caller retains its previous state.
 */
export function syncSkinSheet(
  host: SkinSheetHost,
  state: SkinSheetState,
  css: string,
  createSheet: () => CSSStyleSheet,
): SkinSheetState {
  if (css === state.css) return state
  if (css === '') {
    if (state.sheet !== undefined)
      host.adoptedStyleSheets = host.adoptedStyleSheets.filter((sheet) => sheet !== state.sheet)
    return { sheet: undefined, css: '' }
  }
  const sheet = createSheet()
  sheet.replaceSync(`@layer skin {\n${css}\n}`)
  const kept =
    state.sheet === undefined
      ? [...host.adoptedStyleSheets]
      : host.adoptedStyleSheets.filter((existing) => existing !== state.sheet)
  host.adoptedStyleSheets = [...kept, sheet]
  return { sheet, css }
}

export type SkinReconcilePlan =
  | Readonly<{ kind: 'keep' }>
  /** The cached skin source was uninstalled/disabled: discard it and restore the built-in appearance. */
  | Readonly<{ kind: 'clear' }>
  /** The manifest changed beneath the cached skin: resolve its stylesheet from this entry again. */
  | Readonly<{ kind: 'refresh'; entry: SkinRosterEntry }>

/**
 * Decide how to handle the cache after receiving a new manifest.
 *
 * No cache also means `keep`: the user selected no skin, so there is nothing to reconcile.
 * **Call only after obtaining a manifest**, or a fetch failure could be mistaken for all skins being removed.
 */
export function planSkinReconcile(
  cached: SkinCache | null,
  entries: readonly SkinRosterEntry[],
  preferredId: string | null = null,
): SkinReconcilePlan {
  if (cached === null) {
    // The cache is dropped while the chosen skin is missing from the roster (uninstalled, or a
    // runtime swap not yet active). The stored choice is not: bring the skin back when it returns.
    const entry =
      preferredId === null || preferredId === SKIN_NONE
        ? undefined
        : entries.find((candidate) => candidate.id === preferredId)
    return entry === undefined ? { kind: 'keep' } : { kind: 'refresh', entry }
  }
  const entry = entries.find((candidate) => candidate.id === cached.id)
  if (entry === undefined) return { kind: 'clear' }
  return cached.revision === entry.revision ? { kind: 'keep' } : { kind: 'refresh', entry }
}

/** Minimal `fetch` surface for testing the fallback without a network. */
export type SkinCssFetcher = (input: string) => Promise<{ ok: boolean; text(): Promise<string> }>

/**
 * Fetch a stylesheet from the manifest's `cssUrl` when the host did not inline it.
 *
 * The manifest is untrusted package-derived data: anchor URLs to the page origin and require `/skins/`,
 * so malformed or malicious entries cannot request another origin or unrelated same-origin paths.
 * @throws On escaping references, non-2xx responses or empty bodies; callers keep the built-in appearance without caching partial data.
 */
export async function fetchSkinCss(
  cssUrl: string,
  options: { fetcher: SkinCssFetcher; origin: string },
): Promise<string> {
  const url = new URL(cssUrl, options.origin)
  if (url.origin !== options.origin || !url.pathname.startsWith('/skins/'))
    throw new Error('skin stylesheet reference is out of scope')
  const response = await options.fetcher(url.pathname)
  if (!response.ok) throw new Error('skin stylesheet is unavailable')
  const css = await response.text()
  if (css === '') throw new Error('skin stylesheet is empty')
  return css
}

/**
 * Fetch all text needed for a skin and cache it; shared by selection and manifest reconciliation.
 *
 * Use host-inlined CSS when present, otherwise `cssUrl`; **throw on failure and never cache empty CSS**.
 * Otherwise the UI would show a selected skin without applying any of its styles.
 * @returns The cached shape for callers to reuse.
 */
export async function cacheSkinEntry(
  storage: Pick<Storage, 'setItem'>,
  entry: SkinRosterEntry,
  options: { fetcher: SkinCssFetcher; origin: string },
): Promise<SkinCache> {
  const css = entry.css ?? (await fetchSkinCss(entry.cssUrl, options))
  const cached: SkinCache = {
    version: SKIN_CACHE_VERSION,
    id: entry.id,
    revision: entry.revision,
    css,
    tokens: entry.tokens,
  }
  writeSkinCache(storage, cached)
  return cached
}
