import type { ResolvedTheme } from './theme.js'

type SkinTokenModes = { light: string; dark: string }

/** Only the legacy `none` preference is still recognized. The old CSS cache is never read. */
export const SKIN_PREFERENCE_KEY = 'agnes-skin-preference'
const CUSTOM_PROPERTY = /^--[a-zA-Z0-9_-]+$/

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
 * @param skin - Skin to apply; `null` only clears old properties.
 * @param mode - Currently resolved light/dark theme.
 * @param applied - Property names returned by the previous call.
 * @returns Property names written now, to pass as `applied` next time.
 */
export function applySkinTokens(
  root: SkinTokenRoot,
  skin: { tokens: Record<string, SkinTokenModes> } | null,
  mode: ResolvedTheme,
  applied: Iterable<string>,
): Set<string> {
  const wanted = new Map<string, string>()
  if (skin !== null)
    for (const [name, modes] of Object.entries(skin.tokens)) {
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
