import { copyFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/** Bundle domain dependencies; only the host's public platform modules remain external. */
export async function buildMhsClient(outdir) {
  await mkdir(outdir, { recursive: true })
  await build({
    entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
    outfile: `${outdir}/index.js`,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2023',
    external: ['react', 'react/jsx-runtime', '@agnes/web-client', '@agnes/web-ui'],
  })
  await copyFile(fileURLToPath(new URL('../src/style.css', import.meta.url)), `${outdir}/style.css`)
}
