import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  bundledExamplesEntries,
  bundledPluginSource,
  createCatalog,
  createLocalExamplesCatalog,
  DEFAULT_ENABLED_BUNDLED_PACKAGES,
  hashDirectoryAsync,
  type LocalExamplesCatalog,
  OPTIONAL_BUNDLED_PACKAGES,
  staticCatalogSource,
} from '@agnes/package-manager'

/** Read the actual shipped payload; never advertise an unavailable Git fallback. */
async function helperEntry(
  helper: Pick<(typeof DEFAULT_ENABLED_BUNDLED_PACKAGES)[number], 'id' | 'license' | 'ref'>,
) {
  const source = bundledPluginSource(helper.ref)
  if (!source) throw new Error('Bundled plugin root unavailable')
  const directory = join(source.root, source.path)
  const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  if (
    pkg.name !== helper.id ||
    typeof pkg.version !== 'string' ||
    pkg.version === '0.0.0' ||
    pkg.license !== helper.license
  )
    throw new Error('Bundled helper identity mismatch')
  return {
    id: pkg.name,
    version: pkg.version,
    source: { type: 'file' as const, ref: helper.ref },
    integrity: await hashDirectoryAsync(directory),
    license: pkg.license,
    contributions: [],
    ...(pkg.agnes?.metadata ? { metadata: pkg.agnes.metadata } : {}),
    ...(Array.isArray(pkg.agnes?.provides) ? { provides: pkg.agnes.provides } : {}),
    compatibility: 'supported' as const,
  }
}

/** Keep the existing discovery hook; curated choices also work outside the development repository. */
export async function discoverLocalExamples(workspace: string): Promise<LocalExamplesCatalog> {
  const sources = [
    staticCatalogSource('builtin-plugins', async () => ({
      issuedAt: new Date().toISOString(),
      ttlMs: 86_400_000,
      entries: await Promise.all(
        [...DEFAULT_ENABLED_BUNDLED_PACKAGES, ...OPTIONAL_BUNDLED_PACKAGES].map(helperEntry),
      ),
    })),
    staticCatalogSource('official-examples', async (signal) => ({
      issuedAt: new Date().toISOString(),
      ttlMs: 86_400_000,
      entries: await bundledExamplesEntries(signal),
    })),
  ]
  if (existsSync(join(workspace, 'examples', 'packages'))) {
    sources.push(
      staticCatalogSource('local-examples', async (signal) => {
        const examples = await createLocalExamplesCatalog({ workspace, signal })
        // Creation already verified and warmed this exact catalog. A second online read
        // would inspect/hash every repository example again during the same discovery.
        const result = await examples.read({ offline: true, signal })
        return {
          issuedAt: new Date().toISOString(),
          ttlMs: 86_400_000,
          entries: result.entries.map(({ sourceId: _source, retrievedAt: _retrieved, ...entry }) => entry),
        }
      }),
    )
  }
  const catalog = createCatalog(sources, { priority: sources.map((source) => source.id) })
  // These sources are shipped or repository content, so their bytes do not go stale, yet the catalog
  // expires every snapshot after ttlMs and daemon readers stay offline. Reload once a source that had
  // loaded expires. A source that failed to load is not retried per read (a reload hashes every
  // source); it stays unavailable until the daemon restarts.
  let loaded = new Set<string>()
  const online = async (signal?: AbortSignal) => {
    const result = await catalog.read(signal ? { signal } : {})
    loaded = new Set(
      result.sources.filter((source) => source.status !== 'unavailable').map((source) => source.sourceId),
    )
    return result
  }
  // Catalog discovery is not runtime admission. Hash/inspect candidates only when
  // the catalog is first requested, so unused examples cannot block daemon readiness.
  let initialized = false
  // The catalog refuses overlapping reads, and a reload awaits its sources: serialize every read.
  let tail: Promise<unknown> = Promise.resolve()
  const read: LocalExamplesCatalog['read'] = (input = {}) => {
    const next = tail.then(async () => {
      if (!initialized) {
        const result = await online(input.signal)
        initialized = true
        return result
      }
      if (!input.offline) return online(input.signal)
      const result = await catalog.read(input)
      return result.sources.some((source) => source.status === 'unavailable' && loaded.has(source.sourceId))
        ? online(input.signal)
        : result
    })
    tail = next.catch(() => undefined)
    return next
  }
  return Object.freeze({ read })
}
