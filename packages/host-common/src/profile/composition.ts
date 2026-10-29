import type {
  CompactionEngineCatalogEntry,
  LoopCatalogEntry,
  ModelAdapterCatalogEntry,
} from '@agnes/extension-api'
import { parsePackageBundleContract, RELEASE_DEFAULTS } from '@agnes/package-manager'
import type { BundleLaunch, JsonValue, LoopSelection } from '@agnes/protocol'
import { inspectJsonData } from '@agnes/protocol'
import { HostError } from '../errors.js'
import { mergeValue } from '../presets/merge.js'
import type { PresetDoc } from '../presets/types.js'
import { canonicalJson, sha256hex } from './canonical.js'
import { freezeTree } from './composition-freeze.js'
import type { PackageRef, ResolvedProfile, RuntimeProfileManifest } from './types.js'

export type CompositionSource = Readonly<{
  layer: 'default' | 'profile' | 'preset' | 'admin' | 'session'
  name: string
}>
/** The provider kinds a composition layer selects, written in the one `providers.<kind>` table. */
export type CompositionProviders = {
  loop?: { provider: string; version: string }
  'model-adapter'?: { provider: string | string[] }
  compaction?: { provider: string } | null
  persistence?: { provider: string }
  sandbox?: { provider: string }
}
/** A composition layer that selects one exact loop. */
export const loopPatch = (loop: { id: string; version: string }): CompositionPatch => ({
  providers: { loop: { provider: loop.id, version: loop.version } },
})
export type CompositionPatch = {
  providers?: CompositionProviders
  packages?: PackageRef[]
  plugins?: Record<string, { enabled?: boolean; config?: JsonValue }>
  toolPolicy?: { readOnly?: boolean; allow?: string[]; deny?: string[] }
  tools?: string[]
  mcp?: string[]
  skills?: string[]
  uiModules?: string[]
  /** Omitted preserves deployment defaults; [] is headless. */
  surfaces?: ('web' | 'acp' | 'http')[]
  shell?: { modules?: string[]; slots?: string[] }
}
/** Exact backend identities retained in session pins and capability snapshots. */
export type ResolvedCompositionSelection = Omit<CompositionPatch, 'providers'> & {
  modelAdapters?: string[]
  loop?: LoopSelection
  compaction?: { engine: string } | null
  persistence?: { provider: string }
  sandbox?: { provider: string }
}

export function bindProviderSelections(patch: CompositionPatch): ResolvedCompositionSelection {
  const { providers, ...rest } = patch
  const { loop, compaction, 'model-adapter': adapters, persistence, sandbox } = providers ?? {}
  return {
    ...rest,
    ...(persistence ? { persistence } : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(adapters
      ? {
          modelAdapters: typeof adapters.provider === 'string' ? [adapters.provider] : [...adapters.provider],
        }
      : {}),
    ...(loop ? { loop: { id: loop.provider, version: loop.version } } : {}),
    ...(compaction === undefined
      ? {}
      : { compaction: compaction === null ? null : { engine: compaction.provider } }),
  }
}

export type BundleDocument = {
  launch?: BundleLaunch
  extends?: string[]
  profile?: CompositionPatch
  presets?: Record<string, PresetDoc>
}
export type BundleCatalogEntry = Readonly<{ id: string; sourcePackage: string; document: BundleDocument }>
export type BundleCatalog = Readonly<Record<string, BundleCatalogEntry>>
export type CompositionRow = Readonly<{ id: string; packageId: string; enabled: boolean; config?: JsonValue }>
export type CompositionCatalog = Readonly<{
  loops: readonly LoopCatalogEntry[]
  modelAdapters: readonly ModelAdapterCatalogEntry[]
  compactionEngines: readonly CompactionEngineCatalogEntry[]
  persistenceProviders?: readonly { id: string }[]
  sandboxProviders?: readonly { id: string }[]
  tools?: readonly string[]
  uiModules?: readonly string[]
}>
export type ResolvedComposition = Readonly<{
  profile: string
  preset: string
  bundles: readonly string[]
  sessionBundles?: readonly string[]
  selection: ResolvedCompositionSelection
  sources: Readonly<Record<string, CompositionSource>>
  rows: readonly CompositionRow[]
  /** Compiled ownership, pinned with the composition; absent on pre-isolation bindings. */
  toolScope?: Readonly<{ bundlePackages: readonly string[]; activePackages: readonly string[] }>
  hash: string
}>

const map = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control bytes at the identifier or path boundary.
  typeof value === 'string' && !!value.trim() && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value)
function fail(message: string): never {
  throw new HostError('E_PRESET_UNSUPPORTED', `composition: ${message}`)
}
const list = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 256 && value.every(text) && new Set(value).size === value.length
const safeKey = (key: string) => !['__proto__', 'constructor', 'prototype'].includes(key)
const PROVIDER_FIELDS = ['loop', 'model-adapter', 'compaction', 'persistence', 'sandbox'] as const
const fields = new Set([
  'providers',
  'packages',
  'plugins',
  'toolPolicy',
  'tools',
  'mcp',
  'skills',
  'uiModules',
  'surfaces',
  'shell',
])

function checkProviders(providers: unknown): void {
  if (
    !map(providers) ||
    Object.keys(providers).some((key) => !(PROVIDER_FIELDS as readonly string[]).includes(key))
  )
    fail('invalid providers')
  const { loop, 'model-adapter': adapter } = providers
  if (adapter !== undefined) {
    if (
      !map(adapter) ||
      Object.keys(adapter).some((key) => key !== 'provider') ||
      !(text(adapter.provider) || list(adapter.provider))
    )
      fail('invalid providers.model-adapter.provider')
  }
  if (
    loop !== undefined &&
    (!map(loop) ||
      !text(loop.provider) ||
      !text(loop.version) ||
      Object.keys(loop).some((key) => !['provider', 'version'].includes(key)))
  )
    fail('providers.loop requires provider and version')
  for (const field of ['compaction', 'persistence', 'sandbox'] as const) {
    const item = providers[field]
    if (field === 'compaction' && item === null) continue
    if (item !== undefined && (!map(item) || !text(item.provider) || Object.keys(item).length !== 1))
      fail(`invalid providers.${field}.provider`)
  }
}

/** Validate static data before it can influence package loading or runtime selection. */
export function checkCompositionPatch(value: unknown): CompositionPatch {
  const inspected = inspectJsonData(value, 1_048_576)
  if (!inspected.ok) fail('patch must be JSON data')
  value = inspected.value
  if (!map(value)) fail('invalid patch fields')
  for (const key of PROVIDER_FIELDS)
    if (Object.hasOwn(value, key)) fail(`${key} is selected with providers.${key}: { provider }`)
  if (Object.keys(value).some((key) => !fields.has(key))) fail('invalid patch fields')
  if (value.providers !== undefined) checkProviders(value.providers)
  for (const field of ['tools', 'mcp', 'skills', 'uiModules'])
    if (value[field] !== undefined && !list(value[field])) fail(`invalid ${field}`)
  if (
    value.surfaces !== undefined &&
    (!list(value.surfaces) || value.surfaces.some((id: string) => !['web', 'acp', 'http'].includes(id)))
  )
    fail('invalid surfaces')
  if (
    value.shell !== undefined &&
    (!map(value.shell) ||
      Object.keys(value.shell).some((key) => !['modules', 'slots'].includes(key)) ||
      (value.shell.modules !== undefined && !list(value.shell.modules)) ||
      (value.shell.slots !== undefined && !list(value.shell.slots)))
  )
    fail('invalid shell')
  if (
    value.packages !== undefined &&
    (!Array.isArray(value.packages) ||
      value.packages.length > 256 ||
      value.packages.some(
        (pkg) =>
          !map(pkg) ||
          !text(pkg.id) ||
          !text(pkg.source) ||
          Object.keys(pkg).some(
            (key) => !['id', 'source', 'version', 'enabled', 'config', 'tombstone'].includes(key),
          ) ||
          (pkg.enabled !== undefined && typeof pkg.enabled !== 'boolean') ||
          (pkg.tombstone !== undefined && typeof pkg.tombstone !== 'boolean'),
      ))
  )
    fail('invalid packages')
  if (value.plugins !== undefined) {
    if (!map(value.plugins) || Object.keys(value.plugins).length > 512) fail('invalid plugins')
    for (const [id, patch] of Object.entries(value.plugins))
      if (
        !safeKey(id) ||
        !text(id) ||
        !map(patch) ||
        Object.keys(patch).some((key) => !['enabled', 'config'].includes(key)) ||
        (patch.enabled !== undefined && typeof patch.enabled !== 'boolean')
      )
        fail(`invalid plugin ${id}`)
  }
  if (value.toolPolicy !== undefined) {
    const policy = value.toolPolicy
    if (
      !map(policy) ||
      Object.keys(policy).some((key) => !['readOnly', 'allow', 'deny'].includes(key)) ||
      (policy.readOnly !== undefined && typeof policy.readOnly !== 'boolean') ||
      (policy.allow !== undefined && !list(policy.allow)) ||
      (policy.deny !== undefined && !list(policy.deny))
    )
      fail('invalid toolPolicy')
  }
  return value as CompositionPatch
}

/**
 * What a preset selects, as one composition layer. The preset's `providers` table is the only place it
 * names provider kinds: `tool-runtime` and `tool-policy` reach the preset view, the rest join the patch.
 */
export function presetCompositionPatch(preset: PresetDoc | undefined): CompositionPatch | undefined {
  if (preset?.composition === undefined && preset?.providers === undefined) return undefined
  const patch = checkCompositionPatch(preset.composition ?? {})
  if (patch.providers !== undefined)
    fail(`preset ${preset.name}: select providers in the preset's providers table`)
  const table = preset.providers
  if (table === undefined) return patch
  if (!map(table)) fail(`preset ${preset.name}: invalid providers`)
  const { 'tool-runtime': _runtime, 'tool-policy': _policy, ...selected } = table
  return Object.keys(selected).length ? checkCompositionPatch({ ...patch, providers: selected }) : patch
}

/** Packages publish data in package.json agnes.bundles; no entry module is evaluated. */
export function parsePackageBundles(packageId: string, value: unknown): BundleCatalog {
  try {
    return parsePackageBundleContract(packageId, value) as BundleCatalog
  } catch (error) {
    fail(error instanceof Error ? error.message : 'invalid bundles')
  }
}

/** DFS preserves declaration order, refuses cycles/unknown ids, and applies each base once. */
export function expandBundles(ids: readonly string[], catalog: BundleCatalog): readonly BundleCatalogEntry[] {
  const result: BundleCatalogEntry[] = [],
    visiting = new Set<string>(),
    applied = new Set<string>()
  const visit = (id: string) => {
    if (visiting.size >= 64) fail('bundle inheritance exceeds 64 levels')
    if (visiting.has(id)) fail(`bundle inheritance cycle at ${id}`)
    if (applied.has(id)) return
    const entry = catalog[id]
    if (!entry)
      throw new HostError('E_PRESET_UNSUPPORTED', `composition: unknown bundle ${id}`, {
        detail: { reason: 'bundle-unavailable' },
      })
    visiting.add(id)
    for (const parent of entry.document.extends ?? []) visit(parent)
    visiting.delete(id)
    applied.add(id)
    result.push(entry)
  }
  for (const id of ids) visit(id)
  return result
}

/**
 * The presets a per-session bundle selection brings with it. A bundle keeps its policy selection in
 * its presets, so a session that selects the bundle needs them in its own pinned profile; later
 * bundles refine earlier ones, as they do for the profile and admin layers.
 */
export function sessionBundlePresets(
  ids: readonly string[],
  catalog: BundleCatalog,
): Record<string, PresetDoc> {
  const presets: Record<string, PresetDoc> = {}
  for (const entry of expandBundles(ids, catalog))
    for (const [name, doc] of Object.entries(entry.document.presets ?? {}))
      presets[name] = mergeValue(presets[name], doc) as PresetDoc
  return presets
}

/** Validate the backend's pinned identity representation, not author configuration. */
export function checkResolvedCompositionSelection(value: unknown): ResolvedCompositionSelection {
  const inspected = inspectJsonData(value, 1_048_576)
  if (!inspected.ok) fail('resolved selection must be JSON data')
  value = inspected.value
  if (!map(value)) fail('resolved selection must be an object')
  if (
    Object.hasOwn(value, 'model-adapter') ||
    (value.modelAdapters !== undefined && !list(value.modelAdapters))
  )
    fail('invalid resolved model adapter identity')
  const loop = value.loop
  const compaction = value.compaction
  if (loop !== undefined && (!map(loop) || Object.keys(loop).some((key) => !['id', 'version'].includes(key))))
    fail('invalid resolved loop identity')
  if (
    compaction !== undefined &&
    compaction !== null &&
    (!map(compaction) || Object.keys(compaction).some((key) => key !== 'engine'))
  )
    fail('invalid resolved compaction identity')
  const { modelAdapters, loop: _loop, compaction: _compaction, persistence, sandbox, ...rest } = value
  const providers: Record<string, unknown> = {
    ...(modelAdapters === undefined ? {} : { 'model-adapter': { provider: modelAdapters } }),
    ...(loop === undefined
      ? {}
      : {
          loop: {
            provider: (loop as Record<string, unknown>).id,
            version: (loop as Record<string, unknown>).version,
          },
        }),
    ...(compaction === undefined
      ? {}
      : {
          compaction:
            compaction === null ? null : { provider: (compaction as Record<string, unknown>).engine },
        }),
    ...(persistence === undefined ? {} : { persistence }),
    ...(sandbox === undefined ? {} : { sandbox }),
  }
  return bindProviderSelections(
    checkCompositionPatch({ ...rest, ...(Object.keys(providers).length ? { providers } : {}) }),
  )
}

/**
 * Decodes a persisted tree: every field the Host reads later, and a hash that still matches the
 * content. A record edited or damaged after publication is refused here, never downstream.
 */
export function checkResolvedComposition(value: unknown): ResolvedComposition {
  if (!map(value)) fail('resolved composition must be an object')
  const { hash, ...content } = value
  if (typeof hash !== 'string' || !/^sha256-[a-f0-9]{64}$/.test(hash)) fail('invalid composition hash')
  if (!text(value.profile) || !text(value.preset)) fail('invalid composition profile or preset')
  if (!list(value.bundles)) fail('invalid composition bundles')
  if (value.sessionBundles !== undefined && !list(value.sessionBundles)) fail('invalid session bundles')
  checkResolvedCompositionSelection(value.selection)
  if (!map(value.sources)) fail('invalid composition sources')
  for (const [key, source] of Object.entries(value.sources))
    if (
      !map(source) ||
      !['default', 'profile', 'preset', 'admin', 'session'].includes(source.layer as string) ||
      !text(source.name)
    )
      fail(`invalid composition source ${key}`)
  if (!Array.isArray(value.rows)) fail('invalid composition rows')
  for (const row of value.rows)
    if (!map(row) || !text(row.id) || !text(row.packageId) || typeof row.enabled !== 'boolean')
      fail('invalid composition row')
  const scope = value.toolScope
  if (scope !== undefined) {
    if (!map(scope) || !Array.isArray(scope.bundlePackages) || !Array.isArray(scope.activePackages))
      fail('invalid composition tool scope')
    if (![...scope.bundlePackages, ...scope.activePackages].every(text))
      fail('invalid composition tool scope')
  }
  if (`sha256-${sha256hex(canonicalJson(content))}` !== hash)
    fail('composition hash does not match its content')
  return value as ResolvedComposition
}

export function mergeComposition<T extends CompositionPatch | ResolvedCompositionSelection>(
  base: T,
  patch: T,
): T {
  const result = { ...base, ...patch }
  const providers = (patch as CompositionPatch).providers
  if (providers)
    (result as CompositionPatch).providers = { ...(base as CompositionPatch).providers, ...providers }
  if (patch.packages) {
    const packages = new Map((base.packages ?? []).map((pkg) => [pkg.id, pkg]))
    for (const pkg of patch.packages) packages.set(pkg.id, { ...packages.get(pkg.id), ...pkg })
    result.packages = [...packages.values()]
  }
  if (patch.plugins) {
    result.plugins = { ...base.plugins }
    for (const [id, row] of Object.entries(patch.plugins))
      result.plugins[id] = { ...result.plugins[id], ...row }
  }
  if (patch.toolPolicy) result.toolPolicy = { ...base.toolPolicy, ...patch.toolPolicy }
  return result as T
}

function applySource(
  sources: Record<string, CompositionSource>,
  patch: CompositionPatch | ResolvedCompositionSelection,
  source: CompositionSource,
) {
  for (const [field, value] of Object.entries(patch)) {
    if (field === 'plugins') {
      for (const [id, row] of Object.entries(value as NonNullable<CompositionPatch['plugins']>))
        for (const key of Object.keys(row)) sources[`plugins.${id}.${key}`] = source
    } else if (field === 'toolPolicy') {
      for (const key of Object.keys(value as object)) sources[`toolPolicy.${key}`] = source
    } else if (field === 'providers') {
      for (const kind of Object.keys(value as object))
        sources[kind === 'model-adapter' ? 'modelAdapters' : kind] = source
    } else sources[field] = source
  }
}

/** Expand package bundles before the normal profile resolver applies lock/trust restrictions. */
export function prepareProfileComposition(
  manifest: RuntimeProfileManifest,
  catalog: BundleCatalog,
  adminBundles: readonly string[] = [],
): {
  manifest: RuntimeProfileManifest
  sources: Record<string, CompositionSource>
  presets: Record<string, PresetDoc>
} {
  if (manifest.bundles !== undefined && !list(manifest.bundles)) fail('profile bundles must be unique ids')
  let patch: CompositionPatch = {}
  const sources: Record<string, CompositionSource> = {},
    presets: Record<string, PresetDoc> = {}
  for (const entry of expandBundles(manifest.bundles ?? [], catalog)) {
    const next = entry.document.profile ?? {}
    patch = mergeComposition(patch, next)
    applySource(sources, next, { layer: 'profile', name: entry.id })
    for (const [name, doc] of Object.entries(entry.document.presets ?? {}))
      presets[name] = mergeValue(presets[name], doc) as PresetDoc
  }
  const direct = checkCompositionPatch(manifest.composition ?? {})
  patch = mergeComposition(patch, direct)
  applySource(sources, direct, { layer: 'profile', name: manifest.name })
  for (const key of ['persistence', 'sandbox'] as const) {
    const chosen = manifest.providers?.[key]
    if (chosen !== undefined) {
      patch = mergeComposition(patch, { providers: { [key]: { provider: chosen.provider } } })
      sources[key] = { layer: 'profile', name: manifest.name }
    }
  }
  const packages = new Map((patch.packages ?? []).map((pkg) => [pkg.id, pkg]))
  for (const pkg of manifest.packages ?? []) packages.set(pkg.id, { ...packages.get(pkg.id), ...pkg })
  if (patch.packages) patch.packages = [...packages.values()]
  for (const entry of expandBundles(adminBundles, catalog)) {
    patch = mergeComposition(patch, entry.document.profile ?? {})
    applySource(sources, entry.document.profile ?? {}, { layer: 'admin', name: entry.id })
    for (const [name, doc] of Object.entries(entry.document.presets ?? {}))
      presets[name] = mergeValue(presets[name], doc) as PresetDoc
  }
  return {
    manifest: {
      ...manifest,
      ...(patch.packages ? { packages: patch.packages } : {}),
      presets: {
        ...manifest.presets,
        allowed: [...new Set([...(manifest.presets?.allowed ?? []), ...Object.keys(presets)])],
      },
      composition: patch,
    },
    sources,
    presets,
  }
}

/** Pure compiler shared by admission, config dump and admin. Later layers win; row config replaces. */
export function resolveComposition(
  profile: ResolvedProfile,
  options: {
    preset?: PresetDoc
    admin?: { bundles?: string[]; composition?: CompositionPatch }
    sessionBundles?: readonly string[]
    session?: CompositionPatch
    rows?: readonly CompositionRow[]
    catalog?: CompositionCatalog
    /** Published package availability; does not change the profile's default selection. */
    packageCatalog?: readonly { id: string; enabled: boolean }[]
  } = {},
): ResolvedComposition {
  const preset = options.preset?.name ?? profile.presets.default
  const sessionBundles = options.sessionBundles ?? profile.sessionComposition?.bundles
  if (!profile.presets.allowed.includes(preset)) fail(`preset ${preset} is not allowed`)
  let selection: ResolvedCompositionSelection = {
    loop: profile.loop ?? RELEASE_DEFAULTS.loop,
    compaction:
      profile.compaction ??
      (options.catalog && !options.catalog.compactionEngines.some((entry) => entry.id === 'default')
        ? null
        : { engine: 'default' }),
    persistence: profile.persistence ?? { provider: RELEASE_DEFAULTS.persistenceProvider },
    sandbox: profile.sandbox ?? { provider: RELEASE_DEFAULTS.sandboxProvider },
    packages: profile.packages.map(({ id, source, version, enabled }) => ({ id, source, version, enabled })),
    modelAdapters: [],
    toolPolicy: {},
    tools: [],
    mcp: [],
    skills: [],
    uiModules: [],
  }
  const sources: Record<string, CompositionSource> = {}
  applySource(sources, selection, { layer: 'default', name: 'builtin' })
  for (const pkg of profile.packages)
    sources[`packages.${pkg.id}.enabled`] = {
      layer: pkg.trust === 'builtin' ? 'default' : 'profile',
      name: profile.name,
    }
  selection = mergeComposition(selection, bindProviderSelections(profile.composition ?? {}))
  Object.assign(sources, profile.compositionSources)
  for (const key of ['persistence', 'sandbox'] as const)
    if (profile[key] !== undefined && (!sources[key] || sources[key]?.layer === 'default'))
      sources[key] = { layer: 'profile', name: profile.name }
  const bundles = [...(profile.bundles ?? [])]
  const apply = (patch: CompositionPatch, source: CompositionSource) => {
    const bound = bindProviderSelections(checkCompositionPatch(patch))
    selection = mergeComposition(selection, bound)
    applySource(sources, bound, source)
  }
  const bundleLayer = (ids: readonly string[], layer: 'preset' | 'admin' | 'session') => {
    for (const entry of expandBundles(ids, profile.bundleCatalog ?? {})) {
      apply(entry.document.profile ?? {}, { layer, name: entry.id })
      bundles.push(entry.id)
    }
  }
  if (options.preset?.bundles !== undefined) {
    if (!list(options.preset.bundles)) fail(`invalid bundles in preset ${preset}`)
    bundleLayer(options.preset.bundles, 'preset')
  }
  const presetPatch = presetCompositionPatch(options.preset)
  if (presetPatch) apply(presetPatch, { layer: 'preset', name: preset })
  bundleLayer(options.admin?.bundles ?? profile.adminBundles ?? [], 'admin')
  if (options.admin?.composition) apply(options.admin.composition, { layer: 'admin', name: 'selection' })
  if (sessionBundles !== undefined) {
    if (!list(sessionBundles) || sessionBundles.length > 64) fail('invalid session bundles')
    bundleLayer(sessionBundles, 'session')
  }
  if (profile.sessionComposition?.loop)
    apply(
      {
        providers: {
          loop: {
            provider: profile.sessionComposition.loop.id,
            version: profile.sessionComposition.loop.version,
          },
        },
      },
      { layer: 'session', name: 'request' },
    )
  if (options.session) apply(options.session, { layer: 'session', name: 'request' })
  const packages = new Map(
    [...profile.packages, ...(options.packageCatalog ?? [])].map((pkg) => [pkg.id, pkg]),
  )
  for (const pkg of selection.packages ?? []) if (!packages.has(pkg.id)) fail(`unknown package ${pkg.id}`)
  selection.packages =
    selection.packages?.map((pkg) => ({
      ...pkg,
      enabled: packages.get(pkg.id)!.enabled && pkg.enabled !== false,
    })) ?? []
  const rows = (options.rows ?? []).map((row) => ({
    ...row,
    ...selection.plugins?.[row.id],
    enabled: row.enabled && selection.plugins?.[row.id]?.enabled !== false,
  }))
  if (options.rows)
    for (const id of Object.keys(selection.plugins ?? {}))
      if (!rows.some((row) => row.id === id)) fail(`unknown plugin row ${id}`)
  if (selection.loop?.id === 'default' && selection.loop.version === RELEASE_DEFAULTS.loop.version)
    selection.loop = { ...RELEASE_DEFAULTS.loop }
  if (options.catalog) validateComposition(selection, options.catalog)
  const entries = Object.values(profile.bundleCatalog ?? {})
  const selectedBundles = expandBundles(bundles, profile.bundleCatalog ?? {})
  // The existing loop picker is also an explicit composition choice. Match the full identity.
  const loopBundles = entries.filter(
    (entry) =>
      selection.loop?.id !== RELEASE_DEFAULTS.loop.id &&
      entry.document.profile?.providers?.loop?.provider === selection.loop?.id &&
      entry.document.profile?.providers?.loop?.version === selection.loop?.version,
  )
  const toolScope = profile.compositionToolScope ?? {
    bundlePackages: [...new Set(entries.map((entry) => entry.sourcePackage))].sort(),
    activePackages: [
      ...new Set([...selectedBundles, ...loopBundles].map((entry) => entry.sourcePackage)),
    ].sort(),
  }
  const tree = {
    profile: profile.name,
    preset,
    bundles: [...new Set(bundles)],
    ...(sessionBundles === undefined ? {} : { sessionBundles: [...sessionBundles] }),
    selection,
    sources,
    rows,
    toolScope,
  }
  return freezeTree({ ...tree, hash: `sha256-${sha256hex(canonicalJson(tree))}` })
}

export function validateComposition(
  selection: ResolvedCompositionSelection,
  catalog: CompositionCatalog,
): void {
  const loop = catalog.loops.find(
    (item) => item.id === selection.loop?.id && item.version === selection.loop.version,
  )
  if (selection.loop && !loop) fail(`unknown loop ${selection.loop.id}@${selection.loop.version}`)
  if (
    selection.compaction &&
    !catalog.compactionEngines.some((item) => item.id === selection.compaction?.engine)
  )
    fail(`unknown compaction engine ${selection.compaction.engine}`)
  for (const id of selection.modelAdapters ?? [])
    if (!catalog.modelAdapters.some((item) => item.id === id)) fail(`unknown model adapter ${id}`)
  if (
    loop?.capabilities.includes('compaction') &&
    (!selection.compaction ||
      !catalog.compactionEngines.some((item) => item.id === selection.compaction?.engine))
  )
    fail(`loop ${loop.id} requires compaction`)
  for (const [field, entries] of [
    ['persistence', catalog.persistenceProviders],
    ['sandbox', catalog.sandboxProviders],
  ] as const) {
    const choice = selection[field]
    if (choice && (!entries || !entries.some((item) => item.id === choice.provider)))
      fail(`unknown ${field} provider ${choice.provider}`)
  }
  if (catalog.tools)
    for (const name of [
      ...(selection.tools ?? []),
      ...(selection.toolPolicy?.allow ?? []),
      ...(selection.toolPolicy?.deny ?? []),
    ])
      if (!catalog.tools.includes(name)) fail(`unknown tool ${name}`)
  if (catalog.uiModules)
    for (const id of selection.uiModules ?? [])
      if (!catalog.uiModules.includes(id)) fail(`unknown UI module ${id}`)
}

/** Config dumps contain choices and row metadata, never arbitrary plugin config or route secrets. */
export function compositionDump(tree: ResolvedComposition) {
  const { packages: _packages, plugins: _plugins, ...selection } = tree.selection
  return {
    ...tree,
    selection,
    pluginOverrides: Object.entries(tree.selection.plugins ?? {}).map(([id, row]) => ({
      id,
      ...(row.enabled === undefined ? {} : { enabled: row.enabled }),
    })),
    packages: tree.selection.packages?.map(({ id, enabled }) => ({ id, enabled: enabled !== false })),
    rows: tree.rows.map(({ config: _config, ...row }) => row),
  }
}

/** These choices need a separate Host generation; they cannot mutate a running Kernel. */
export function assertCompositionCompatible(base: ResolvedComposition, next: ResolvedComposition): void {
  for (const key of [
    'compaction',
    'persistence',
    'sandbox',
    'packages',
    'plugins',
    'modelAdapters',
    'mcp',
    'skills',
    'uiModules',
    'surfaces',
    'shell',
    'loop',
    'tools',
    'toolPolicy',
  ] as const) {
    if (canonicalJson(base.selection[key] ?? null) !== canonicalJson(next.selection[key] ?? null))
      fail(
        `preset ${next.preset} changes ${key}; compile profileForComposition into a separate Host generation`,
      )
  }
}
