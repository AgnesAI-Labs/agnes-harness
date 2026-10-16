import { copyFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { assertClientExternals } from '../../../tools/web-client-externals.mjs'

/** Bundle domain dependencies; only the host's public platform modules remain external. */
export async function buildMhsClient(outdir) {
  await mkdir(outdir, { recursive: true })
  const client = await build({
    entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
    outfile: `${outdir}/index.js`,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2023',
    metafile: true,
    external: ['react', 'react/jsx-runtime', '@agnes/web-client', '@agnes/web-ui'],
  })
  assertClientExternals(client.metafile)
  await copyFile(fileURLToPath(new URL('../src/style.css', import.meta.url)), `${outdir}/style.css`)
}
