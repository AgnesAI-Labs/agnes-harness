import { type ChildProcess, spawn } from 'node:child_process'
import { expect, test } from '@playwright/test'

let fixture: ChildProcess, url: string
test.beforeAll(async () => {
  fixture = spawn(
    process.execPath,
    ['tools/e2e-web/serve-intelligent-ui-fixture.mjs', 'tools/e2e-web/fixtures/question-surfaces.tsx'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  url = await new Promise((resolve, reject) => {
    let output = '',
      errors = ''
    fixture.stdout?.on('data', (chunk) => {
      output += String(chunk)
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/)
      if (match) resolve(match[0])
    })
    fixture.stderr?.on('data', (chunk) => {
      errors += String(chunk)
    })
    fixture.once('error', reject)
    fixture.once('exit', (code) => reject(new Error(`${code}: ${errors}`)))
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
  test(`question forms share choices, recover receipts and preserve answers (${locale})`, async ({
    page,
  }) => {
    await page.goto(`${url}/?locale=${locale}`)
    const inline = page.getByTestId('intelligent-ui-inline')
    await expect(inline.getByTestId('ui-option-single-1')).toHaveCount(0)
    await inline.getByTestId('ui-expand').click()
    const card = page.getByTestId('intelligent-ui-panel')
    await card.getByTestId('ui-option-single-1').check()
    await card.getByTestId('ui-option-multi-0').check()
    await card.getByTestId('ui-option-multi-1').check()
    await card.getByTestId('ui-free-multi').fill('C')
    await card.getByTestId('ui-form-answers').getByRole('textbox', { name: 'Explain' }).fill('Human answer')
    await page.getByTestId('workbench-right-toggle').click()
    await expect(card).toBeHidden()
    await inline.getByTestId('ui-expand').click()
    const panel = page.getByTestId('intelligent-ui-panel')
    await expect(panel.getByTestId('ui-option-single-1')).toBeChecked()
    await expect(panel.getByTestId('ui-option-multi-1')).toBeChecked()
    await panel.getByTestId('ui-action-submit').click()
    await panel.getByTestId('ui-confirm').click()
    await expect(card.locator('[data-status=received]')).toBeVisible()
    await expect(page.getByTestId('fixture-requests')).toContainText(
      '"answers":{"single":"B","multi":["A","B","C"],"text":"Human answer"}',
    )
    await page.reload()
    await expect(card.locator('[data-status=received]')).toBeVisible()
    await expect(card.getByTestId('ui-action-submit')).toBeDisabled()
    await page.getByTestId('fixture-complete').evaluate((button) => (button as HTMLButtonElement).click())
    await expect(card.locator('[data-status=succeeded]')).toContainText('Human answer')
    await expect(card.getByTestId('ui-surface-questions')).toHaveAttribute('data-revision', '1')
  })
test('question submission rejects a stale revision and an ordinary policy refusal', async ({ page }) => {
  await page.goto(url)
  await page.getByTestId('intelligent-ui-inline').getByTestId('ui-expand').click()
  const card = page.getByTestId('intelligent-ui-panel')
  await card.getByTestId('ui-option-single-0').check()
  await card.getByTestId('ui-option-multi-0').check()
  await card.getByTestId('ui-form-answers').getByRole('textbox', { name: 'Explain' }).fill('Answer')
  await page.getByTestId('fixture-change').evaluate((button) => (button as HTMLButtonElement).click())
  await card.getByTestId('ui-action-submit').click()
  await card.getByTestId('ui-confirm').click()
  await expect(card.getByTestId('ui-reconfirm-message')).toContainText('Data changed')
  await card.getByTestId('ui-review-current').click()
  await card.getByTestId('ui-option-single-0').check()
  await card.getByTestId('ui-option-multi-0').check()
  await card.getByTestId('ui-form-answers').getByRole('textbox', { name: 'Explain' }).fill('Reviewed answer')
  await page.getByTestId('fixture-deny').evaluate((button) => (button as HTMLButtonElement).click())
  await card.getByTestId('ui-action-submit').click()
  await card.getByTestId('ui-confirm').click()
  await expect(card.locator('[data-status=rejected]').last()).toContainText('permission was denied')
})
