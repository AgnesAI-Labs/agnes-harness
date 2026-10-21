import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProviderSelection } from '@agnes/extension-api'
import { readSandboxStartupConfig } from '@agnes/host-common/profile/sandbox-startup'
import { type ApprovalMode, type ApprovalProfile, validateCommandHooksPolicy } from '@agnes/protocol'
import { HostError, type Layer } from '../errors.js'
import { cacheDir as defaultCacheDir, dataDir as defaultDataDir } from '../paths.js'
import { assertRecipeName, DEFAULT_PERMISSION } from '../presets/permission.js'
import { canonicalJson, sha256hex } from './canonical.js'
import { prepareProfileComposition } from './composition.js'
import { DEFAULT_COMPUTER_USE, mergeComputerUse, resolveComputerUse } from './computer-use.js'
import { isolationOnlyLayer, mergeIsolation } from './isolation.js'
import {
  PROVIDER_KINDS,
  type ProviderSelections,
  readModelAdapterSelection,
  readProviderSelection,
} from './provider-selection.js'
import { providerSelectionProblems, relocatedSelection, selectionOf } from './seam-selection.js'
import { assertNoReservedRouteName, BUILTIN_PACKAGES, loadTemplate } from './templates.js'
import {
  type PackageRef,
  PROFILE_SEAM_NAMES,
  type ProfileInputs,
  type ProfileSeamName,
  type ReconcilePolicy,
  type ResolvedPackage,
  type ResolvedProfile,
  type ResolveEnv,
  type RouteDecl,
  type RuntimeProfileManifest,
} from './types.js'

type Draft = { manifest: RuntimeProfileManifest; chain: string[] }
type LayerInput = {
  layer: Layer
  label: string
  manifest: Partial<RuntimeProfileManifest> & { name?: string }
}

const APPROVAL_MODE_RANK = { off: 0, 'auto-review': 1, manual: 2 } as const satisfies Record<
  ApprovalMode,
  number
>
const SMART_MODE_REMOVED =
  'approvals.mode "smart" was removed; use "auto-review" (a model reviews tool calls and may approve them) or "manual"'
const MAX_TIMER_MS = 2_147_483_647

/** Resolve each axis independently; retired permission-level recipes require a clean home. */
function resolvePermissions(m: RuntimeProfileManifest): Pick<ResolvedProfile, 'permissions'> {
  for (const name of [m.presets?.default, ...(m.presets?.allowed ?? [])])
    if (name !== undefined) assertRecipeName(name)
  return {
    permissions: {
      default: m.permissions?.default ?? DEFAULT_PERMISSION,
      allowed: m.permissions?.allowed ?? [DEFAULT_PERMISSION],
    },
  }
}

function resolveReconcilePolicy(value: unknown, layer: Layer): ReconcilePolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HostError('E_PROFILE_FRAGMENT_KEY', 'invalid reconcile policy', {
      source: { layer },
      detail: { field: 'reconcile' },
    })
  const policy = value as Record<string, unknown>
  if (Object.keys(policy).some((key) => key !== 'point' && key !== 'maxWaitMs'))
    throw new HostError('E_PROFILE_FRAGMENT_KEY', 'invalid reconcile policy key', {
      source: { layer },
      detail: { field: 'reconcile' },
    })
  if (policy.point !== 'immediate' && policy.point !== 'turn' && policy.point !== 'step')
    throw new HostError('E_PROFILE_FRAGMENT_KEY', 'invalid reconcile.point', {
      source: { layer },
      detail: { field: 'reconcile.point' },
    })
  if (
    policy.maxWaitMs !== undefined &&
    (!Number.isInteger(policy.maxWaitMs) ||
      Number(policy.maxWaitMs) < 0 ||
      Number(policy.maxWaitMs) > MAX_TIMER_MS)
  )
    throw new HostError('E_PROFILE_FRAGMENT_KEY', 'invalid reconcile.maxWaitMs', {
      source: { layer },
      detail: { field: 'reconcile.maxWaitMs' },
    })
  if (policy.point === 'immediate' && policy.maxWaitMs !== undefined)
    throw new HostError('E_PROFILE_FRAGMENT_KEY', 'reconcile.maxWaitMs does not apply to immediate', {
      source: { layer },
      detail: { field: 'reconcile.maxWaitMs', point: policy.point },
    })
  return policy.maxWaitMs === undefined
    ? { point: policy.point }
    : { point: policy.point, maxWaitMs: policy.maxWaitMs as number }
}

function approvalProfile(value: unknown, layer: Layer): ApprovalProfile {
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Object.hasOwn(value, 'mode')
  ) {
    const mode = (value as { mode?: unknown }).mode
    if (mode === 'manual' || mode === 'off' || mode === 'auto-review') return { mode }
    if (mode === 'smart')
      throw new HostError('E_PROFILE_FRAGMENT_KEY', SMART_MODE_REMOVED, {
        source: { layer },
        detail: { field: 'approvals.mode' },
      })
  }
  throw new HostError('E_PROFILE_FRAGMENT_KEY', 'invalid approvals.mode', {
    source: { layer },
    detail: { field: 'approvals.mode' },
  })
}

function mergeApprovals(
  base: RuntimeProfileManifest['approvals'],
  next: RuntimeProfileManifest['approvals'],
  layer: Layer,
): NonNullable<RuntimeProfileManifest['approvals']> {
  const prior = approvalProfile(base ?? { mode: 'manual' }, layer).mode
  const requested = approvalProfile(next, layer).mode
  if (layer === 'workspace' && APPROVAL_MODE_RANK[requested] < APPROVAL_MODE_RANK[prior])
    throw new HostError('E_PROFILE_FRAGMENT_KEY', 'workspace cannot relax approvals.mode', {
      source: { layer },
      detail: { field: 'approvals.mode', from: prior, to: requested },
    })
  return { mode: requested }
}

function mergeManifest(
  base: RuntimeProfileManifest,
  over: Partial<RuntimeProfileManifest>,
  layer: Layer,
): RuntimeProfileManifest {
  const out: RuntimeProfileManifest = { ...base }
  for (const [k, v] of Object.entries(over) as [keyof RuntimeProfileManifest, unknown][]) {
    if (v === undefined) continue
    switch (k) {
      case 'extensionIsolation': {
        const isolation = mergeIsolation(
          base.extensionIsolation,
          v as NonNullable<RuntimeProfileManifest['extensionIsolation']>,
          layer,
        )
        if (isolation) out.extensionIsolation = isolation
        break
      }
      case 'packages':
        out.packages = mergePackages(base.packages ?? [], v as PackageRef[], layer)
        break
      case 'providers':
        // A later layer replaces a kind's selection whole; kinds it does not name are kept.
        out.providers = {
          ...(base.providers ?? {}),
          ...(v as NonNullable<RuntimeProfileManifest['providers']>),
        }
        break
      case 'sandbox':
        out.sandbox = { ...(base.sandbox ?? {}), ...(v as NonNullable<RuntimeProfileManifest['sandbox']>) }
        break
      case 'limits':
        out.limits = { ...(base.limits ?? {}), ...(v as Record<string, number>) }
        break
      case 'provider':
        out.provider = mergeProvider(
          base.provider,
          v as NonNullable<RuntimeProfileManifest['provider']>,
          layer,
        )
        break
      case 'adapters':
        out.adapters = { ...(base.adapters ?? {}), ...(v as RuntimeProfileManifest['adapters']) }
        break
      case 'presets':
        out.presets = { ...(base.presets ?? {}), ...(v as RuntimeProfileManifest['presets']) }
        break
      case 'permissions':
        out.permissions = { ...(base.permissions ?? {}), ...(v as RuntimeProfileManifest['permissions']) }
        break
      case 'policy':
        if (layer === 'workspace') {
          const previous = new Set(base.policy?.capabilityCeiling ?? [])
          const added = (v as RuntimeProfileManifest['policy'])?.capabilityCeiling?.find(
            (capability) => !previous.has(capability),
          )
          if (added !== undefined)
            throw new HostError('E_CEILING_EXCEEDED', 'workspace widens policy.capabilityCeiling', {
              source: { layer },
              detail: { capability: added },
            })
        }
        out.policy = { ...(base.policy ?? {}), ...(v as RuntimeProfileManifest['policy']) }
        break
      case 'approvals':
        out.approvals = mergeApprovals(base.approvals, v as RuntimeProfileManifest['approvals'], layer)
        break
      case 'computerUse':
        out.computerUse = mergeComputerUse(
          base.computerUse ?? DEFAULT_COMPUTER_USE,
          v as NonNullable<RuntimeProfileManifest['computerUse']>,
          layer,
        )
        break
      // Scalars and arrays (transports): the later layer wins outright.
      default:
        ;(out as Record<string, unknown>)[k] = v
    }
  }
  return out
}

/**
 * Provider routes are an allow-list, not an ordinary array setting.  A later profile layer may add
 * a route, but it may not silently replace an existing route's endpoint or credential reference:
 * that would turn a seemingly harmless local/custom overlay into a route hijack.  Keep the
 * first-declared order (which is also the default-route order) and require a different route name
 * for a genuinely separate destination.
 */
function mergeProvider(
  base: RuntimeProfileManifest['provider'] | undefined,
  over: NonNullable<RuntimeProfileManifest['provider']>,
  layer: Layer,
): NonNullable<RuntimeProfileManifest['provider']> {
  const prior = base ?? { package: '' }
  const merged = { ...prior, ...over }
  const routes = mergeRoutes(prior.routes, over.routes, layer)
  return {
    ...merged,
    ...(routes === undefined ? {} : { routes }),
  }
}

/** Merge provider route allow-lists while refusing duplicate names both within and across layers. */
export function mergeRoutes(
  base: RouteDecl[] | undefined,
  over: RouteDecl[] | undefined,
  layer: Layer,
): RouteDecl[] | undefined {
  if (over === undefined) return base === undefined ? undefined : [...base]
  const names = new Set<string>()
  for (const route of base ?? []) names.add(route.route)
  for (const route of over) {
    if (names.has(route.route))
      throw new HostError('E_PRESET_UNRESOLVED', `route ${route.route} is declared more than once`, {
        source: { layer },
        detail: { reason: 'route-duplicate', route: route.route },
      })
    names.add(route.route)
  }
  return [...(base ?? []), ...over]
}

export function mergePackages(base: PackageRef[], over: PackageRef[], layer: Layer): PackageRef[] {
  const seen = new Set<string>()
  for (const p of over) {
    if (seen.has(p.id))
      throw new HostError('E_PACKAGE_DUPLICATE', `package ${p.id} listed twice in layer ${layer}`, {
        source: { layer },
        detail: { id: p.id },
      })
    seen.add(p.id)
  }
  const byId = new Map(base.map((p) => [p.id, p] as const))
  for (const p of over)
    byId.set(
      p.id,
      p.tombstone ? { ...p, tombstone: true } : { ...(byId.get(p.id) ?? {}), ...p, tombstone: false },
    )
  return [...byId.values()]
}

/**
 * What `resolved_profile_hash` attests to: the resolved profile entire, every field of it.
 *
 * It used to be a projection - packages, seams, provider, adapters by name, transports by kind,
 * presets, policy - which left `name`, `schemaVersion`, `dataDir`, `cacheDir` and `chain` out. Two
 * profiles called `alpha` and `beta` therefore carried one hash, as did two whose ledgers lived in
 * different directories. Everything downstream reads the hash as "this configuration resolved to
 * this result"; a hash that omits part of the result says that of a resolution it did not describe.
 * Packages arrive from `finalize` sorted by id and `canonicalJson` sorts object keys, so the byte
 * sequence is a function of the values and not of the order they were built in.
 */
export function hashInput(p: Omit<ResolvedProfile, 'hash'>): unknown {
  return p
}

const PERSISTENCE_PROVIDER_ID = /^[a-z][a-z0-9._-]{0,63}$/

function assertPersistence(value: unknown, layer: Layer): { provider: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new HostError('E_PROFILE_FRAGMENT_KEY', 'providers.persistence must be an object', {
      source: { layer },
      detail: { field: 'providers.persistence' },
    })
  const provider = (value as { provider?: unknown }).provider
  if (typeof provider !== 'string' || !PERSISTENCE_PROVIDER_ID.test(provider))
    throw new HostError('E_PROFILE_FRAGMENT_KEY', 'providers.persistence.provider id is invalid', {
      source: { layer },
      detail: { field: 'providers.persistence.provider' },
    })
  return { provider }
}

export async function resolveProfile(inputs: ProfileInputs, env: ResolveEnv): Promise<ResolvedProfile> {
  // env is the caller's declaration of the running installation. Later layers read platform and now
  // off it; here it is checked rather than ignored, because a caller that forgot to fill it in would
  // otherwise get a profile that silently hashed the same.
  if (!env.agnesVersion)
    throw new HostError('E_DEP_MISSING', 'resolveProfile needs env.agnesVersion', {
      detail: { field: 'env.agnesVersion' },
    })
  for (const [layer, manifest] of [
    ['workspace', inputs.workspaceOverlay],
    ['local', inputs.local],
    ['flags', inputs.flags],
    ['managed', inputs.managed],
  ] as const)
    if (manifest && Object.hasOwn((manifest as { providers?: object }).providers ?? {}, 'persistence'))
      throw new HostError('E_PROFILE_FRAGMENT_KEY', 'providers.persistence is selected by the user profile', {
        source: { layer },
        detail: { field: 'providers.persistence', effect: 'restart-required' },
      })
  const layers = collectLayers(inputs)
  if (
    env.platform.os === 'win32' &&
    inputs.builtin === 'local-dev' &&
    !layers.some((layer) => layer.layer !== 'builtin' && layer.manifest.presets !== undefined)
  ) {
    const local = layers.find((layer) => layer.layer === 'builtin' && layer.manifest.name === 'local-dev')
    if (local)
      local.manifest = {
        ...local.manifest,
        presets: {
          default: 'standard',
          allowed: ['standard', 'standard-windows', 'minimal'],
        },
      }
  }
  for (const l of layers) {
    const relocated = relocatedSelection(l.manifest)
    if (relocated) throw new HostError('E_PROFILE_FRAGMENT_KEY', relocated, { source: { layer: l.layer } })
    assertRouteNames((l.manifest.provider as { routes?: RouteDecl[] } | undefined)?.routes, l.layer)
    if (Object.hasOwn(l.manifest, 'commandHooks')) {
      if (l.layer === 'workspace' || !validateCommandHooksPolicy(l.manifest.commandHooks).ok)
        throw new HostError('E_PROFILE_FRAGMENT_KEY', 'invalid or unauthorized command hooks policy', {
          source: { layer: l.layer },
        })
    }
    if (Object.hasOwn(l.manifest, 'approvals')) {
      const mode = approvalProfile((l.manifest as { approvals?: unknown }).approvals, l.layer).mode
      if (l.layer === 'workspace' && (mode === 'off' || mode === 'auto-review'))
        throw new HostError(
          'E_PROFILE_FRAGMENT_KEY',
          'workspace cannot enable approvals.mode off or auto-review',
          {
            source: { layer: l.layer },
            detail: { field: 'approvals.mode', mode },
          },
        )
    }
    if (Object.hasOwn(l.manifest, 'reconcile'))
      resolveReconcilePolicy((l.manifest as { reconcile?: unknown }).reconcile, l.layer)
    if (Object.hasOwn(l.manifest.providers ?? {}, 'persistence')) {
      if (l.layer !== 'user')
        throw new HostError(
          'E_PROFILE_FRAGMENT_KEY',
          'providers.persistence is selected by the user profile',
          {
            source: { layer: l.layer },
            detail: { field: 'providers.persistence', effect: 'restart-required' },
          },
        )
      assertPersistence(l.manifest.providers?.persistence, l.layer)
    }
  }
  const first = layers[0] as LayerInput
  let draft: Draft = { manifest: first.manifest as RuntimeProfileManifest, chain: [first.label] }
  for (const l of layers.slice(1)) {
    draft = {
      manifest: mergeManifest(draft.manifest, l.manifest, l.layer),
      chain: [...draft.chain, l.label],
    }
  }
  if (
    draft.manifest.bundles !== undefined ||
    draft.manifest.composition !== undefined ||
    inputs.adminBundles?.length ||
    Object.keys(inputs.bundleCatalog ?? {}).length
  ) {
    const prepared = prepareProfileComposition(
      draft.manifest,
      inputs.bundleCatalog ?? {},
      inputs.adminBundles,
    )
    draft.manifest = prepared.manifest
    const resolved = finalize(draft, inputs, env)
    const { hash: _hash, ...rest } = resolved
    const enriched = {
      ...rest,
      compositionSources: prepared.sources,
      bundleCatalog: inputs.bundleCatalog ?? {},
      bundlePresets: prepared.presets,
      ...(inputs.adminBundles ? { adminBundles: inputs.adminBundles } : {}),
    }
    return deepFreeze({ ...enriched, hash: `sha256-${sha256hex(canonicalJson(enriched))}` })
  }
  return finalize(draft, inputs, env)
}

function assertRouteNames(routes: RouteDecl[] | undefined, layer: Layer): void {
  assertNoReservedRouteName(routes, layer)
  const names = new Set<string>()
  for (const route of routes ?? []) {
    if (names.has(route.route))
      throw new HostError('E_PRESET_UNRESOLVED', `route ${route.route} is declared more than once`, {
        source: { layer },
        detail: { reason: 'route-duplicate', route: route.route },
      })
    names.add(route.route)
  }
}

function collectLayers(inputs: ProfileInputs): LayerInput[] {
  const out: LayerInput[] = []
  const template = loadTemplate(inputs.builtin)
  if (template.extends) {
    const parent = loadTemplate(template.extends)
    out.push({ layer: 'builtin', label: `builtin:${parent.name}`, manifest: parent })
    out.push({ layer: 'builtin', label: `builtin:${template.name}`, manifest: template })
  } else out.push({ layer: 'builtin', label: `builtin:${template.name}`, manifest: template })
  if (inputs.user) out.push({ layer: 'user', label: `user:${inputs.user.name}`, manifest: inputs.user })
  if (inputs.workspaceOverlay) {
    if (inputs.workspaceOverlay.packages?.some((p) => Object.hasOwn(p, 'config')))
      throw new HostError('E_WORKSPACE_UNTRUSTED', 'workspace packages may not configure transports', {
        source: { layer: 'workspace' },
        detail: { reason: 'package-config' },
      })
    const workspace = inputs.lock?.workspace
    if (!workspace)
      throw new HostError('E_WORKSPACE_UNTRUSTED', 'workspace overlay has no verified lock identity', {
        source: { layer: 'workspace' },
        detail: { reason: 'not-verified' },
      })
    out.push({
      layer: 'workspace',
      label: `workspace:${workspace.manifestId}`,
      manifest: inputs.workspaceOverlay,
    })
  }
  for (const layer of ['local', 'flags', 'managed'] as const) {
    const extensionIsolation = isolationOnlyLayer(inputs, layer)
    if (extensionIsolation) out.push({ layer, label: layer, manifest: { extensionIsolation } })
  }
  return out
}

// Object.freeze is one level deep, so a frozen profile still let
// `policy.capabilityCeiling.push('exec.unrestricted')` through - and the ceiling is a security
// control handed to seam implementations, which is exactly the kind of thing a shallow freeze
// invites someone to edit in place. Nothing here is cyclic: a resolved profile is a JSON value.
function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object')
    for (const k of Object.getOwnPropertyNames(v)) deepFreeze((v as Record<string, unknown>)[k])
  return Object.freeze(v)
}

/**
 * A leading `~` is a shell convention, and a profile is written by hand, so every path in one is
 * written with the same expectation. Nothing expanded it: `dataDir` used to default to the literal
 * string `~/.agnes`, and the local-dev template wrote the same string, so an installation that
 * configured nothing put its session database, its tables and its audit log in a **directory
 * literally named `~`** under whatever the process's working directory happened to be.
 *
 * That is the worst shape a path bug takes. It never fails: two runs from two directories get two
 * different databases, each perfectly functional, and neither says a word. A session written by one
 * cannot be resumed from the other, and the data is not where anyone would look for it.
 *
 * `~user/...` is refused rather than passed through. Passing it through is how this bug worked, and
 * guessing another account's home directory is worse than saying no. The code is the one this
 * package already uses for a profile value it cannot resolve (assemble/routes.ts uses it the same
 * way); a spelling this rare does not justify widening host's closed set of error codes.
 */
export function expandHome(path: string, homeDir: string): string {
  if (path === '~') return homeDir
  if (path.startsWith('~/')) return join(homeDir, path.slice(2))
  if (path.startsWith('~'))
    throw new HostError('E_PRESET_UNRESOLVED', `${path}: only ~ and ~/ are expanded, not ~user`, {
      detail: { reason: 'unsupported-home-reference', path },
    })
  return path
}

function finalize(draft: Draft, inputs: ProfileInputs, env: ResolveEnv): ResolvedProfile {
  const m = draft.manifest
  // Every path the profile carries, not just the one that bit us: a deployment writing `~/keys` in
  // `adapters.secrets.path` expects exactly what it expects in `dataDir`, and fixing one spelling
  // would leave three more of the same trap.
  //
  // Expanded before the hash, not after. resolved_profile_hash is meant to describe what actually
  // ran, and two machines whose `~` differs really did run against different directories -- this
  // file already refuses a layer it cannot apply for exactly that reason. An explicitly configured
  // absolute dataDir already made the hash machine-specific, so this only makes the default behave
  // like every other path.
  const home = env.homeDir ?? homedir()
  const expand = (path: string): string => expandHome(path, home)
  const lock = inputs.lock ?? { packages: {} }
  const builtin = new Set<string>(inputs.builtinPackages ?? BUILTIN_PACKAGES)
  const packages: ResolvedPackage[] = []
  for (const ref of (m.packages ?? []).filter((p) => !p.tombstone).sort((a, b) => a.id.localeCompare(b.id))) {
    const st = lock.packages[ref.id]
    if (!st) {
      // A builtin package ships inside the binary that is resolving the profile, so its presence
      // and version are facts about this build, not claims a lockfile is needed to attest -- a
      // fresh machine has no agnes-lock.json yet, and refusing it would make the bundled profiles
      // unbootable. `integrity` is a deliberate sentinel: anything matching a digest pattern would
      // be a claim nothing verified. Only the closed builtin set gets this; every other package
      // still needs a lock entry.
      if (builtin.has(ref.id) && ref.source === 'builtin') {
        packages.push({
          id: ref.id,
          version: env.agnesVersion,
          source: ref.source,
          integrity: `builtin:${env.agnesVersion}`,
          trust: 'builtin',
          enabled: ref.enabled ?? true,
          ...(ref.config === undefined ? {} : { config: structuredClone(ref.config) }),
        })
        continue
      }
      throw new HostError('E_DEP_MISSING', `package ${ref.id} is not in the lockfile`, {
        source: { layer: 'user' },
        detail: { id: ref.id },
      })
    }
    if (
      st.trust === 'builtin' &&
      (!builtin.has(ref.id) ||
        ref.source !== 'builtin' ||
        st.source?.type !== 'builtin' ||
        st.source.ref !== 'builtin' ||
        st.version !== env.agnesVersion ||
        st.integrity !== `builtin:${env.agnesVersion}`)
    )
      throw new HostError('E_LOCK_MISMATCH', `package ${ref.id} cannot claim release identity`, {
        detail: { id: ref.id, reason: 'builtin-provenance' },
      })
    packages.push({
      id: ref.id,
      version: st.version,
      source: ref.source,
      integrity: st.integrity,
      trust: st.trust,
      enabled: ref.enabled ?? st.enabled,
      ...(ref.config === undefined ? {} : { config: structuredClone(ref.config) }),
      ...(st.provides ? { provides: [...st.provides] } : {}),
    })
  }
  const problems = providerSelectionProblems(m.providers, false)
  if (problems.length)
    throw new HostError('E_PROFILE_FRAGMENT_KEY', problems.join('; '), {
      detail: { field: 'providers', problems },
    })
  const seams = {} as Record<ProfileSeamName, ProviderSelection>
  for (const name of PROFILE_SEAM_NAMES) {
    const chosen = m.providers?.[name]
    if (!chosen)
      throw new HostError('E_SEAM_MISSING', `providers.${name} has no selected implementation`, {
        detail: { seam: name },
      })
    seams[name] = selectionOf(chosen)
  }
  if (!m.provider?.package)
    throw new HostError('E_SEAM_MISSING', 'provider.package is required', {
      detail: { seam: 'provider' },
    })
  // Bundles and the composition layers contribute their own choices; the profile's are the table.
  const providers: ProviderSelections = {}
  const startup: Pick<ProviderSelections, 'persistence' | 'sandbox'> = {}
  for (const kind of PROVIDER_KINDS) {
    if (kind === 'model-adapter') {
      const chosen = readModelAdapterSelection(m.providers?.[kind])
      if (chosen) providers[kind] = chosen
    } else {
      const chosen = readProviderSelection(kind, m.providers?.[kind])
      // The two startup kinds resolve into `persistence` and `sandbox`, with the composition layers.
      if (chosen && (kind === 'persistence' || kind === 'sandbox')) startup[kind] = chosen
      else if (chosen) providers[kind] = chosen
    }
  }
  const adapterSelection = providers['model-adapter']
  const composed = m.composition?.providers
  const loop =
    providers.loop ??
    (composed?.loop ? { provider: composed.loop.provider, version: composed.loop.version } : undefined)
  const compaction =
    providers.compaction ?? (composed?.compaction ? { provider: composed.compaction.provider } : undefined)
  const persistence = composed?.persistence ?? startup.persistence
  const sandbox = readSandboxStartupConfig({
    ...((composed?.sandbox ?? startup.sandbox)
      ? { provider: (composed?.sandbox ?? startup.sandbox)?.provider }
      : {}),
    ...(m.sandbox?.options ? { options: m.sandbox.options } : {}),
  })
  const draftProfile: Omit<ResolvedProfile, 'hash'> = {
    name: m.name,
    schemaVersion: m.schemaVersion ?? 1,
    ...(loop?.version ? { loop: { id: loop.provider, version: loop.version } } : {}),
    ...(m.bundles ? { bundles: m.bundles } : {}),
    ...(m.composition ? { composition: m.composition } : {}),
    chain: draft.chain,
    packages,
    seams,
    ...(Object.keys(providers).length ? { providers } : {}),
    provider: {
      package: m.provider.package,
      adapters:
        adapterSelection === undefined
          ? [m.provider.package]
          : typeof adapterSelection.provider === 'string'
            ? [adapterSelection.provider]
            : [...adapterSelection.provider],
      ...(m.provider.routes ? { routes: m.provider.routes } : {}),
      ...(m.provider.catalog ? { catalog: m.provider.catalog } : {}),
      ...(m.provider.contract
        ? { contract: { ...m.provider.contract, dir: expand(m.provider.contract.dir) } }
        : {}),
    },
    adapters: {
      storage: m.adapters?.storage ?? 'sqlite',
      fs: m.adapters?.fs ?? 'local',
      exec: m.adapters?.exec ?? 'local',
      platform: m.adapters?.platform ?? 'host',
      secrets: m.adapters?.secrets
        ? {
            ...m.adapters.secrets,
            ...(m.adapters.secrets.path ? { path: expand(m.adapters.secrets.path) } : {}),
          }
        : { kind: 'file' },
    },
    transports: m.transports ?? [{ kind: 'stdio' }],
    dataDir: expand(m.dataDir ?? defaultDataDir(home)),
    cacheDir: expand(m.cacheDir ?? defaultCacheDir(home)),
    limits: m.limits ?? {},
    presets: { default: m.presets?.default ?? 'standard', allowed: m.presets?.allowed ?? ['standard'] },
    ...resolvePermissions(m),
    policy: {
      capabilityCeiling: m.policy?.capabilityCeiling ?? [],
      workspacePackages: m.policy?.workspacePackages ?? 'require-project-trust',
    },
    reconcile: resolveReconcilePolicy(m.reconcile ?? { point: 'immediate' }, 'builtin'),
    approvals: { mode: m.approvals?.mode ?? 'manual' },
    computerUse: resolveComputerUse(m.computerUse, undefined, 'user'),
    ...(m.extensionIsolation ? { extensionIsolation: m.extensionIsolation } : {}),
    ...(m.commandHooks ? { commandHooks: structuredClone(m.commandHooks) } : {}),
    ...(compaction ? { compaction: { engine: compaction.provider } } : {}),
    ...(persistence && persistence.provider !== 'sqlite'
      ? { persistence: { provider: persistence.provider } }
      : {}),
    ...(sandbox === undefined ? {} : { sandbox }),
    runtimes: [],
  }
  const hash = `sha256-${sha256hex(canonicalJson(hashInput(draftProfile)))}`
  return deepFreeze({ ...draftProfile, hash })
}
