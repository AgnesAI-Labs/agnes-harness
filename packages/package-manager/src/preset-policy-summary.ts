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
  // No network is known only when every plugin declares capabilities and names no host.
  const declared = plugins.flatMap((plugin) => (plugin.capabilities ? [plugin.capabilities] : []))
  const network = declared.some((capabilities) => (capabilities.network?.length ?? 0) > 0)
    ? 'allowed'
    : !declared.length || declared.length !== plugins.length
      ? 'unknown'
      : 'none'
  /** Session bundles apply after the preset, in DFS order with each parent applied only once. */
  const bundleReadOnly = (name: string, initial: boolean): boolean | undefined => {
    let value: boolean | undefined = initial
    const applied = new Set<string>(),
      visiting = new Set<string>()
    const visit = (id: string) => {
      if (applied.has(id)) return
      const bundle = id.startsWith(`${packageId}#`)
        ? record(catalog[id.slice(packageId.length + 1)])
        : undefined
      if (!bundle || visiting.has(id) || visiting.size >= 64) {
        value = undefined
        return
      }
      visiting.add(id)
      for (const parent of Array.isArray(bundle.extends) ? bundle.extends : []) {
        if (typeof parent === 'string') visit(parent)
        else value = undefined
      }
      visiting.delete(id)
      applied.add(id)
      const own = record(record(bundle.profile)?.toolPolicy)?.readOnly
      if (typeof own === 'boolean') value = own
    }
    visit(`${packageId}#${name}`)
    return value
  }
  const summaries: PresetPolicySummary[] = []
  for (const [name, bundle] of Object.entries(catalog)) {
    for (const [id, raw] of Object.entries(record(record(bundle)?.presets) ?? {})) {
      const preset = record(raw) ?? {}
      const provider = record(record(preset.providers)?.['tool-policy'])?.provider
      const toolPolicy = typeof provider === 'string' ? provider : 'default'
      const own = record(record(preset.composition)?.toolPolicy)?.readOnly
      const enforced = bundleReadOnly(name, own === true)
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
