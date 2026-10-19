import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'

// The heavy tier starts the built distribution and Chromium. The same browser flow is
// offline by default; only the explicit opt-in permits credential setup and paid inference.
test(
  'shipped agents launch through review and run in the real browser',
  async () => {
    await access(resolve('packages/cli/dist/local/agnes.mjs'))
    const require = createRequire(import.meta.url)
    const result = await promisify(execFile)(
      process.execPath,
      [
        require.resolve('@playwright/test/cli'),
        'test',
        '--config',
        'tools/e2e-web/playwright.config.mjs',
        'agent-sweep.spec.ts',
        '--workers=1',
      ],
      { timeout: 100 * 60_000, maxBuffer: 4 * 1024 * 1024 },
    )
    expect(result.stdout).toMatch(/\d+ passed/)
  },
  101 * 60_000,
)
