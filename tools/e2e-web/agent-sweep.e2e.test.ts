import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'

// The heavy tier starts the built distribution and Chromium. The same browser flow is
// offline by default; only the explicit opt-in permits credential setup and paid inference.
test(
  'shipped agents launch through review and run in the real browser',
  async () => {
    await access(resolve('packages/cli/dist/local/agnes.mjs'))
    const require = createRequire(import.meta.url)
    // Keep each offline invocation inside the ordinary browser gate's global deadline.
    // Playwright partitions the complete discovered inventory; no role list is maintained here.
    const real = process.env.AGH_REAL_AGENT_SWEEP === '1'
    const shards = real ? [undefined] : [1, 2, 3, 4]
    for (const shard of shards) {
      const result = await promisify(execFile)(
        process.execPath,
        [
          require.resolve('@playwright/test/cli'),
          'test',
          '--config',
          'tools/e2e-web/playwright.config.mjs',
          'agent-sweep.spec.ts',
          '--workers=1',
          ...(shard ? [`--shard=${shard}/4`] : []),
        ],
        {
          timeout: (real ? 100 : 12) * 60_000,
          maxBuffer: 4 * 1024 * 1024,
          env: {
            ...process.env,
            ...(shard
              ? {
                  AGH_WEB_TEST_OUTPUT: join(
                    process.env.AGH_WEB_TEST_OUTPUT ?? '.agnes-tmp/e2e-web',
                    `agent-shard-${shard}`,
                  ),
                }
              : {}),
          },
        },
      )
      expect(result.stdout).toMatch(/\d+ passed/)
    }
  },
  101 * 60_000,
)
