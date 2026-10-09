import { cp, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectThirdPartyNotices } from '../../../tools/third-party-notices.mjs'
import { namespaces } from './authoring-sdk.js'
import { copyImageRuntime } from './image-runtime.js'

/** esbuild's JS launcher and platform binary must remain together; its API cannot be bundled. */
export async function copyPluginPackRuntime(outputDirectory: string): Promise<void> {
  await copyImageRuntime(outputDirectory)
  const require = createRequire(import.meta.url)
  const { build } = require('esbuild') as typeof import('esbuild')
  const authoringBuild = await build({
    metafile: true,
    absWorkingDir: import.meta.dirname,
    legalComments: 'eof',
    entryPoints: [join(dirname(fileURLToPath(import.meta.url)), 'authoring-sdk.ts')],
    outfile: join(outputDirectory, 'authoring-sdk.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    banner: {
      js: "import { createRequire as __authoringRequire } from 'node:module'; const require = __authoringRequire(import.meta.url);",
    },
    logLevel: 'silent',
  })
  await collectThirdPartyNotices(import.meta.dirname, join(outputDirectory, 'authoring'), [authoringBuild])
  await writeFile(
    join(outputDirectory, 'authoring-sdk-exports.json'),
    JSON.stringify(
      Object.fromEntries(Object.entries(namespaces).map(([name, value]) => [name, Object.keys(value)])),
    ),
  )
  const esbuildManifest = require.resolve('esbuild/package.json')
  // pnpm installs the optional binary beside esbuild, not beside the CLI workspace symlink.
  const esbuildRequire = createRequire(esbuildManifest)
  const binary = `@esbuild/${process.platform}-${process.arch}` // guards-allow-platform: esbuild binary for this release platform
  for (const name of ['esbuild', binary]) {
    const source = dirname(
      name === 'esbuild' ? esbuildManifest : esbuildRequire.resolve(`${name}/package.json`),
    )
    const destination = join(outputDirectory, 'node_modules', name)
    await mkdir(dirname(destination), { recursive: true })
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: (path) => !relative(source, path).split(sep).includes('node_modules'),
    })
  }
}
