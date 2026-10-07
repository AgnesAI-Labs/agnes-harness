import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { defineConfig } = require(join(process.env.AGH_PLAYWRIGHT_PACKAGE, 'test.js'))
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  workers: 1,
  timeout: 45_000,
  outputDir: process.env.AGH_WEB_TEST_OUTPUT ?? join(tmpdir(), 'agh-web-smoke-results'),
  reporter: 'list',
  use: {
    baseURL: process.env.AGH_WEB_URL,
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
    ...(process.env.AGH_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.AGH_CHROMIUM_PATH } }
      : {}),
  },
})
