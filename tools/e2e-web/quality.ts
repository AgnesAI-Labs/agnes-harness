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
  // Ant stages entrance classes before creating an animation on a later frame. Wait for
  // that preparation too; an empty getAnimations() result alone can race the fade-in.
  // Base/active classes can remain on collapsed loading icons after motion finishes.
  // Poll active finite effects: Animation.finished can remain pending for paused effects.
  await expect
    .poll(
      () =>
        page.evaluate(() => ({
          preparing: Array.from(document.querySelectorAll('[class]')).some((element) =>
            Array.from(element.classList).some((name) =>
              /^ant-.*-(?:appear|enter|leave)-(?:prepare|start)$/.test(name),
            ),
          ),
          animations: document
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
        })),
      { message: 'Finite UI motion settles before accessibility and visual checks' },
    )
    .toEqual({ preparing: false, animations: [] })
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
  // Frame runtime status at its lower edge independently of the self-check block.
  if (name.startsWith('diagnostics-status-'))
    await page.getByTestId('diagnostics-runtime').evaluate((card) => {
      card.scrollIntoView({ block: 'end', behavior: 'instant' })
    })
  // Candidate navigation can retain the plugin pane's browser scroll anchor. The review
  // baseline frames its heading and actions from the top, independent of the previous list.
  if (name.startsWith('candidate-review-'))
    await page.getByTestId('candidate-review').evaluate((review) => {
      for (let parent = review.parentElement; parent; parent = parent.parentElement) parent.scrollTop = 0
    })
  const manifest = JSON.parse(readFileSync('tools/e2e-web/baselines/ready.json', 'utf8')) as {
    ready: string[]
    pending: Record<string, string>
  }
  const root = basename(process.cwd()).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const checkout = page.getByRole('button', { name: new RegExp(`^${root}(?: |$)`), includeHidden: true })
  // File read clocks vary by runtime; keep the localized label and normalize only its time.
  const metadata =
    name.startsWith('workbench-') || name.startsWith('narrow-workbench-')
      ? page.locator('[data-testid="turn-metadata"], .workbench-file-preview > details > summary')
      : page.getByTestId('turn-metadata')
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
        if (child.classList.contains('workspace-name')) {
          child.setAttribute('data-e2e-workspace-original', child.textContent ?? '')
          child.textContent = 'agnes-harness'
        } else if (child.tagName === 'SPAN') child.setAttribute('data-e2e-environment', 'checkout')
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
  // The demo model echoes runtime-only IDs in its job and surface receipts. Normalize
  // only those marked identifiers; keep the receipt wording, bytes, command and state.
  const jobReceipts = page.locator('#conversation-shell p')
  if (name.startsWith('workbench-p2-') || name.startsWith('fact-artifact-') || name.startsWith('narrow-'))
    await jobReceipts.evaluateAll((rows) => {
      for (const row of rows) {
        if (row.childElementCount) continue
        const original = row.textContent ?? ''
        const normalized = original
          .replace(
            /(untrusted id=")[a-f0-9]{32}(-\d+-\d+")/g,
            (_match, prefix: string, suffix: string) => `${prefix}${'0'.repeat(32)}${suffix}`,
          )
          .replace(
            /(background job )[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g,
            (_match, prefix: string) => `${prefix}00000000-0000-0000-0000-000000000000`,
          )
          .replace(
            /(\[Open review\]\(\/\?session=)[a-f0-9-]{36}(&surface=card-)([a-f0-9]+)(\))/g,
            (_match, prefix: string, surface: string, id: string, suffix: string) =>
              `${prefix}00000000-0000-0000-0000-000000000000${surface}${'0'.repeat(id.length)}${suffix}`,
          )
          .replace(
            /(\[Open review\]\(\/\?session=narrow-session&surface=card-)([a-f0-9]+)(\))/g,
            (_match, prefix: string, id: string, suffix: string) =>
              `${prefix}${'0'.repeat(id.length)}${suffix}`,
          )
        if (normalized !== original) {
          row.setAttribute('data-e2e-job-receipt-original', original)
          row.textContent = normalized
        }
      }
    })
  if (
    name.startsWith('workbench-') ||
    name.startsWith('fact-artifact-') ||
    name.startsWith('narrow-workbench-')
  ) {
    // Frame the latest completed conversation consistently after dock/viewport reflow.
    await page.getByRole('region', { name: /^(Conversation|对话)$/, exact: true }).evaluate((viewport) => {
      const behavior = viewport.style.scrollBehavior
      viewport.style.scrollBehavior = 'auto'
      viewport.scrollTop = viewport.scrollHeight
      viewport.style.scrollBehavior = behavior
    })
    const latest = page.getByRole('button', { name: /^(New content|有新内容)$/, exact: true })
    await expect(latest).toBeHidden()
    await page.mouse.move(0, 0)
  }
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
    await jobReceipts.evaluateAll((rows) => {
      for (const row of rows) {
        const original = row.getAttribute('data-e2e-job-receipt-original')
        if (original === null) continue
        row.textContent = original
        row.removeAttribute('data-e2e-job-receipt-original')
      }
    })
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
    await page.locator('[data-e2e-environment="checkout"]').evaluateAll((nodes) => {
      for (const node of nodes) node.removeAttribute('data-e2e-environment')
    })
    await page.locator('[data-e2e-workspace-original]').evaluateAll((nodes) => {
      for (const node of nodes) {
        node.textContent = node.getAttribute('data-e2e-workspace-original')
        node.removeAttribute('data-e2e-workspace-original')
      }
    })
  }
}
