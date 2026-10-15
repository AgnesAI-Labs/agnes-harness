import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
await build({
  absWorkingDir: root,
  entryPoints: ['src/runtime.ts', 'src/scene.ts', 'src/cameras.ts'],
  outdir: 'client/generated',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2023',
  legalComments: 'eof',
  minify: true,
})
const files = ['client/generated/runtime.js', 'client/generated/scene.js', 'client/generated/cameras.js']
const entries = []
for (const path of files) {
  const bytes = await readFile(new URL(`../${path}`, import.meta.url))
  entries.push({
    path,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    origin: path.endsWith('/runtime.js')
      ? 'Agnes simulation, MHS device SDK and bundled TypeBox'
      : 'Project-authored procedural Mars scene',
    license: path.endsWith('/runtime.js') ? 'Apache-2.0 AND MIT' : 'Apache-2.0',
  })
}
await writeFile(
  new URL('../assets/manifest.json', import.meta.url),
  `${JSON.stringify({ version: 1, firstOpenNetworkDownloads: false, draco: null, resources: entries }, null, 2)}\n`,
)
