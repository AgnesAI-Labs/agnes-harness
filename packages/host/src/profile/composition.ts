import { DEFAULT_LOOP } from '@agnes/core'
import type {
  CompactionEngineCatalogEntry,
  LoopCatalogEntry,
  ModelAdapterCatalogEntry,
} from '@agnes/extension-api'
import { DEFAULT_PERSISTENCE_PROVIDER_ID, LOCAL_SANDBOX_PROVIDER_ID } from '@agnes/extension-api'
import type { JsonValue, LoopSelection } from '@agnes/protocol'
import { inspectJsonData } from '@agnes/protocol'
import { HostError } from '../errors.js'
import { mergeValue } from '../presets/merge.js'
import type { PresetDoc } from '../presets/types.js'
import { canonicalJson, sha256hex } from './canonical.js'
import { capabilityEnabled, resolveSessionCapabilities } from './session-capabilities.js'
import type { PackageRef, ResolvedProfile, RuntimeProfileManifest } from './types.js'

export type CompositionSource = Readonly<{
  layer: 'default' | 'profile' | 'preset' | 'admin' | 'session'
  name: string
}>
export type CompositionPatch = {
  loop?: LoopSelection
  modelAdapters?: string[]
  compaction?: { engine: string } | null
  persistence?: { provider: string }
  sandbox?: { provider: string }
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
export type BundleDocument = {
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
  selection: CompositionPatch
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
const fields = new Set([
  'loop',
  'modelAdapters',
  'compaction',
  'persistence',
  'sandbox',
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

/** Validate static data before it can influence package loading or runtime selection. */
export function checkCompositionPatch(value: unknown): CompositionPatch {
  const inspected = inspectJsonData(value, 1_048_576)
  if (!inspected.ok) fail('patch must be JSON data')
  value = inspected.value
  if (!map(value) || Object.keys(value).some((key) => !fields.has(key))) fail('invalid patch fields')
  for (const field of ['modelAdapters', 'tools', 'mcp', 'skills', 'uiModules'])
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
    value.loop !== undefined &&
    (!map(value.loop) ||
      !text(value.loop.id) ||
      !text(value.loop.version) ||
      Object.keys(value.loop).some((key) => !['id', 'version'].includes(key)))
  )
    fail('loop requires id and version')
  for (const [field, key] of [
    ['compaction', 'engine'],
    ['persistence', 'provider'],
    ['sandbox', 'provider'],
  ] as const) {
    const item = value[field]
    if (field === 'compaction' && item === null) continue
    if (item !== undefined && (!map(item) || !text(item[key]) || Object.keys(item).length !== 1))
      fail(`invalid ${field}.${key}`)
  }
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

/** Packages publish data in package.json agnes.bundles; no entry module is evaluated. */
export function parsePackageBundles(packageId: string, value: unknown): BundleCatalog {
  if (value === undefined) return {}
  const inspected = inspectJsonData(value, 1_048_576)
  if (!inspected.ok) fail('bundles must be JSON data')
  value = inspected.value
  if (!map(value) || Object.keys(value).length > 64) fail('agnes.bundles must be a map')
  const result: Record<string, BundleCatalogEntry> = Object.create(null)
  for (const [name, raw] of Object.entries(value)) {
    if (
      !/^[a-z][a-z0-9-]{0,63}$/.test(name) ||
      !map(raw) ||
      Object.keys(raw).some((key) => !['extends', 'profile', 'presets'].includes(key))
    )
      fail(`invalid bundle ${name}`)
    if (raw.extends !== undefined && !list(raw.extends)) fail(`invalid extends in ${name}`)
    if (raw.presets !== undefined && (!map(raw.presets) || Object.keys(raw.presets).length > 64))
      fail(`invalid presets in ${name}`)
    const presets: Record<string, PresetDoc> = {}
    for (const [preset, doc] of Object.entries((raw.presets ?? {}) as Record<string, unknown>)) {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(preset) || !map(doc) || doc.name !== preset)
        fail(`invalid preset ${preset}`)
      if (doc.composition !== undefined) checkCompositionPatch(doc.composition)
      if (doc.bundles !== undefined && !list(doc.bundles)) fail(`invalid bundles in preset ${preset}`)
      presets[preset] = structuredClone(doc) as PresetDoc
    }
    const id = `${packageId}#${name}`
    result[id] = Object.freeze({
      id,
      sourcePackage: packageId,
      document: {
        ...(raw.extends === undefined ? {} : { extends: [...(raw.extends as string[])] }),
        ...(raw.profile === undefined ? {} : { profile: checkCompositionPatch(raw.profile) }),
        ...(raw.presets === undefined ? {} : { presets }),
      },
    })
  }
  return Object.freeze(result)
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
    if (!entry) fail(`unknown bundle ${id}`)
    visiting.add(id)
    for (const parent of entry.document.extends ?? []) visit(parent)
    visiting.delete(id)
    applied.add(id)
    result.push(entry)
  }
  for (const id of ids) visit(id)
  return result
}

export function mergeComposition(base: CompositionPatch, patch: CompositionPatch): CompositionPatch {
  const result = { ...base, ...patch }
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
  return result
}

function applySource(
  sources: Record<string, CompositionSource>,
  patch: CompositionPatch,
  source: CompositionSource,
) {
  for (const [field, value] of Object.entries(patch)) {
    if (field === 'plugins') {
      for (const [id, row] of Object.entries(value as NonNullable<CompositionPatch['plugins']>))
        for (const key of Object.keys(row)) sources[`plugins.${id}.${key}`] = source
    } else if (field === 'toolPolicy') {
      for (const key of Object.keys(value as object)) sources[`toolPolicy.${key}`] = source
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
  for (const key of ['loop', 'compaction', 'persistence', 'sandbox'] as const) {
    if (manifest[key] !== undefined && (key !== 'sandbox' || manifest.sandbox?.provider !== undefined)) {
      patch = mergeComposition(patch, { [key]: manifest[key] })
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
      ...(patch.loop ? { loop: patch.loop } : {}),
      ...(patch.compaction ? { compaction: patch.compaction } : {}),
      ...(patch.persistence ? { persistence: patch.persistence } : {}),
      ...(patch.sandbox ? { sandbox: patch.sandbox } : {}),
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
  } = {},
): ResolvedComposition {
  const preset = options.preset?.name ?? profile.presets.default
  const sessionBundles = options.sessionBundles ?? profile.sessionComposition?.bundles
  if (!profile.presets.allowed.includes(preset)) fail(`preset ${preset} is not allowed`)
  let selection: CompositionPatch = {
    loop: profile.loop ?? DEFAULT_LOOP,
    compaction:
      profile.compaction ??
      (options.catalog && !options.catalog.compactionEngines.some((entry) => entry.id === 'default')
        ? null
        : { engine: 'default' }),
    persistence: profile.persistence ?? { provider: DEFAULT_PERSISTENCE_PROVIDER_ID },
    sandbox: profile.sandbox ?? { provider: LOCAL_SANDBOX_PROVIDER_ID },
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
  selection = mergeComposition(selection, profile.composition ?? {})
  Object.assign(sources, profile.compositionSources)
  for (const key of ['loop', 'compaction', 'persistence', 'sandbox'] as const)
    if (profile[key] !== undefined && (!sources[key] || sources[key]?.layer === 'default'))
      sources[key] = { layer: 'profile', name: profile.name }
  const bundles = [...(profile.bundles ?? [])]
  const apply = (patch: CompositionPatch, source: CompositionSource) => {
    selection = mergeComposition(selection, checkCompositionPatch(patch))
    applySource(sources, patch, source)
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
  if (options.preset?.composition !== undefined)
    apply(checkCompositionPatch(options.preset.composition), { layer: 'preset', name: preset })
  bundleLayer(options.admin?.bundles ?? profile.adminBundles ?? [], 'admin')
  if (options.admin?.composition) apply(options.admin.composition, { layer: 'admin', name: 'selection' })
  if (sessionBundles !== undefined) {
    if (!list(sessionBundles) || sessionBundles.length > 64) fail('invalid session bundles')
    bundleLayer(sessionBundles, 'session')
  }
  if (profile.sessionComposition?.loop)
    apply({ loop: profile.sessionComposition.loop }, { layer: 'session', name: 'request' })
  if (options.session) apply(options.session, { layer: 'session', name: 'request' })
  const packageIds = new Set(profile.packages.map((pkg) => pkg.id))
  for (const pkg of selection.packages ?? []) if (!packageIds.has(pkg.id)) fail(`unknown package ${pkg.id}`)
  selection.packages =
    selection.packages?.map((pkg) => ({
      ...pkg,
      enabled: profile.packages.find((item) => item.id === pkg.id)!.enabled && pkg.enabled !== false,
    })) ?? []
  const rows = (options.rows ?? []).map((row) => ({
    ...row,
    ...selection.plugins?.[row.id],
    enabled: row.enabled && selection.plugins?.[row.id]?.enabled !== false,
  }))
  if (options.rows)
    for (const id of Object.keys(selection.plugins ?? {}))
      if (!rows.some((row) => row.id === id)) fail(`unknown plugin row ${id}`)
  if (selection.loop?.id === 'default' && selection.loop.version === DEFAULT_LOOP.version)
    selection.loop = { ...DEFAULT_LOOP }
  if (options.catalog) validateComposition(selection, options.catalog)
  const entries = Object.values(profile.bundleCatalog ?? {})
  const selectedBundles = expandBundles(bundles, profile.bundleCatalog ?? {})
  // The existing loop picker is also an explicit composition choice. Match the full identity.
  const loopBundles = entries.filter(
    (entry) =>
      selection.loop?.id !== DEFAULT_LOOP.id &&
      entry.document.profile?.loop?.id === selection.loop?.id &&
      entry.document.profile?.loop?.version === selection.loop?.version,
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

export function validateComposition(selection: CompositionPatch, catalog: CompositionCatalog): void {
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

/** Compile a preset tree into a separate Host profile, without changing an existing session. */
export function profileForComposition(profile: ResolvedProfile, tree: ResolvedComposition): ResolvedProfile {
  const patch = tree.selection
  const { hash: _hash, compaction: _compaction, ...rest } = profile
  const capabilities = resolveSessionCapabilities({
    composition: tree,
    installed: { modelAdapters: [...new Set((profile.provider.routes ?? []).map((route) => route.api))] },
  })
  const overrides = new Map((patch.packages ?? []).map((pkg) => [pkg.id, pkg]))
  const next = {
    ...rest,
    ...(patch.loop ? { loop: patch.loop } : {}),
    ...(patch.compaction ? { compaction: patch.compaction } : {}),
    ...(patch.persistence ? { persistence: patch.persistence } : {}),
    ...(patch.sandbox ? { sandbox: patch.sandbox } : {}),
    presets: { ...profile.presets, default: tree.preset },
    ...(patch.modelAdapters?.length
      ? {
          provider: {
            ...profile.provider,
            routes: (profile.provider.routes ?? []).filter((route) =>
              capabilityEnabled(capabilities.modelAdapters, route.api),
            ),
          },
        }
      : {}),
    packages: profile.packages.map((pkg) => {
      const requested = overrides.get(pkg.id)
      return {
        ...pkg,
        ...(requested?.config ? { config: requested.config } : {}),
        enabled: capabilityEnabled(capabilities.packages, pkg.id),
      }
    }),
    composition: patch,
    compositionToolScope: tree.toolScope ?? { bundlePackages: [], activePackages: [] },
    compositionSources: tree.sources,
    ...(tree.sessionBundles !== undefined || tree.sources.loop?.layer === 'session'
      ? {
          sessionComposition: {
            ...(tree.sessionBundles === undefined ? {} : { bundles: [...tree.sessionBundles] }),
            ...(tree.sources.loop?.layer === 'session' && tree.sources.loop.name === 'request' && patch.loop
              ? { loop: patch.loop }
              : {}),
          },
        }
      : {}),
  }
  return freezeTree({ ...next, hash: `sha256-${sha256hex(canonicalJson(next))}` })
}

function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object') for (const child of Object.values(value)) freezeTree(child)
  return Object.freeze(value)
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

/** Policy is enforced at invocation, including tools scheduled outside the model tool list. */
export function compositionAllowsTool(
  selection: CompositionPatch,
  name: string,
  isReadOnly: boolean,
): boolean {
  return capabilityEnabled(
    resolveSessionCapabilities({
      selection,
      installed: { tools: [{ name, readOnly: isReadOnly }] },
    }).tools,
    name,
  )
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
