import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { collectThirdPartyNotices } from '../../../tools/third-party-notices.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// Match the existing browser import map: these identities must remain platform singletons.
const platformExternals = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@agnes/cordis',
  '@agnes/web-client',
  '@agnes/web-ui/assistant-ui',
  'antd',
]

export async function buildJevWeb(): Promise<void> {
  const out = join(root, 'client')
  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })
  const result = await build({
    absWorkingDir: root,
    // Asset delivery base64-encodes each file inside the bounded PackageAdmin response.
    // Split the feature surfaces so no one entry exceeds that wire budget.
    entryPoints: ['index', 'comparison-workspace', 'runtime-record-trace'].map((name) =>
      join(root, 'src', `${name}.ts`),
    ),
    outdir: out,
    splitting: true,
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2023'],
    external: platformExternals,
    metafile: true,
  })
  const styles = (await readdir(join(root, 'styles'))).filter((name) => name.endsWith('.css')).sort()
  const css = await Promise.all(styles.map((name) => readFile(join(root, 'styles', name), 'utf8')))
  // Preserve CSS extracted from bundled dependencies as well as the package-owned stylesheet.
  if (existsSync(join(out, 'index.css'))) css.unshift(await readFile(join(out, 'index.css'), 'utf8'))
  await writeFile(join(out, 'index.css'), css.join('\n'))
  for (const file of (await readdir(out)).filter((name) => /\.(js|css)$/.test(name))) {
    const base64 = (await readFile(join(out, file))).toString('base64')
    if (Buffer.byteLength(JSON.stringify({ found: true, base64 })) > 1_048_576)
      throw new Error(`Client asset exceeds the PackageAdmin response budget: ${file}`)
  }
  await writeFile(join(out, 'agnes.client.json'), await readFile(join(root, 'agnes.client.json')))
  await collectThirdPartyNotices(root, out, [result])
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await buildJevWeb()
