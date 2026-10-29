import { type ChildProcess, spawn } from 'node:child_process'
import { expect, test } from '@playwright/test'

// Runs current production UI against a fake App Server. Backend tool authorization and
// finance business validation belong to the parallel plugin acceptance suite.
let fixture: ChildProcess, url: string
test.beforeAll(async () => {
  fixture = spawn(process.execPath, ['tools/e2e-web/serve-intelligent-ui-fixture.mjs'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  url = await new Promise<string>((resolve, reject) => {
    let output = '',
      errors = ''
    fixture.stdout?.on('data', (chunk) => {
      output += String(chunk)
      const found = output.match(/http:\/\/127\.0\.0\.1:\d+/)
      if (found) resolve(found[0])
    })
    fixture.stderr?.on('data', (chunk) => {
      errors += String(chunk)
    })
    fixture.once('error', reject)
    fixture.once('exit', (code) => reject(new Error(`Intelligent UI fixture exited ${code}: ${errors}`)))
  })
})
test.afterAll(async () => {
  if (!fixture || fixture.exitCode !== null) return
  await new Promise<void>((resolve) => {
    fixture.once('exit', () => resolve())
    fixture.kill('SIGTERM')
  })
})

for (const locale of ['en', 'zh-CN'])
  test(`finance UI shares drafts, recovers approval and re-confirms stale data (${locale})`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${url}/?locale=${locale}&theme=dark`)
    const inline = page.getByTestId('intelligent-ui-inline'),
      card = page.getByTestId('intelligent-ui-panel'),
      panel = card
    await expect(inline.getByTestId('ui-summary')).toBeVisible()
    await expect(inline.getByTestId('ui-form-adjustment')).toHaveCount(0)
    await inline.getByTestId('ui-expand').click()
    await expect(card.getByTestId('ui-surface-finance-review')).toHaveAttribute('data-revision', '1')
    await expect(card.getByTestId('ui-detail-summary')).toBeVisible()
    await expect(card.getByTestId('ui-detail-status-summary')).toContainText('needs-review')
    await expect(card.getByTestId('ui-step-flow-review')).toHaveAttribute('aria-current', 'step')
    await expect(card.getByTestId('ui-progress-posted').getByRole('progressbar')).toHaveAttribute(
      'data-percent',
      '50',
    )
    await expect(card.getByTestId('ui-image-scan')).toContainText('Receipt scan')
    await expect(card.locator('input[data-format="date"]')).toHaveValue('2026-10-10')
    await expect(card.getByTestId('ui-tab-sections-context')).toBeVisible()
    await expect(card.getByTestId('ui-tabpanel-sections-context')).toContainText(
      'Amounts stay integer USD cents.',
    )
    await expect(
      card.getByTestId('ui-tabpanel-sections-context').getByTestId('ui-form-adjustment'),
    ).toHaveCount(0)
    await card.getByTestId('ui-select-differences-txn-1').check()
    await card.getByTestId('ui-form-adjustment').getByRole('textbox').fill('Human reviewed mismatch')
    await page.getByTestId('workbench-right-toggle').click()
    await expect(card).toBeHidden()
    await inline.getByTestId('ui-expand').click()
    await expect(panel.getByTestId('ui-select-differences-txn-1')).toBeChecked()
    await expect(panel.getByTestId('ui-form-adjustment').getByRole('textbox')).toHaveValue(
      'Human reviewed mismatch',
    )
    await panel.getByTestId('ui-action-confirm').first().click()
    await panel.getByTestId('ui-confirm').evaluate((element) => {
      ;(element as HTMLButtonElement).click()
      ;(element as HTMLButtonElement).click()
    })
    await expect(page.getByTestId('fixture-command-count')).toHaveText('1')
    await expect(card.locator('[data-status="pending-approval"]')).toBeVisible()
    await page.reload()
    await expect(card.locator('[data-status="pending-approval"]')).toBeVisible()
    await expect(page.getByTestId('workbench-right-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(card.getByTestId('ui-action-confirm').first()).toBeDisabled()
    await card.getByTestId('ui-open-approval').click()
    await expect(page.getByTestId('approval-card')).toContainText('Human reviewed mismatch')
    await page
      .getByTestId('approval-action')
      .filter({ hasText: locale === 'en' ? 'Allow once' : '仅允许这次' })
      .click()
    await expect(card.locator('[data-status="succeeded"]')).toContainText('posted: false')
    await expect(card.getByTestId('ui-surface-finance-review')).toHaveAttribute('data-revision', '2')
    await card.getByTestId('ui-review-current').click()
    await card.getByTestId('ui-action-confirm').first().click()
    // This fixture control injects a concurrent backend change while the user's confirmation stays open.
    await page.getByTestId('fixture-change-data').evaluate((button) => (button as HTMLButtonElement).click())
    await card.getByTestId('ui-confirm').click()
    await expect(card.getByTestId('ui-reconfirm-message')).toContainText(
      locale === 'en' ? 'Data changed' : '数据已变化，请重新确认',
    )
    await expect(card.getByTestId('ui-surface-finance-review')).toHaveAttribute('data-revision', '3')
    await card.getByTestId('ui-review-current').click()
    await expect(card.getByTestId('ui-form-adjustment').getByRole('textbox')).toHaveValue(
      'Updated difference',
    )
    await card.getByTestId('ui-action-confirm').first().click()
    await card.getByTestId('ui-confirm').click()
    await expect(page.getByTestId('fixture-command-count')).toHaveText('3')
    await expect(card.locator('[data-status="pending-approval"]')).toHaveCount(1)
    expect(errors).toEqual([])
  })

for (const locale of ['en', 'zh-CN'])
  test(`source loading and denial retain siblings; refresh restores bound actions (${locale})`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${url}/?source=1&locale=${locale}`)
    await page.getByTestId('intelligent-ui-inline').getByTestId('ui-expand').click()
    const card = page.getByTestId('intelligent-ui-panel')
    const actions = card.getByTestId('ui-action-confirm')
    await expect(actions).toHaveCount(2)
    await expect(card.getByTestId('ui-source-loading').first()).toHaveAttribute('aria-busy', 'true')
    await expect(card.getByTestId('ui-tabpanel-sections-context')).toContainText(
      'Amounts stay integer USD cents.',
    )
    await expect(card.getByTestId('ui-form-adjustment').getByRole('textbox')).toHaveValue('Mismatch')
    for (const action of await actions.all()) await expect(action).toBeDisabled()
    await expect(card.getByTestId('ui-table-differences')).toHaveCount(0)
    const refresh = card.getByTestId('ui-source-refresh').first()
    await expect(refresh).toHaveAccessibleName(locale === 'en' ? 'Refresh differences' : '刷新 differences')
    await refresh.click()
    await expect(card.getByTestId('ui-source-error').first()).toHaveAttribute('role', 'alert')
    await expect(card.getByTestId('ui-source-error').first()).toContainText('UI_SOURCE_DENIED')
    for (const action of await actions.all()) await expect(action).toBeDisabled()
    await expect(card.getByTestId('ui-table-differences')).toHaveCount(0)
    await refresh.click()
    await expect(card.getByTestId('ui-source-error')).toHaveCount(0)
    await expect(card.getByTestId('ui-source-loading')).toHaveCount(0)
    await expect(card.getByTestId('ui-table-differences')).toContainText('275')
    for (const action of await actions.all()) await expect(action).toBeEnabled()
    await actions.first().click()
    await card.getByTestId('ui-confirm').click()
    await expect(page.getByTestId('fixture-command-count')).toHaveText('1')
    await expect(page.getByTestId('fixture-source-hashes')).toHaveText(
      JSON.stringify({ rows: 'ab'.repeat(32) }),
    )
    expect(errors).toEqual([])
  })

for (const mode of ['ready', 'blocked', 'error'])
  test(`reviewed custom renderer preserves fallback and the normal action flow (${mode})`, async ({
    page,
  }) => {
    await page.goto(`${url}/?custom=${mode}&locale=en`)
    await page.getByTestId('intelligent-ui-inline').getByTestId('ui-expand').click()
    const card = page.getByTestId('intelligent-ui-panel')
    await expect(card.getByTestId('ui-table-differences')).toBeVisible()
    if (mode !== 'ready') {
      await expect(card.getByTestId('ui-custom-fallback-custom')).toContainText(
        'Review the preset differences table.',
      )
      if (mode === 'error') await expect(card.getByTestId('ui-custom-frame-custom')).toHaveCount(0)
      const actions = card.getByTestId('ui-action-confirm')
      await expect(actions).toHaveCount(2)
      for (const action of await actions.all()) await expect(action).toBeEnabled()
      return
    }
    const frame = card.frameLocator('[data-testid="ui-custom-frame-custom"]')
    await expect(frame.getByText('Delta cents: 250')).toBeVisible()
    expect(
      await frame.locator('body').evaluate(() => ({
        fetch: typeof fetch,
        parentReadable: (() => {
          try {
            return !!parent.document
          } catch {
            return false
          }
        })(),
      })),
    ).toEqual({ fetch: 'undefined', parentReadable: false })
    await frame.getByRole('button', { name: 'Review adjustments' }).focus()
    await frame.getByRole('button', { name: 'Review adjustments' }).press('Enter')
    await expect(card.getByTestId('ui-confirmation')).toBeVisible()
    await card.getByTestId('ui-confirm').click()
    await expect(card.getByTestId('ui-open-approval')).toBeVisible()
    await expect(card.getByTestId('ui-table-differences')).toBeVisible()
  })

for (const [locale, theme, width] of [
  ['en', 'light', 1280],
  ['zh-CN', 'dark', 1280],
  ['en', 'dark', 390],
  ['zh-CN', 'light', 390],
] as const)
  test(`preset layout contains overflow and retains keyboard focus (${locale}, ${theme}, ${width})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`${url}/?locale=${locale}&theme=${theme}`)
    const inline = page.getByTestId('intelligent-ui-inline')
    const surface = inline.getByTestId('ui-surface-finance-review')
    await expect(surface).toHaveAttribute('data-revision', '1')
    await expect(surface.getByTestId('ui-expand')).toBeEnabled()
    await expect(surface.getByTestId('ui-expand')).toHaveAttribute(
      'title',
      locale === 'en' ? 'Open in workbench' : '在工作台打开',
    )
    await inline.getByTestId('ui-expand').click()
    const panel = page.getByTestId('intelligent-ui-panel')
    const fullSurface = panel.getByTestId('ui-surface-finance-review')
    await expect(fullSurface.locator('h3')).toHaveAttribute(
      'title',
      locale === 'en' ? 'Revision 1' : '版本 1',
    )
    await expect(fullSurface.getByTestId('ui-meta')).toHaveText(locale === 'en' ? 'Revision 1' : '修订 1')
    const detail = panel.getByTestId('ui-detail-summary')
    await expect(detail).toBeVisible()
    expect(await detail.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe('1px')
    const field = detail.getByTestId('ui-detail-field-summary-amountCents')
    const label = await field.locator('dt').boundingBox()
    const value = await field.locator('dd').boundingBox()
    expect(label).not.toBeNull()
    expect(value).not.toBeNull()
    const narrow = await detail.evaluate(
      (element) =>
        element.clientWidth -
          parseFloat(getComputedStyle(element).paddingLeft) -
          parseFloat(getComputedStyle(element).paddingRight) <=
        320,
    )
    if (narrow) expect(value!.y).toBeGreaterThan(label!.y)
    else expect(Math.abs(value!.y - label!.y)).toBeLessThan(2)
    const table = panel.getByTestId('ui-table-differences')
    expect(
      await table
        .locator('tbody td[data-numeric]')
        .first()
        .evaluate((element) => getComputedStyle(element).textAlign),
    ).toBe('end')
    const scroll = panel.getByRole('region', { name: 'Reconciliation (USD cents)', exact: true })
    await scroll.focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    await expect(scroll).toBeFocused()
    expect(await scroll.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('solid')
    // Ant adds a live ordinal announcement to the accessible name after focus.
    const tab = panel.getByRole('tab').filter({ hasText: 'Context' })
    await tab.focus()
    await tab.press('Enter')
    await expect(tab).toBeFocused()
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    await expect(panel.getByTestId('ui-tabpanel-sections-context')).toContainText(
      'Amounts stay integer USD cents.',
    )
    expect(await surface.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    expect(
      await panel
        .getByTestId('ui-surface-finance-review')
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(
      true,
    )
  })
