import { cp, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { copyImageRuntime } from './image-runtime.js'

/** esbuild's JS launcher and platform binary must remain together; its API cannot be bundled. */
export async function copyPluginPackRuntime(outputDirectory: string): Promise<void> {
  await copyImageRuntime(outputDirectory)
  const require = createRequire(import.meta.url)
  const esbuildManifest = require.resolve('esbuild/package.json')
  // pnpm installs the optional binary beside esbuild, not beside the CLI workspace symlink.
  const esbuildRequire = createRequire(esbuildManifest)
  const binary = `@esbuild/${process.platform}-${process.arch}` // guards-allow-platform: esbuild binary for this release platform
  for (const name of ['esbuild', binary]) {
    const source = dirname(
      name === 'esbuild' ? esbuildManifest : esbuildRequire.resolve(name + '/package.json'),
    )
    const destination = join(outputDirectory, 'node_modules', name)
    await mkdir(dirname(destination), { recursive: true })
    await cp(source, destination, { recursive: true, dereference: true })
  }
}
