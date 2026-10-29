import { resolve } from 'node:path'
import { defineConfig } from '@playwright/test'
import { checkToolchain } from '../toolchain/check.mjs'

checkToolchain()

const output = resolve(process.env.AGH_WEB_TEST_OUTPUT ?? '.agnes-tmp/e2e-web')
export default defineConfig({
  testDir: '.',
  testMatch: [
    'browser.spec.ts',
    'browser-layout.spec.ts',
    'human-controls.spec.ts',
    'references.spec.ts',
    'intelligent-ui.spec.ts',
    'tool-recovery.spec.ts',
    'question-surfaces.spec.ts',
    'feedback.spec.ts',
    'large-upload.spec.ts',
    'auto-review.spec.ts',
    'memory.spec.ts',
    'webhooks.spec.ts',
    'credentials.spec.ts',
    'diagnostics.spec.ts',
    'observability.spec.ts',
    'prompt-trace.spec.ts',
    'fact-chain.spec.ts',
    'runtime.spec.ts',
    'plugin-config.spec.ts',
    'plugin-purpose.spec.ts',
    'ui-gate.spec.ts',
    'ui-flows.spec.ts',
    'answer-tables.spec.ts',
    'session-create.spec.ts',
    'session-activity.spec.ts',
    'mcp-management.spec.ts',
    'candidate-review.spec.ts',
    'first-run.spec.ts',
    'business-agents.spec.ts',
    'base-conversation.spec.ts',
    'agent-sweep.spec.ts',
    'workbench.spec.ts',
    'narrow.spec.ts',
    'v3-navigation.spec.ts',
    'v3-actions.spec.ts',
  ],
  workers: 2,
  // Every spec owns a fresh home and daemon; spread long flows across both workers.
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  failOnFlakyTests: true,
  timeout: 60_000,
  globalTimeout: (process.env.AGH_REAL_AGENT_SWEEP === '1' ? 100 : 12) * 60_000,
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
