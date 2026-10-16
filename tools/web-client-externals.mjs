import { readFileSync } from 'node:fs'

/** Read the same import map copied into source, dev, local and SEA Web roots. */
export function clientImportMap(
  html = readFileSync(new URL('../packages/web/public/index.html', import.meta.url), 'utf8'),
) {
  const body = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1]
  if (!body) throw new Error('Client import map is missing')
  return JSON.parse(body).imports
}

/** Check emitted imports (including re-exports and dynamic imports), not build option patterns. */
export function assertClientExternals(metafile, imports = clientImportMap()) {
  for (const [file, output] of Object.entries(metafile.outputs)) {
    for (const item of output.imports) {
      if (!item.external) continue
      const target = Object.hasOwn(imports, item.path) ? imports[item.path] : undefined
      const prefix = Object.keys(imports).find(
        (key) => key.endsWith('/') && item.path.startsWith(key) && imports[key]?.endsWith('/'),
      )
      if (item.kind === 'require-call' || (!target && !prefix))
        throw new Error(
          `Client bundle ${file}: external ${JSON.stringify(item.path)} (${item.kind}) cannot be resolved by the served import map`,
        )
    }
  }
}

/** esbuild package externals also match every subpath; import-map keys are exact. */
export const clientPlatformExternals = {
  name: 'client-platform-externals',
  setup(build) {
    const imports = clientImportMap()
    build.onResolve({ filter: /^[^./]/ }, ({ path }) => {
      if (Object.hasOwn(imports, path)) return { path, external: true }
    })
  },
}
