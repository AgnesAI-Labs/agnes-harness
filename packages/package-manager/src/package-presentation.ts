import { join } from 'node:path'
import { type PackagePresentation, validateExtensionManifest } from '@agnes/protocol'
import { containedEntry } from './entry-path.js'
import { readStaticJson } from './integrity.js'
import { type AgnesPluginManifestEntry, parseAgnesPluginEntries } from './plugin-manifest.js'

/** Static display text/config availability, never registration or activation evidence. */
export function presentPluginRows(entries: readonly AgnesPluginManifestEntry[]): PackagePresentation {
  return {
    rows: entries.map((entry) => ({
      id: entry.id,
      ...(entry.metadata ? { metadata: structuredClone(entry.metadata) } : {}),
      settings: entry.configSchema !== undefined,
    })),
  }
}

/** Read only the exact inventory directory, including bundled public extension contracts. */
export function readPackagePresentation(directory: string, builtin: boolean): PackagePresentation {
  const pkg = readStaticJson(join(directory, 'package.json'))
  const author = pkg.agnes as { plugins?: unknown; extensions?: unknown } | undefined
  const result = presentPluginRows(parseAgnesPluginEntries(String(pkg.name), author?.plugins))
  if (builtin && Array.isArray(author?.extensions)) {
    for (const path of author.extensions) {
      if (typeof path !== 'string' || result.rows.length >= 256) throw new TypeError('Invalid bundled rows')
      const file = containedEntry(
        directory,
        `${path}/agnes.extension.json`,
        'file',
        join(directory, 'package.json'),
      )
      const manifest = validateExtensionManifest(readStaticJson(file))
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
