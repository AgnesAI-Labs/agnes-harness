// Run after copying cloud-image to tools/cloud-image in the patched Harness checkout.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = new URL('../../../', import.meta.url)
const require = createRequire(new URL('packages/cli/package.json', root))
const { build } = require('esbuild')
if (!process.argv[2]) throw new Error('Pass an absolute output .mjs path')
await build({
  entryPoints: [fileURLToPath(new URL('packages/daemon-rpc/src/local/artifact-read-authority.ts', root))],
  outfile: process.argv[2],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
})
