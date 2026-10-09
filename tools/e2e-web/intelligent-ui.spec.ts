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
    const card = page.getByTestId('intelligent-ui-inline'),
      panel = page.getByTestId('intelligent-ui-panel')
    await expect(card.getByTestId('ui-surface-finance-review')).toHaveAttribute('data-revision', '1')
    await card.getByTestId('ui-select-differences-txn-1').check()
    await card.getByTestId('ui-form-adjustment').getByRole('textbox').fill('Human reviewed mismatch')
    await card.getByTestId('ui-expand').click()
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
    await page.getByTestId('fixture-change-data').click()
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
