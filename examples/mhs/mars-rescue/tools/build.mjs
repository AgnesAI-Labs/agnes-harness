import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const check = process.argv.includes('--check')
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/runtime.ts', 'src/scene.ts', 'src/cameras.ts', 'src/browser-transport.ts'],
  outdir: 'client/generated',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2023',
  legalComments: 'eof',
  minify: true,
  write: !check,
})
const files = [
  'client/generated/runtime.js',
  'client/generated/scene.js',
  'client/generated/cameras.js',
  'client/generated/browser-transport.js',
]
const entries = []
for (const path of files) {
  const existing = await readFile(new URL(`../${path}`, import.meta.url)).catch(() => undefined)
  const generated = result.outputFiles?.find((file) => relative(root, file.path) === path)?.contents
  const bytes = check ? generated : existing
  if (!bytes || (check && (!existing || !Buffer.from(bytes).equals(existing))))
    throw new Error(`Stale browser resource: ${path}`)
  entries.push({
    path,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    origin:
      path.endsWith('/runtime.js') || path.endsWith('/browser-transport.js')
        ? 'Agnes simulation, MHS device SDK and bundled TypeBox'
        : 'Project-authored procedural Mars scene',
    license:
      path.endsWith('/runtime.js') || path.endsWith('/browser-transport.js')
        ? 'Apache-2.0 AND MIT'
        : 'Apache-2.0',
  })
}
for (const resource of JSON.parse(
  await readFile(new URL('../assets/third-party.json', import.meta.url), 'utf8'),
)) {
  const bytes = await readFile(new URL(`../${resource.path}`, import.meta.url))
  if (bytes.length !== resource.bytes || createHash('sha256').update(bytes).digest('hex') !== resource.sha256)
    throw new Error(`Asset integrity: ${resource.path}`)
  entries.push(resource)
}
const occupancy = await readFile(new URL('../client/assets/occupancy.png', import.meta.url))
entries.push({
  path: 'client/assets/occupancy.png',
  bytes: occupancy.length,
  sha256: createHash('sha256').update(occupancy).digest('hex'),
  origin: 'Project-authored scene obstacle footprints',
  license: 'Apache-2.0',
})
const manifest = new URL('../assets/manifest.json', import.meta.url)
const content = `${JSON.stringify({ version: 1, firstOpenNetworkDownloads: false, draco: null, resources: entries }, null, 2)}\n`
if (check) {
  if ((await readFile(manifest, 'utf8')) !== content) throw new Error('Stale resource manifest')
} else await writeFile(manifest, content)
