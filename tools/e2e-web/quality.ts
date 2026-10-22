import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { scanAccessibility } from './axe.js'
import { expect } from './fixtures.js'
import { localeKeys, unresolvedLabels } from './i18n.js'
import { normalizeTraceVisual } from './trace-visual.js'

let keys: Promise<string[]> | undefined
async function scrollConversation(page: Page, start = false) {
  await page
    .getByRole('region', { name: /^(Conversation|对话)$/, exact: true })
    .evaluate((viewport, start) => {
      const behavior = viewport.style.scrollBehavior
      viewport.style.scrollBehavior = 'auto'
      viewport.scrollTop = start ? 0 : viewport.scrollHeight
      viewport.style.scrollBehavior = behavior
    }, start)
}
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
  const scan = await scanAccessibility(page)
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
  const reportFrame = /^narrow-workbench-.*-768$/.test(name)
  await page.mouse.move(0, 0)
  if (name.startsWith('new-session-')) await page.locator('#prompt').focus()
  await settled(page)
  await expect(page.locator('.agh-toast')).toHaveCount(0)
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
  // Frame the health status together with its service footer.
  if (name.startsWith('diagnostics-status-'))
    await page.getByTestId('diagnostics-doctor').evaluate((card) => {
      card.scrollIntoView({ block: 'end', behavior: 'instant' })
    })
  // Inspecting the auxiliary fields can scroll the Models page. Frame its account heading and CTA.
  if (name.startsWith('accounts-'))
    await page.locator('.config-accounts-welcome').evaluate((card) => {
      for (let parent = card.parentElement; parent; parent = parent.parentElement) parent.scrollTop = 0
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
  // Normalize the leaf text, preserving the disclosure marker, layout wrappers and React-owned DOM.
  // File read clocks vary by runtime; keep the localized label and normalize only its time.
  const metadata =
    name.startsWith('workbench-') || name.startsWith('narrow-workbench-')
      ? page.locator('[data-testid="turn-metadata"] .turn-meta-facts, [data-testid="file-meta"] time')
      : page.getByTestId('turn-metadata').locator('.turn-meta-facts')
  // Empty-process turns show the same elapsed time outside the process toggle.
  // Normalize only its runtime numbers, preserving the localized status and duration units.
  const durations = page.locator('.turn-status[data-agnes-dynamic="turn-process"]')
  await durations.evaluateAll((rows) => {
    for (const row of rows) {
      row.setAttribute('data-e2e-duration-original', row.textContent ?? '')
      row.textContent = (row.textContent ?? '').replace(/\d+(?:\.\d+)?/g, '0')
    }
  })
  // A masked locale timestamp can still reflow a narrow summary as its width changes.
  const requestClocks = page.getByTestId('request-trace').locator('time')
  await requestClocks.evaluateAll((rows) => {
    for (const row of rows) {
      row.setAttribute('data-e2e-request-clock-original', row.textContent ?? '')
      row.textContent = new Date(2026, 9, 11, 12).toLocaleString(document.documentElement.lang || 'en')
    }
  })
  // Error groups show both first and latest occurrence times. Normalize only leaf clock text;
  // keep the localized labels, error code, occurrence count and group layout in the pixel gate.
  const diagnosticClocks = page.locator('.agnes-diagnostics-when span')
  await diagnosticClocks.evaluateAll((rows) => {
    for (const row of rows) {
      if (row.childElementCount) continue
      const original = row.textContent ?? ''
      const normalized = original.replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:[\s\u202f]?[AP]M)?/g, '12:00')
      if (normalized === original) continue
      row.setAttribute('data-e2e-diagnostic-clock-original', original)
      row.textContent = normalized
    }
  })
  const disk = page
    .getByTestId('doctor-space')
    .or(page.getByTestId('doctor-check-disk').getByTestId('doctor-check-value'))
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
    (name.startsWith('fact-artifact-') &&
      !(await page.locator('#view-trace[aria-selected="true"]').count())) ||
    name.startsWith('narrow-workbench-')
  ) {
    // Frame the latest completed conversation consistently after dock/viewport reflow.
    await scrollConversation(page)
    const latest = page.getByRole('button', { name: /^(New content|有新内容)$/, exact: true })
    await expect(latest).toBeHidden()
    if (reportFrame) {
      // Earlier tool output can add fractional-height lines. Frame the report's stable start,
      // retaining both the tail-follow check above and the real history-reading affordance.
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())))
      await scrollConversation(page, true)
      const report = page.getByTestId('conversation-turn').first()
      await expect(report).toBeInViewport()
      await expect(report).toContainText('report.md')
      await expect(latest).toBeVisible()
    }
    await page.mouse.move(0, 0)
  }
  // The new workspace step can show its manual path. Normalize only the isolated
  // home-dependent value; retain the field, localized label and expanded disclosure.
  const workspacePaths = page.locator('[data-testid="first-run-guide"][data-step="workspace"] input')
  await workspacePaths.evaluateAll((nodes) => {
    for (const node of nodes as HTMLInputElement[]) {
      node.setAttribute('data-e2e-workspace-path-original', node.value)
      node.value = '/workspace/w'
    }
  })
  const workspaceChoices = page.locator(
    '.workspace-option-path, [data-workspace-path], #memory-workspace option, [data-testid="memory-root"]',
  )
  await workspaceChoices.evaluateAll((nodes) => {
    for (const node of nodes) {
      if (node.childElementCount) continue
      const original = node.textContent ?? ''
      const normalized = original.replace(/(?:\/private)?\/tmp\/agh-e2e-[^/\s]+\/w/g, '/workspace/w')
      if (normalized === original) continue
      node.setAttribute('data-e2e-workspace-choice-original', original)
      node.textContent = normalized
    }
  })
  // Screenshots disable CSS motion; use the public reduced-motion preference for JS hints too.
  const reducedMotion = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('.composer-example-hint')).toHaveCount(0)
  await settled(page)
  const restoreTrace = await normalizeTraceVisual(page)
  // Authoring provenance owns this frame. Live clock-hook records can vary outside its inspector;
  // full Trace layout and record controls retain their separate fact-chain/request pixel gates.
  const inspector = name.startsWith('fact-authoring-')
  const target = inspector ? page.locator('.trace-inspector') : page
  const options = { animations: 'disabled' as const, mask, ...(inspector ? {} : { fullPage: true }) }
  try {
    await target.screenshot({ ...options, path: info.outputPath(`${name}.png`) })
    if (process.env.AGH_SKIP_PIXEL_SNAPSHOTS === '1') {
      info.annotations.push({
        type: 'pixel-snapshot-deferred',
        description: `${name}: deferred to consolidated visual acceptance`,
      })
      return
    }
    if (manifest.pending[name]) {
      info.annotations.push({ type: 'visual-baseline-pending', description: manifest.pending[name] })
      return
    }
    expect(manifest.ready, 'Every visual screen must be declared ready or explicitly pending').toContain(name)
    await expect(target).toHaveScreenshot(`${name}.png`, options)
  } finally {
    if (reportFrame) await scrollConversation(page)
    await restoreTrace()
    await page.emulateMedia({ reducedMotion: reducedMotion ? 'reduce' : 'no-preference' })
    await workspaceChoices.evaluateAll((nodes) => {
      for (const node of nodes) {
        const original = node.getAttribute('data-e2e-workspace-choice-original')
        if (original !== null) node.textContent = original
        node.removeAttribute('data-e2e-workspace-choice-original')
      }
    })
    await workspacePaths.evaluateAll((nodes) => {
      for (const node of nodes as HTMLInputElement[]) {
        node.value = node.getAttribute('data-e2e-workspace-path-original') ?? ''
        node.removeAttribute('data-e2e-workspace-path-original')
      }
    })
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
    await durations.evaluateAll((rows) => {
      for (const row of rows) {
        row.textContent = row.getAttribute('data-e2e-duration-original')
        row.removeAttribute('data-e2e-duration-original')
      }
    })
    await requestClocks.evaluateAll((rows) => {
      for (const row of rows) {
        row.textContent = row.getAttribute('data-e2e-request-clock-original')
        row.removeAttribute('data-e2e-request-clock-original')
      }
    })
    await diagnosticClocks.evaluateAll((rows) => {
      for (const row of rows) {
        const original = row.getAttribute('data-e2e-diagnostic-clock-original')
        if (original === null) continue
        row.textContent = original
        row.removeAttribute('data-e2e-diagnostic-clock-original')
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
