import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { collectThirdPartyNotices } from '../../../tools/third-party-notices.mjs'
import { assertClientExternals } from '../../../tools/web-client-externals.mjs'

/** Ship the Hub/device implementation inside the ordinary plugin, with only public SDK externals. */
export async function prepareMhsPackage(destination: string): Promise<void> {
  const packages = fileURLToPath(new URL('../../', import.meta.url))
  const source = join(packages, 'mhs-plugin')
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  await mkdir(join(destination, 'dist/client'), { recursive: true })
  const backend = await build({
    absWorkingDir: source,
    entryPoints: [join(source, 'src/index.ts')],
    outfile: join(destination, 'dist/index.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: Object.keys(manifest.agnes.hostProvidedExternals),
    metafile: true,
    legalComments: 'eof',
    banner: {
      js: "import { createRequire as __aghCreateRequire } from 'node:module'; var require = __aghCreateRequire(import.meta.url);",
    },
  })
  const client = await build({
    absWorkingDir: source,
    entryPoints: [join(packages, 'mhs-ui/src/index.ts')],
    outfile: join(destination, 'dist/client/index.js'),
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2023',
    external: ['react', 'react/jsx-runtime', '@agnes/web-client', '@agnes/web-ui'],
    metafile: true,
    legalComments: 'eof',
  })
  assertClientExternals(client.metafile)
  manifest.exports = { '.': './dist/index.mjs' }
  delete manifest.devDependencies
  delete manifest.scripts
  await writeFile(join(destination, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  for (const name of ['agnes.client.json', 'README.md', 'README.zh-CN.md'])
    await copyFile(join(source, name), join(destination, name))
  await copyFile(join(packages, 'mhs-ui/src/style.css'), join(destination, 'dist/client/style.css'))
  await copyFile(join(packages, '../LICENSE'), join(destination, 'LICENSE'))
  await collectThirdPartyNotices(source, destination, [backend, client])
}
