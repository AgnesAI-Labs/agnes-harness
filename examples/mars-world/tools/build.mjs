// Bundles src/main.ts into dist/main.js for index.html.
import { build } from 'esbuild'
import { copyDraco } from './draco.mjs'

copyDraco(new URL('..', import.meta.url).pathname)

await build({
  entryPoints: [new URL('../src/main.ts', import.meta.url).pathname],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: true,
  outfile: new URL('../dist/main.js', import.meta.url).pathname,
})
