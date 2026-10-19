import { HostError } from '@agnes/host-common/errors'
import { presetNameAllowed } from '@agnes/host-common/presets/admission'
import { mergeValue } from '@agnes/host-common/presets/merge'
import { resolvePreset } from '@agnes/host-common/presets/resolve'
import type { PresetDoc } from '@agnes/host-common/presets/types'
import { type BundleCatalog, sessionBundlePresets } from '@agnes/host-common/profile/composition'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'

/** Replace installed boot-time bundles while retaining builtin and explicit transient bundle data. */
export function sessionBundleCatalog(
  profile: ResolvedProfile,
  published?: BundleCatalog,
  runtimePackages: ReadonlySet<string> = new Set(),
): BundleCatalog {
  if (!published) return profile.bundleCatalog ?? {}
  const installed = new Map(profile.packages.map((pkg) => [pkg.id, pkg.trust]))
  return {
    ...Object.fromEntries(
      Object.entries(profile.bundleCatalog ?? {}).filter(
        ([, entry]) =>
          (!installed.has(entry.sourcePackage) && !runtimePackages.has(entry.sourcePackage)) ||
          installed.get(entry.sourcePackage) === 'builtin',
      ),
    ),
    ...published,
  }
}

const routeName = (value: unknown): unknown =>
  value && typeof value === 'object' ? (value as { route?: unknown }).route : value

/** Whether every route the preset itself names is one this deployment declares. */
function routesServed(doc: PresetDoc, served: ReadonlySet<string>): boolean {
  const routes = (doc.model as { route?: Record<string, unknown> } | undefined)?.route ?? {}
  return Object.values(routes).every((value) => {
    const name = routeName(value)
    return typeof name !== 'string' || name === 'default' || served.has(name)
  })
}

/**
 * A bundle picked for one session keeps its policy, but a model route the deployment does not
 * serve cannot be honoured: the preset then follows the routing it inherits, as any new session
 * does. Bundles an operator selects for the deployment stay strict.
 */
function withoutModel(doc: PresetDoc): PresetDoc {
  const { model: _unserved, ...rest } = doc as PresetDoc & { model?: unknown }
  return rest as PresetDoc
}

/**
 * A bundle states its policy in its presets. Selecting it for one session pins those presets into
 * this session's profile only: the deployment profile and its allowed list stay as they were, and
 * no restart is involved.
 */
export function admitSessionBundlePresets<P extends ResolvedProfile>(
  admission: P,
  host: { presets: Record<string, PresetDoc> },
  input: { preset?: string; bundles?: readonly string[]; strict?: boolean },
): {
  /** The session's own profile, carrying the bundle presets it may use. */
  profile: P
  /** What the composition compiler reads from that profile beside the deployment's own fields. */
  scope: { bundleCatalog: BundleCatalog; presets: ResolvedProfile['presets'] }
  preset: PresetDoc
} {
  const served = new Set((admission.provider.routes ?? []).map((route) => route.route))
  const offered = Object.fromEntries(
    Object.entries(
      input.bundles?.length ? sessionBundlePresets(input.bundles, admission.bundleCatalog ?? {}) : {},
    ).map(([name, doc]) => {
      return [name, input.strict || routesServed(doc, served) ? doc : withoutModel(doc)]
    }),
  )
  const names = Object.keys(offered)
  const merged = (base: Record<string, PresetDoc> | undefined) => ({
    ...base,
    ...Object.fromEntries(names.map((name) => [name, mergeValue(base?.[name], offered[name]) as PresetDoc])),
  })
  const profile = names.length
    ? {
        ...admission,
        bundlePresets: merged(admission.bundlePresets),
        presets: {
          ...admission.presets,
          allowed: [...new Set([...admission.presets.allowed, ...names])],
        },
      }
    : admission
  // One offered preset is the bundle's own choice; several need the caller to name one.
  const preset = input.preset ?? (names.length === 1 ? (names[0] as string) : admission.presets.default)
  if (!presetNameAllowed(profile, preset))
    throw new HostError('E_PRESET_UNSUPPORTED', `preset ${preset} is not in presets.allowed`, {
      detail: { reason: 'preset-not-allowed', preset },
    })
  return {
    profile,
    scope: { bundleCatalog: profile.bundleCatalog ?? {}, presets: profile.presets },
    preset: resolvePreset(preset, merged(host.presets), { limits: admission.limits }).doc,
  }
}
