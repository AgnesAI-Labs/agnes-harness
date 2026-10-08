import { resolve } from 'node:path'
import { defineConfig } from '@playwright/test'

const output = resolve(process.env.AGH_WEB_TEST_OUTPUT ?? '.agnes-tmp/e2e-web')
export default defineConfig({
  testDir: '.',
  testMatch: ['runtime.spec.ts', 'ui-gate.spec.ts', 'ui-flows.spec.ts'],
  workers: 2,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  failOnFlakyTests: true,
  timeout: 60_000,
  globalTimeout: 8 * 60_000,
  expect: { timeout: 10_000, toHaveScreenshot: { maxDiffPixelRatio: 0.002, threshold: 0.2 } },
  outputDir: resolve(output, 'results'),
  snapshotPathTemplate: '{testDir}/baselines/{platform}/{arg}{ext}',
  updateSnapshots: process.env.AGH_UPDATE_VISUALS === '1' ? 'all' : 'none',
  reporter: [
    ['list'],
    ['html', { outputFolder: resolve(output, 'report'), open: 'never' }],
    ['json', { outputFile: resolve(output, 'results.json') }],
  ],
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 900 },
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...(process.env.AGH_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.AGH_CHROMIUM_PATH } }
      : {}),
  },
})
