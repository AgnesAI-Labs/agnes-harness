import { resolve } from 'node:path'
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '../../packages/web-ui/test',
  testMatch: 'button-contrast.spec.ts',
  forbidOnly: true,
  retries: 0,
  failOnFlakyTests: true,
  workers: 1,
  timeout: 20_000,
  outputDir: resolve(process.env.AGH_WEB_TEST_OUTPUT ?? '.agnes-tmp/e2e-web', 'components'),
  reporter: 'list',
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 1200 },
    trace: 'retain-on-failure',
    ...(process.env.AGH_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.AGH_CHROMIUM_PATH } }
      : {}),
  },
})
