import { access, cp, mkdir, readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'

/** Preserve sharp's native codec, runtime dependencies and bundled license notices together. */
export async function copyImageRuntime(outputDirectory: string): Promise<void> {
  const require = createRequire(import.meta.url)
  const rootManifest = require.resolve('sharp/package.json', {
    paths: [join(import.meta.dirname, '../../base')],
  })
  // Native optional packages export only the binary/version subpaths, not package.json.
  async function manifestFor(resolve: NodeRequire, name: string): Promise<string | undefined> {
    for (const search of resolve.resolve.paths(name) ?? []) {
      const candidate = join(search, name, 'package.json')
      try {
        await access(candidate)
        return await realpath(candidate)
      } catch {
        /* Try the next module search root. */
      }
    }
    return undefined
  }
  const copied = new Set<string>()
  async function copy(manifest: string): Promise<void> {
    const metadata = JSON.parse(await readFile(manifest, 'utf8')) as {
      name: string
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    if (copied.has(metadata.name)) return
    copied.add(metadata.name)
    const source = dirname(manifest)
    const destination = join(outputDirectory, 'node_modules', metadata.name)
    await mkdir(dirname(destination), { recursive: true })
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: (path) => !relative(source, path).split(sep).includes('node_modules'),
    })
    const resolve = createRequire(manifest)
    for (const name of Object.keys(metadata.dependencies ?? {})) {
      const manifest = await manifestFor(resolve, name)
      if (!manifest) throw new Error(`Image runtime dependency is missing: ${name}`)
      await copy(manifest)
    }
    for (const name of Object.keys(metadata.optionalDependencies ?? {})) {
      const optional = await manifestFor(resolve, name)
      if (optional) await copy(optional)
    }
  }
  await copy(rootManifest)
}
