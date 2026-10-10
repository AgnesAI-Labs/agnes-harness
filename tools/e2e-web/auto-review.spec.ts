import { expect, test } from './fixtures.js'
import { accessible } from './quality.js'
import { chooseWorkspace, closeSettings, preferences, section, settings } from './ui.js'

test('auto review settings persist and exhausted budget escalates visibly', async ({
  page,
  runtime,
}, info) => {
  test.setTimeout(150_000)
  await preferences(page, 'en', 'light')
  await page.goto(runtime.url)
  await chooseWorkspace(page, runtime, 'en')
  // Keep the default workspace permission mode so the baseline policy still asks for approval.
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await settings(page, 'en')
  await section(page, 'security')
  await expect(page.getByTestId('auto-review-enabled')).toBeEnabled()
  await page.getByTestId('auto-review-enabled').check()
  await page.getByTestId('auto-review-tools').fill('shell')
  await page.getByTestId('auto-review-maxReviews').fill('0')
  await page.getByTestId('auto-review-save').click()
  await expect(page.getByTestId('auto-review-status')).toHaveText('Policy saved')
  await accessible(page, info, 'auto-review-settings')
  await closeSettings(page, 'en')
  const input = page.getByRole('textbox', { name: 'Task content', exact: true })
  await input.fill('call shell {"command":"printf reviewed"}')
  await input.press('Enter')
  const approval = page.getByTestId('approval-card')
  await expect(approval).toContainText('reviewer budget exhausted', { timeout: 25000 })
  await approval.locator('[data-approval-action="live:reject_once"]').click()
  await expect(approval).toBeHidden()
  await expect(page.getByTestId('conversation-turn').last()).toHaveAttribute('data-status', 'completed', {
    timeout: 25000,
  })
  await page.getByTestId('conversation-turn').last().getByTestId('turn-process-toggle').click()
  await expect(page.getByTestId('tool-review-decision')).toContainText('human approval')
  await page.getByTestId('tool-fact-chain').last().click()
  await expect(page.getByTestId('review-evidence')).toContainText('human approval')
  await page.getByTestId('review-future-ask').click()
  await expect(page.getByTestId('review-evidence')).toContainText('Explicit future rule saved')
  await preferences(page, 'zh-CN', 'dark')
  await page.reload()
  await settings(page, 'zh-CN')
  await section(page, 'security')
  await expect(page.getByTestId('auto-review-settings')).toContainText('自动审查')
  await expect(page.getByTestId('auto-review-enabled')).toBeChecked()
  await expect(page.getByTestId('auto-review-maxReviews')).toHaveValue('0')
  await expect(page.getByTestId('auto-review-settings')).toContainText('显式未来规则: 1')
})

test('reviewer defaults and session overrides are configurable from Web in both locales', async ({
  page,
  runtime,
}, info) => {
  await preferences(page, 'en', 'light')
  await page.goto(runtime.url)
  await chooseWorkspace(page, runtime, 'en')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await settings(page, 'en')
  await section(page, 'security')
  await expect(page.getByTestId('auto-review-slot-status')).toContainText('not set')
  await page.getByTestId('auto-review-model-link').click()
  await expect(page.getByTestId('auxiliary-models')).toBeVisible()
  const fast = page.getByTestId('model-slot-fast')
  await expect(fast).toBeEnabled()
  const selected = await fast.locator('option').evaluateAll((options) => {
    const model = options.find(
      (option) => (option as HTMLOptionElement).value && !(option as HTMLOptionElement).disabled,
    )
    return (model as HTMLOptionElement | undefined)?.value
  })
  expect(selected).toBeTruthy()
  await fast.selectOption(selected!)
  await page.getByTestId('model-slot-verifier').selectOption(selected!)
  await page.getByTestId('model-slots-save').click()
  await expect(page.getByTestId('model-slots-status')).toContainText('new sessions')
  await section(page, 'security')
  await expect(page.getByTestId('auto-review-slot-status')).toContainText('configured')
  await closeSettings(page, 'en')
  const input = page.getByRole('textbox', { name: 'Task content', exact: true })
  await input.fill('hello')
  await input.press('Enter')
  await expect(page.getByTestId('conversation-turn').last()).toHaveAttribute('data-status', 'completed', {
    timeout: 25000,
  })
  const primaryLabel = await page.locator('#model').textContent()
  await page.locator('#model').click()
  await page.getByTestId('session-auxiliary-models').locator('summary').click()
  await expect(page.getByTestId('session-model-slot-fast')).toHaveValue(selected!)
  await page.getByTestId('session-model-slot-verifier').selectOption(selected!)
  await page.getByTestId('session-model-slot-verifier-save').click()
  await expect(page.getByTestId('session-model-slot-status')).toContainText('saved')
  await expect(page.locator('#model')).toHaveText(primaryLabel!)
  await page.getByTestId('session-model-slot-verifier').press('Escape')
  await preferences(page, 'zh-CN', 'dark')
  await page.reload()
  await settings(page, 'zh-CN')
  await section(page, 'model')
  await expect(page.getByTestId('auxiliary-models')).toContainText('辅助模型')
  await expect(page.getByTestId('model-slot-fast')).toHaveValue(selected!)
  await page.getByTestId('model-slot-fast').selectOption('')
  await page.getByTestId('model-slots-save').click()
  await expect(page.getByTestId('model-slots-status')).toContainText('新会话')
  await section(page, 'security')
  await expect(page.getByTestId('auto-review-slot-status')).toContainText('转交人工')
  await accessible(page, info, 'auxiliary-model-reviewer-status')
})
