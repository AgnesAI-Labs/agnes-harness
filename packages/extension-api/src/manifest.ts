import {
  EXT_EVENT_PATTERN,
  type ExtensionManifest,
  inspectJsonData,
  transportCapabilityProblems,
  validateExtensionManifest,
} from '@agnes/protocol'
import { validUiComponentDeclaration } from '@agnes/protocol/intelligent-ui'
import { parseSemver } from './api-range.js'
import { ExtensionError } from './errors.js'
import { THEME_TOKENS } from './generated/theme-tokens.js'

export type {
  ApplicationTemplate,
  BundleLaunch,
  Capabilities as ExtensionCapabilities,
  ExtensionManifest,
  PluginMetadata,
  PluginMetadataLocale,
  PluginProvide,
} from '@agnes/protocol'
export type { ThemeTokenName } from './generated/theme-tokens.js'
export { THEME_TOKEN_NAMES } from './generated/theme-tokens.js'

export const EXTENSION_ID_PATTERN = /^[a-z0-9-]+\/[a-z0-9-]+$/
export const EVENT_NAME_PATTERN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/
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
  if (skins.length === 0) return []
  if (value.capabilities.ui !== true) return ['contributes.skins: declaring skins requires capabilities.ui']

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
 * Client-module coupling the schema cannot express: `contributes.client` requires `capabilities.ui`. Path form, extension allowlist, sizes and
 * existence belong to the package loader (`client-assets.ts`), which owns the package directory.
 */
function clientProblems(value: ExtensionManifest, namespace: string): string[] {
  const client = value.contributes?.client
  if (client === undefined) return []
  if (value.capabilities.ui !== true)
    return ['contributes.client: declaring a client module requires capabilities.ui']
  if (
    (client.presentationRoles?.length || client.homeEntries?.length || client.examplePages?.length) &&
    client.lifetime !== 'profile'
  )
    return ['home entries and example pages require profile lifetime']
  if (
    new Set(client.homeEntries?.map((entry) => entry.id)).size !== (client.homeEntries?.length ?? 0) ||
    (client.homeEntries?.filter((entry) => entry.placement === 'primary').length ?? 0) > 32
  )
    return ['home entry declarations must have unique ids and at most 32 primary entries']
  if (client.presentationRoles?.length && !client.id)
    return ['presentation roles require an explicit client id']
  const components = client.intelligentComponents
  if (!components) return []
  if (
    (client.slots?.length ?? 0) ||
    (client.services?.length ?? 0) ||
    (client.styles?.length ?? 0) ||
    (client.streams?.length ?? 0)
  )
    return ['intelligentComponents modules must be self-contained and have no slots, services or styles']
  const seen = new Set<string>()
  for (const component of components) {
    if (
      !component.kind.startsWith(`${namespace}/`) ||
      !validUiComponentDeclaration(component) ||
      seen.has(component.kind)
    )
      return ['intelligentComponents: invalid, duplicate or foreign namespace declaration']
    seen.add(component.kind)
  }
  return []
}

export function checkManifest(
  input: unknown,
  componentNamespace?: string,
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
    const transportProblems = transportCapabilityProblems(result.value.capabilities)
    for (const name of result.value.contributes?.client?.streams ?? [])
      if (!result.value.capabilities.streams?.some((s) => s.name === name))
        transportProblems.push('client stream must be declared by its owner')
    const problems = [
      ...transportProblems,
      ...skinProblems(result.value),
      ...clientProblems(result.value, componentNamespace ?? result.value.id),
    ]
    if (problems.length > 0) return { ok: false, problems }
    return { ok: true, value: result.value }
  } catch {
    return { ok: false, problems: ['manifest: could not validate JSON data'] }
  }
}

/**
 * The runtime manifest of one bundled plugin, taken from its package's `package.json`: the single
 * `agnes.plugins` entry carries the id (`ext:<id>`), apiRange, capabilities and metadata; the
 * package carries the version and the module path. Returns plain data for `checkManifest`.
 */
export function bundledExtensionManifest(pkg: unknown): unknown {
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const root = record(pkg)
  const plugins = record(root.agnes).plugins
  if (!Array.isArray(plugins) || plugins.length !== 1) return undefined
  const entry = record(plugins[0])
  const exported = record(root.exports)
  const module = typeof root.exports === 'string' ? root.exports : exported['.']
  const id = typeof entry.id === 'string' && entry.id.startsWith('ext:') ? entry.id.slice(4) : entry.id
  return {
    id,
    version: root.version,
    apiRange: entry.apiRange,
    entry: module,
    ...(entry.liveResources === undefined ? {} : { liveResources: entry.liveResources }),
    capabilities: entry.capabilities ?? {},
    ...(entry.contributes === undefined ? {} : { contributes: entry.contributes }),
    ...(entry.lease === undefined ? {} : { lease: entry.lease }),
    ...(entry.runtimeSupports === undefined ? {} : { runtime: { supports: entry.runtimeSupports } }),
    ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
  }
}

/** The `package.json` that declares `manifest` as one bundled plugin; the inverse of `bundledExtensionManifest`. */
export function bundledPackageJson(
  manifest: Pick<ExtensionManifest, 'id' | 'version' | 'apiRange' | 'entry' | 'capabilities'> &
    Partial<ExtensionManifest>,
  extra: Record<string, unknown> = {},
) {
  return {
    name: `@${manifest.id}`,
    version: manifest.version,
    type: 'module',
    exports: manifest.entry,
    ...extra,
    agnes: {
      plugins: [
        {
          id: `ext:${manifest.id}`,
          export: 'default',
          apiRange: manifest.apiRange,
          ...(manifest.runtime ? { runtimeSupports: manifest.runtime.supports } : {}),
          capabilities: manifest.capabilities,
          ...(manifest.liveResources ? { liveResources: manifest.liveResources } : {}),
          ...(manifest.contributes ? { contributes: manifest.contributes } : {}),
          ...(manifest.lease ? { lease: manifest.lease } : {}),
          ...(manifest.metadata ? { metadata: manifest.metadata } : {}),
        },
      ],
    },
  }
}
