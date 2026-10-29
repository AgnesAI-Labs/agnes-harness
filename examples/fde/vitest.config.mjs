import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'

const require = createRequire(new URL('../../packages/host/package.json', import.meta.url))

// Standalone teaching packages are intentionally outside the pnpm workspace. Resolve their public
// SDK imports from the Host's installed dependencies for a focused source-checkout run.
export default defineConfig({
  resolve: {
    alias: [
      '@agnes/plugin-runtime',
      '@agnes/intelligent-ui-contract',
      '@agnes/extension-api',
      '@agnes/protocol',
      '@agnes/resource-control-runtime',
      '@sinclair/typebox',
      '@sinclair/typebox/value',
    ].map((name) => ({ find: new RegExp(`^${name}$`), replacement: require.resolve(name) })),
  },
  test: { include: ['examples/fde/*/test/workflow.test.mjs'], testTimeout: 30_000 },
})
