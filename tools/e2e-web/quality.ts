import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import type { Locator, Page, TestInfo } from '@playwright/test'
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
export async function screen(page: Page, info: TestInfo, name: string, mask: Locator[] = []) {
  await settled(page)
  // Streaming pins to the bottom; the visual contract frames the completed tool row from its start.
  if (name.startsWith('tool-row-')) {
    await page.getByRole('region', { name: /^(Conversation|对话)$/, exact: true }).evaluate((viewport) => {
      const behavior = viewport.style.scrollBehavior
      viewport.style.scrollBehavior = 'auto'
      viewport.scrollTop = 0
      viewport.style.scrollBehavior = behavior
    })
    await page.mouse.move(0, 0)
  }
  // Optional self-check content follows this card; keep the existing status frame at its lower edge.
  if (name.startsWith('diagnostics-status-'))
    await page.getByTestId('diagnostics-runtime').evaluate((card) => {
      card.scrollIntoView({ block: 'end', behavior: 'instant' })
    })
  const manifest = JSON.parse(readFileSync('tools/e2e-web/baselines/ready.json', 'utf8')) as {
    ready: string[]
    pending: Record<string, string>
  }
  const root = basename(process.cwd()).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const checkout = page.getByRole('button', { name: new RegExp(`^${root}(?: |$)`), includeHidden: true })
  const metadata = page.getByTestId('turn-metadata')
  const disk = page.getByTestId('doctor-space')
  // Runtime free space changes independently of UI. Preserve its localized sentence and geometry.
  await disk.evaluateAll((rows) => {
    for (const row of rows) {
      row.setAttribute('data-e2e-disk-original', row.textContent ?? '')
      let index = 0
      const number = new Intl.NumberFormat(document.documentElement.lang, { maximumFractionDigits: 1 })
      row.textContent = (row.textContent ?? '').replace(/\d[\d,.]*/g, () =>
        number.format(index++ === 0 ? 100 : 1000),
      )
    }
  })
  await metadata.evaluateAll((summaries) => {
    for (const summary of summaries) {
      const original = summary.textContent ?? ''
      summary.setAttribute('data-e2e-clock-original', original)
      summary.textContent = original.replace(/\d{2}:\d{2}(?:\s?[AP]M)?/, '12:00')
    }
  })
  await checkout.evaluateAll((buttons) => {
    for (const button of buttons)
      for (const child of Array.from(button.children))
        if (child.tagName === 'SPAN') child.setAttribute('data-e2e-environment', 'checkout')
  })
  await page.evaluate(
    (css) => {
      const nonce = document.querySelector<HTMLMetaElement>('meta[name="agnes-csp-nonce"]')?.content
      if (!nonce) throw new Error('The real shell must advertise its CSP style nonce')
      const style = document.createElement('style')
      style.id = 'e2e-visual-style'
      style.nonce = nonce
      style.textContent = css
      document.head.append(style)
    },
    readFileSync('tools/e2e-web/baselines/screenshot.css', 'utf8'),
  )
  const options = { animations: 'disabled' as const, fullPage: true, mask }
  try {
    await page.screenshot({ ...options, path: info.outputPath(`${name}.png`) })
    if (manifest.pending[name]) {
      info.annotations.push({ type: 'visual-baseline-pending', description: manifest.pending[name] })
      return
    }
    expect(manifest.ready, 'Every visual screen must be declared ready or explicitly pending').toContain(name)
    await expect(page).toHaveScreenshot(`${name}.png`, options)
  } finally {
    await page.evaluate(() => document.getElementById('e2e-visual-style')?.remove())
    await metadata.evaluateAll((summaries) => {
      for (const summary of summaries) {
        summary.textContent = summary.getAttribute('data-e2e-clock-original')
        summary.removeAttribute('data-e2e-clock-original')
      }
    })
    await disk.evaluateAll((rows) => {
      for (const row of rows) {
        row.textContent = row.getAttribute('data-e2e-disk-original')
        row.removeAttribute('data-e2e-disk-original')
      }
    })
    await checkout.evaluateAll((buttons) => {
      for (const button of buttons)
        for (const child of Array.from(button.children)) child.removeAttribute('data-e2e-environment')
    })
  }
}
