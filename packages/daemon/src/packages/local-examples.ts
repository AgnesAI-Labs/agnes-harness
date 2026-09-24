import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BUNDLED_HELPERS,
  bundledPluginSourceRoot,
  createCatalog,
  createLocalExamplesCatalog,
  hashDirectory,
  type LocalExamplesCatalog,
  staticCatalogSource,
} from '@agnes/package-manager'

/** Read the actual shipped payload; never advertise an unavailable Git fallback. */
function helperEntry(helper: (typeof BUNDLED_HELPERS)[number]) {
  const root = bundledPluginSourceRoot(helper.ref)
  if (!root) throw new Error('Bundled plugin root unavailable')
  const directory = join(root, 'bundled-plugins', helper.name)
  const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  if (pkg.name !== helper.id || pkg.version !== helper.version || pkg.license !== helper.license)
    throw new Error('Bundled helper identity mismatch')
  return {
    id: pkg.name,
    version: pkg.version,
    source: { type: 'file' as const, ref: helper.ref },
    integrity: hashDirectory(directory),
    license: pkg.license,
    contributions: [],
    compatibility: 'supported' as const,
  }
}

/** Keep the existing discovery hook; curated choices also work outside the development repository. */
export async function discoverLocalExamples(workspace: string): Promise<LocalExamplesCatalog> {
  const sources = [
    staticCatalogSource('builtin-plugins', async () => ({
      issuedAt: new Date().toISOString(),
      ttlMs: 86_400_000,
      entries: BUNDLED_HELPERS.map(helperEntry),
    })),
  ]
  if (existsSync(join(workspace, 'examples', 'packages'))) {
    sources.push(
      staticCatalogSource('local-examples', async (signal) => {
        const examples = await createLocalExamplesCatalog({ workspace, signal })
        const result = await examples.read({ signal })
        return {
          issuedAt: new Date().toISOString(),
          ttlMs: 86_400_000,
          entries: result.entries.map(({ sourceId: _source, retrievedAt: _retrieved, ...entry }) => entry),
        }
      }),
    )
  }
  const catalog = createCatalog(sources, { priority: sources.map((source) => source.id) })
  await catalog.read()
  return catalog
}
