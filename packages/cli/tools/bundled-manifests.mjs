import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The runtime manifests of one package's bundled plugins, read from the nested `package.json` of
 * each directory its `agnes.extensions` lists. Mirrors `bundledExtensionManifest` in
 * `@agnes/extension-api`; a test pins the two together. The SEA build runs before any workspace
 * module can be imported, so it cannot call the original.
 */
export function bundledManifests(packageDirectory) {
  const pkg = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'))
  return (pkg.agnes?.extensions ?? []).map((relative) => {
    const nested = JSON.parse(readFileSync(join(packageDirectory, relative, 'package.json'), 'utf8'))
    const [entry] = nested.agnes.plugins
    return {
      id: entry.id.startsWith('ext:') ? entry.id.slice(4) : entry.id,
      version: nested.version,
      apiRange: entry.apiRange,
      entry: typeof nested.exports === 'string' ? nested.exports : nested.exports['.'],
      ...(entry.liveResources === undefined ? {} : { liveResources: entry.liveResources }),
      capabilities: entry.capabilities ?? {},
      ...(entry.contributes === undefined ? {} : { contributes: entry.contributes }),
      ...(entry.lease === undefined ? {} : { lease: entry.lease }),
      ...(entry.runtimeSupports === undefined ? {} : { runtime: { supports: entry.runtimeSupports } }),
      ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
    }
  })
}
