import type { PackageContributionSummary, PackagePresentation } from '@agnes/protocol'
import { AGNES_PLUGIN_KINDS, type AgnesPluginKind, type AgnesPluginManifestEntry } from './plugin-manifest.js'

export type PackageIncludes = NonNullable<PackagePresentation['includes']>

/**
 * What a package contains, read from package data alone.
 *
 * Tools, skills and MCP connections are usually registered in code, which inspection never runs.
 * A count therefore appears only where the data states it; the declared `agnes.kinds` still names
 * the kind, so a client shows the kind without a number rather than a guessed one.
 */
export function summarizePackageIncludes(input: {
  kinds?: readonly AgnesPluginKind[] | undefined
  plugins: readonly AgnesPluginManifestEntry[]
  bundles?: unknown
  contributions?: readonly PackageContributionSummary[] | undefined
}): PackageIncludes | undefined {
  const contributions = input.contributions ?? []
  const count = (kind: PackageContributionSummary['kind']) =>
    contributions.filter((item) => item.kind === kind).length
  const resources = new Set(input.plugins.flatMap((plugin) => plugin.capabilities?.resources ?? []))
  const found = {
    tools: new Set(
      input.plugins.flatMap((plugin) => {
        const tools = plugin.capabilities?.tools
        return (tools?.names ?? []).map((name) => `${tools?.prefix ?? ''}${name}`)
      }),
    ).size,
    skills: count('skill'),
    // No package data names an MCP connection yet; the kind comes from agnes.kinds or resources.
    mcp: 0,
    bundles:
      input.bundles && typeof input.bundles === 'object' && !Array.isArray(input.bundles)
        ? Object.keys(input.bundles).length
        : 0,
    ui: count('client') + count('surface'),
  }
  const proven: Record<AgnesPluginKind, boolean> = {
    tool: found.tools > 0,
    loop: false,
    'model-adapter': false,
    mcp: resources.has('mcp'),
    skills: found.skills > 0 || resources.has('skill'),
    ui: found.ui > 0,
    bundle: found.bundles > 0,
  }
  const kinds = AGNES_PLUGIN_KINDS.filter((kind) => input.kinds?.includes(kind) || proven[kind])
  if (!kinds.length) return undefined
  const counts: PackageIncludes['counts'] = {}
  for (const [key, value] of Object.entries(found) as [keyof typeof found, number][])
    if (value > 0) counts[key] = Math.min(value, 4096)
  return { kinds: [...kinds], counts }
}
