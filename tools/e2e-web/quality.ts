import { existsSync } from 'node:fs'
import AxeBuilder from '@axe-core/playwright'
import type { Page, TestInfo } from '@playwright/test'
import { expect } from './fixtures.js'
import { localeKeys, unresolvedLabels } from './i18n.js'

let keys: Promise<string[]> | undefined
export async function translated(page: Page) {
  keys ??= localeKeys()
  const unresolved = await page.evaluate(unresolvedLabels, await keys)
  expect.soft(unresolved, 'Visible labels and accessible names must resolve their i18n keys').toEqual([])
}
export async function accessible(page: Page, info: TestInfo, name: string) {
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  await info.attach(`axe-${name}.json`, {
    body: JSON.stringify(scan.violations, null, 2),
    contentType: 'application/json',
  })
  expect.soft(scan.violations, `${name}: WCAG A/AA axe violations`).toEqual([])
}
export async function screen(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(`${name}.png`), animations: 'disabled', fullPage: true })
  if (existsSync('tools/e2e-web/baselines/ready.json')) {
    await expect(page).toHaveScreenshot(`${name}.png`, { animations: 'disabled', fullPage: true })
  } else {
    info.annotations.push({
      type: 'visual-baseline-pending',
      description: 'Establish reviewed baselines after the UI overhaul is integrated.',
    })
  }
}
