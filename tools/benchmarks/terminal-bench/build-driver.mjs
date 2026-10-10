import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'

// node build-driver.mjs --source-root /source/agnes-harness --outfile /opt/agh/driver.mjs
const args = process.argv.slice(2)
if (
  args.length !== 4 ||
  args[0] !== '--source-root' ||
  args[2] !== '--outfile' ||
  !isAbsolute(args[1]) ||
  !isAbsolute(args[3])
)
  throw new Error('Expected --source-root ABS --outfile ABS')
const sourceRoot = resolve(args[1])
const require = createRequire(join(sourceRoot, 'packages/cli/package.json'))
const { build } = require('esbuild')
const options = {
  absWorkingDir: sourceRoot,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node24'],
  packages: 'bundle',
  sourcemap: false,
  legalComments: 'eof',
  charset: 'utf8',
  alias: {
    '@agnes/sdk': require.resolve('@agnes/sdk'),
    '@agnes/host': require.resolve('@agnes/host'),
    '@agnes/runtime-comparison': createRequire(join(sourceRoot, 'packages/host/package.json')).resolve(
      '@agnes/runtime-comparison',
    ),
    yaml: createRequire(join(sourceRoot, 'packages/host/package.json')).resolve('yaml'),
  },
  banner: {
    js: "import { createRequire as __aghCreateRequire } from 'node:module'; const require = __aghCreateRequire(import.meta.url);",
  },
  plugins: [
    {
      name: 'pricing-public-protocol-export',
      setup(build) {
        build.onResolve({ filter: /^@agnes\/protocol$/ }, () => ({
          path: require.resolve('@agnes/protocol'),
        }))
      },
    },
  ],
}
await build({
  ...options,
  entryPoints: [join(sourceRoot, 'tools/benchmarks/terminal-bench/driver.ts')],
  outfile: args[3],
})
await build({
  ...options,
  entryPoints: [join(sourceRoot, 'tools/benchmarks/terminal-bench/pricing.ts')],
  outfile: join(dirname(args[3]), 'pricing.mjs'),
})
