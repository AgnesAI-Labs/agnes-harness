import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'

// UI acceptance uses an explicitly supplied disposable server; the offline merge gate owns its own runtime.
export default defineConfig({
  testDir: '.',
  testMatch: ['navigation.spec.ts', 'conversation.spec.ts', 'ui-quality.spec.ts', 'examples.spec.ts'],
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 45_000,
  outputDir: process.env.AGH_WEB_TEST_OUTPUT ?? join(tmpdir(), 'agh-web-ui-results'),
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
