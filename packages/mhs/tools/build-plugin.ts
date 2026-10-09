/**
 * Bundles the AgnesHub plugin into plugin/dist/hub.mjs with everything it imports (ws, TypeBox),
 * because an installed plugin snapshot has no node_modules; and the Devices panel into
 * plugin/client/dist: index.js for the workbench, which provides React, and page.js for a page of
 * its own with React bundled in.
 *
 *   pnpm --filter @agnes/mhs build:plugin
 */
import { build } from 'esbuild'

await build({
  entryPoints: [new URL('../plugin/hub.ts', import.meta.url).pathname],
  outfile: new URL('../plugin/dist/hub.mjs', import.meta.url).pathname,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // ws is CommonJS and requires Node built-ins; ESM output needs a real require for them.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  // Optional native speedups of ws; it falls back to JavaScript when they are absent.
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'warning',
})
const client = (path: string) => new URL(`../plugin/client/${path}`, import.meta.url).pathname
const browser = {
  bundle: true,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  minify: true,
  sourcemap: false,
  logLevel: 'warning',
} as const
await build({
  ...browser,
  entryPoints: { index: client('src/hosts/agnes/index.tsx') },
  outdir: client('dist'),
  // The workbench provides one React for every plugin (web-client externals).
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
})
await build({ ...browser, entryPoints: { page: client('src/hosts/page/index.tsx') }, outdir: client('dist') })
console.log('built plugin/dist/hub.mjs and plugin/client/dist')
