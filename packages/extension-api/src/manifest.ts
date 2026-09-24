import {
  EXT_EVENT_PATTERN,
  type ExtensionManifest,
  inspectJsonData,
  validateExtensionManifest,
} from '@agnes/protocol'
import { parseSemver } from './api-range.js'
import { ExtensionError } from './errors.js'
import { THEME_TOKENS } from './generated/theme-tokens.js'

export type { Capabilities as ExtensionCapabilities, ExtensionManifest } from '@agnes/protocol'
export type { ThemeTokenName } from './generated/theme-tokens.js'
export { THEME_TOKEN_NAMES } from './generated/theme-tokens.js'

export const EXTENSION_ID_PATTERN = /^[a-z0-9-]+\/[a-z0-9-]+$/
export const EVENT_NAME_PATTERN = /^[a-z0-9-]+$/
export const NETWORK_HOST_PATTERN = /^[a-z0-9.-]+(:[0-9]{1,5})?$/

export function extEventType(extId: string, name: string): string {
  if (typeof extId !== 'string' || typeof name !== 'string')
    throw new ExtensionError('E_EVENT_NAMESPACE', 'invalid extension event namespace')
  const type = `x/${extId}/${name}`
  if (!EXTENSION_ID_PATTERN.test(extId) || !EVENT_NAME_PATTERN.test(name) || !EXT_EVENT_PATTERN.test(type))
    throw new ExtensionError('E_EVENT_NAMESPACE', 'invalid extension event namespace')
  return type
}

/** A portable package-relative path: `./`-prefixed, no drive/backslash/NUL, no traversal segment. */
function containedRelativePath(value: string): boolean {
  if (!value.startsWith('./') || /[\\:]/.test(value) || value.includes('\0')) return false
  return !value
    .slice(2)
    .split('/')
    .some((segment) => segment === '' || segment === '.' || segment === '..')
}

/**
 * Skin-specific problems the schema cannot express: the capability/contribution coupling, in-package
 * id uniqueness, the token whitelist, and containment of the stylesheet path. Sizes and resolved
 * containment belong to the loader, which owns the package directory.
 */
function skinProblems(value: ExtensionManifest): string[] {
  const skins = value.contributes?.skins ?? []
  const declared = value.capabilities.ui?.includes('skin') ?? false
  if (skins.length === 0 && !declared) return []
  if (skins.length > 0 && !declared)
    return ["contributes.skins: declaring skins requires capabilities.ui to include 'skin'"]
  if (skins.length === 0) return ["capabilities.ui: 'skin' requires at least one contributes.skins entry"]

  const problems: string[] = []
  const seen = new Set<string>()
  for (const skin of skins) {
    if (seen.has(skin.id)) problems.push(`contributes.skins: duplicate id ${skin.id}`)
    seen.add(skin.id)
    if (!containedRelativePath(skin.css))
      problems.push(`contributes.skins.${skin.id}.css: must be a relative path inside the package`)
    for (const token of Object.keys(skin.tokens ?? {}))
      if (!THEME_TOKENS.has(token))
        problems.push(`contributes.skins.${skin.id}.tokens: ${token} is not a themeable semantic token`)
  }
  return problems
}

/**
 * Client-module coupling the schema cannot express: `capabilities.ui` including 'client' and the
 * presence of `contributes.client` must come in a pair. Path form, extension allowlist, sizes and
 * existence belong to the package loader (`client-assets.ts`), which owns the package directory.
 */
function clientProblems(value: ExtensionManifest): string[] {
  const client = value.contributes?.client
  const declared = value.capabilities.ui?.includes('client') ?? false
  if (client === undefined && !declared) return []
  if (client !== undefined && !declared)
    return ["contributes.client: declaring a client module requires capabilities.ui to include 'client'"]
  if (client === undefined) return ["capabilities.ui: 'client' requires a contributes.client contribution"]
  return []
}

export function checkManifest(
  input: unknown,
): { ok: true; value: ExtensionManifest } | { ok: false; problems: string[] } {
  const data = inspectJsonData(input, Number.MAX_SAFE_INTEGER)
  if (!data.ok) return { ok: false, problems: ['manifest: expected plain JSON data'] }
  try {
    const result = validateExtensionManifest(data.value)
    if (!result.ok) return { ok: false, problems: result.errors.map((e) => `${e.path}: ${e.message}`) }
    if (!parseSemver(result.value.version))
      return { ok: false, problems: ['version: expected semantic version'] }
    if (!result.value.apiRange.trim()) return { ok: false, problems: ['apiRange: must not be empty'] }
    if (!containedRelativePath(result.value.entry))
      return { ok: false, problems: ['entry: must be a relative path inside the package'] }
    const problems = [...skinProblems(result.value), ...clientProblems(result.value)]
    if (problems.length > 0) return { ok: false, problems }
    return { ok: true, value: result.value }
  } catch {
    return { ok: false, problems: ['manifest: could not validate JSON data'] }
  }
}
