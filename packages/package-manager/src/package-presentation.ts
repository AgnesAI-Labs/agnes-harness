import { join } from 'node:path'
import { bundledExtensionManifest } from '@agnes/extension-api'
import {
  type PackageContributionSummary,
  type PackagePresentation,
  validateExtensionManifest,
} from '@agnes/protocol'
import { containedEntry } from './entry-path.js'
import { readStaticJson } from './integrity.js'
import { assertCurrentPackageFormat } from './package-format.js'
import { summarizePackageIncludes } from './package-includes.js'
import {
  type AgnesPluginManifestEntry,
  type AgnesPluginProvide,
  parseAgnesPluginEntries,
  parseAgnesPluginProvides,
} from './plugin-manifest.js'
import { summarizeBundlePresets } from './preset-policy-summary.js'

/** Static display text/config availability, never registration or activation evidence. */
export function presentPluginRows(
  entries: readonly AgnesPluginManifestEntry[],
  bundles?: {
    packageId: string
    bundles: unknown
    provides?: readonly AgnesPluginProvide[] | undefined
    contributions?: readonly PackageContributionSummary[] | undefined
  },
): PackagePresentation {
  for (const entry of entries) assertCurrentPackageFormat(entry)
  const presets = bundles ? summarizeBundlePresets(bundles.packageId, bundles.bundles, entries) : []
  const includes = bundles ? summarizePackageIncludes({ ...bundles, plugins: entries }) : undefined
  return {
    ...(includes ? { includes } : {}),
    rows: entries.map((entry) => ({
      id: entry.id,
      ...(entry.metadata ? { metadata: entry.metadata } : {}),
      settings: entry.configSchema !== undefined,
    })),
    ...(presets.length ? { presets } : {}),
  }
}

/** Read only the exact inventory directory, including bundled public extension contracts. */
export function readPackagePresentation(
  directory: string,
  builtin: boolean,
  contributions?: readonly PackageContributionSummary[],
): PackagePresentation {
  const pkg = readStaticJson(join(directory, 'package.json'))
  const author = pkg.agnes as
    | { plugins?: unknown; extensions?: unknown; bundles?: unknown; provides?: unknown }
    | undefined
  const result = presentPluginRows(parseAgnesPluginEntries(String(pkg.name), author?.plugins), {
    packageId: String(pkg.name),
    bundles: author?.bundles,
    provides: parseAgnesPluginProvides(author?.provides),
    contributions,
  })
  if (builtin && Array.isArray(author?.extensions)) {
    for (const path of author.extensions) {
      if (typeof path !== 'string' || result.rows.length >= 256) throw new TypeError('Invalid bundled rows')
      const file = containedEntry(directory, `${path}/package.json`, 'file', join(directory, 'package.json'))
      const manifest = validateExtensionManifest(bundledExtensionManifest(readStaticJson(file)))
      if (!manifest.ok) throw new TypeError('Invalid bundled extension metadata')
      result.rows.push({
        id: `ext:${manifest.value.id}`,
        source: manifest.value.id,
        ...(manifest.value.metadata ? { metadata: manifest.value.metadata } : {}),
        settings: false,
      })
    }
  }
  return result
}
