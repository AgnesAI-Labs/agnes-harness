import { existsSync } from 'node:fs'
import AxeBuilder from '@axe-core/playwright'
import type { Page, TestInfo } from '@playwright/test'
import { expect } from './fixtures.js'
import { localeKeys, unresolvedLabels } from './i18n.js'

let keys: Promise<string[]> | undefined
export async function settled(page: Page) {
  await expect
    .poll(
      () =>
        page
          .getByRole('button')
          .evaluateAll(
            (buttons) => buttons.filter((button) => button.getAttribute('aria-busy') === 'true').length,
          ),
      { message: 'Visible controls finish their pending reads before quality scans' },
    )
    .toBe(0)
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  // Poll active finite effects: Animation.finished can remain pending for paused effects.
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation.playState === 'running' &&
                Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity),
            )
            .map((animation) => ({
              currentTime: animation.currentTime,
              endTime: animation.effect?.getComputedTiming().endTime,
            })),
        ),
      { message: 'Finite UI motion settles before accessibility and visual checks' },
    )
    .toEqual([])
}
export async function translated(page: Page) {
  await settled(page)
  keys ??= localeKeys()
  const unresolved = await page.evaluate(unresolvedLabels, await keys)
  expect.soft(unresolved, 'Visible labels and accessible names must resolve their i18n keys').toEqual([])
}
export async function accessible(page: Page, info: TestInfo, name: string) {
  await settled(page)
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  await info.attach(`axe-${name}.json`, {
    body: JSON.stringify(scan.violations, null, 2),
    contentType: 'application/json',
  })
  expect
    .soft(
      scan.violations.map(({ id, nodes }) => ({
        id,
        nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
      })),
      `${name}: WCAG A/AA axe violations`,
    )
    .toEqual([])
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
