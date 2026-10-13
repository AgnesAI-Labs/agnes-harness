import type { PackagePresentation } from '@agnes/protocol'
import type { AgnesPluginManifestEntry } from './plugin-manifest.js'

export type PresetPolicySummary = NonNullable<PackagePresentation['presets']>[number]

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/**
 * What a bundle preset's policy guarantees, read from package data alone.
 *
 * Only facts the platform itself enforces count as a yes or a no. A preset that selects its own
 * tool-policy provider decides in code, which inspection never runs, so its answers are unknown
 * rather than guessed from the provider's name or the package's description.
 */
export function summarizeBundlePresets(
  packageId: string,
  bundles: unknown,
  plugins: readonly AgnesPluginManifestEntry[],
): PresetPolicySummary[] {
  const catalog = record(bundles) ?? {}
  // A package that declares capabilities and names no host has declared no network. Without any
  // declaration there is nothing to read.
  const declared = plugins.flatMap((plugin) => (plugin.capabilities ? [plugin.capabilities] : []))
  const network = !declared.length
    ? 'unknown'
    : declared.some((capabilities) => (capabilities.network?.length ?? 0) > 0)
      ? 'allowed'
      : 'none'
  /** Platform read-only through the bundle's own inheritance; a parent in another package is unseen. */
  const bundleReadOnly = (name: string, seen: Set<string>): boolean | undefined => {
    const bundle = record(catalog[name])
    if (!bundle || seen.has(name)) return undefined
    seen.add(name)
    const own = record(record(bundle.profile)?.toolPolicy)?.readOnly
    if (typeof own === 'boolean') return own
    let inherited: boolean | undefined = false
    for (const parent of Array.isArray(bundle.extends) ? [...bundle.extends].reverse() : []) {
      if (typeof parent !== 'string' || !parent.startsWith(`${packageId}#`)) return undefined
      const value = bundleReadOnly(parent.slice(packageId.length + 1), seen)
      if (value !== false) {
        inherited = value
        break
      }
    }
    return inherited
  }
  const summaries: PresetPolicySummary[] = []
  for (const [name, bundle] of Object.entries(catalog)) {
    for (const [id, raw] of Object.entries(record(record(bundle)?.presets) ?? {})) {
      const preset = record(raw) ?? {}
      const provider = record(record(preset.providers)?.['tool-policy'])?.provider
      const toolPolicy = typeof provider === 'string' ? provider : 'default'
      const own = record(record(preset.composition)?.toolPolicy)?.readOnly
      const enforced = typeof own === 'boolean' ? own : bundleReadOnly(name, new Set())
      const custom = toolPolicy !== 'default'
      summaries.push({
        bundle: `${packageId}#${name}`,
        id,
        toolPolicy,
        // The platform's read-only filter holds under any provider; without it, only the default
        // provider is known to allow writes.
        readOnly: enforced === true ? 'yes' : enforced === undefined || custom ? 'unknown' : 'no',
        // The default provider follows the session's permission mode, so the preset promises nothing.
        confirmBeforeActions: custom ? 'unknown' : 'no',
        network,
      })
    }
  }
  return summaries.slice(0, 256)
}
