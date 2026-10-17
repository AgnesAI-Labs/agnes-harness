import { cp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { build } from 'esbuild'

/** Ship an optional self-contained backend; browser code uses only the existing import map. */
export async function copyKnowledgeSources(source: string, destination: string): Promise<void> {
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  for (const name of ['client', 'README.md', 'README.zh-CN.md', 'LICENSE'])
    await cp(join(source, name), join(destination, name), {
      recursive: true,
      errorOnExist: true,
      force: false,
    })
  await build({
    entryPoints: [join(source, 'src/index.ts')],
    outfile: join(destination, 'index.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: Object.keys(pkg.agnes.hostProvidedExternals),
  })
  pkg.exports = './index.mjs'
  pkg.files = ['index.mjs', 'client', 'README.md', 'README.zh-CN.md', 'LICENSE']
  delete pkg.scripts
  delete pkg.devDependencies
  await writeFile(join(destination, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
}
