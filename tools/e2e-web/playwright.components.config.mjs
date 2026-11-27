import { resolve } from 'node:path'
import { defineConfig } from '@playwright/test'
import { checkToolchain } from '../toolchain/check.mjs'

checkToolchain()

export default defineConfig({
  testDir: '../../packages',
  // The shared components, and the Superagent panel as the page serves it (its stylesheet under the page CSP).
  testMatch: [
    '**/web-server/test/deliverable-previews.spec.ts',
    '**/web-server/test/pdf-preview.spec.ts',
    '**/web-ui/test/button-contrast.spec.ts',
    '**/web-ui/test/primitives.spec.ts',
    '**/web-ui/test/switch.spec.ts',
    '**/superagent-ui/test/panel-styles.spec.ts',
  ],
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
