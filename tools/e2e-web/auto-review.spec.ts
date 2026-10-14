import { expect, test } from './fixtures.js'
import { accessible } from './quality.js'
import {
  advanced,
  chooseWorkspace,
  closeSettings,
  expand,
  expandActivityGroups,
  preferences,
  section,
  selectValue,
  settings,
} from './ui.js'

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
  await advanced(page)
  await section(page, 'security')
  await expand(page.getByTestId('auto-review-customize'))
  await expect(page.getByTestId('auto-review-enabled')).toBeEnabled()
  await page.getByTestId('auto-review-enabled').click()
  await expect(page.getByTestId('auto-review-enabled')).toBeChecked()
  await page.getByTestId('auto-review-tools').fill('shell')
  await page.getByTestId('auto-review-maxReviews').fill('0')
  await page.getByTestId('auto-review-save').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByTestId('auto-review-status')).toHaveText('Auto review saved')
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
  const reviewed = page.getByTestId('conversation-turn').last()
  await expand(reviewed.getByTestId('turn-process-toggle').locator('..'))
  await expandActivityGroups(reviewed)
  const reviewedTool = reviewed
    .locator('.timeline-node.tool')
    .filter({ has: page.getByTestId('tool-review-decision') })
  const detailToggle = reviewedTool.getByTestId('tool-detail-toggle')
  if ((await detailToggle.getAttribute('aria-expanded')) !== 'true') await detailToggle.click()
  await reviewedTool.getByTestId('tool-fact-chain').click()
  await expect(page.getByTestId('review-evidence')).toContainText('human approval')
  await page.getByTestId('review-future-ask').click()
  await expect(page.getByTestId('review-evidence')).toContainText('Explicit future rule saved')
  await preferences(page, 'zh-CN', 'dark')
  await page.reload()
  await settings(page, 'zh-CN')
  await section(page, 'security')
  await expand(page.getByTestId('auto-review-customize'))
  await expect(page.getByTestId('auto-review-settings')).toContainText('自动审阅')
  await expect(page.getByTestId('auto-review-enabled')).toBeChecked()
  await expect(page.getByTestId('auto-review-maxReviews')).toHaveValue('0')
  const rules = page
    .getByTestId('auto-review-clear-overrides')
    .locator(
      'xpath=ancestor::*[contains(@class, "agnes-settings-item") and not(contains(@class, "-control"))][1]',
    )
  await expect(rules.locator('.agnes-settings-item-label')).toHaveText('你在审批时添加的规则')
  await expect(rules.locator('.agnes-settings-item-description')).toHaveText('1 条')
  // Leaving the settings application closes its transport after React has released the controls.
  // The browser-health fixture must still observe no console errors during that teardown.
  await page.goto('about:blank')
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
  await advanced(page)
  await section(page, 'security')
  await expand(page.getByTestId('auto-review-customize'))
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
  await selectValue(page, 'model-slot-fast', selected!)
  await expect(page.getByTestId('model-slots-status')).toContainText('New sessions')
  await selectValue(page, 'model-slot-verifier', selected!)
  await expect(page.getByTestId('model-slots-status')).toContainText('New sessions')
  await section(page, 'security')
  await expand(page.getByTestId('auto-review-customize'))
  await expect(page.getByTestId('auto-review-slot-status')).toContainText('Reviewer model:')
  const [, reviewedModel] = JSON.parse(selected!) as [string, string]
  await expect(page.getByTestId('auto-review-slot-status')).toContainText(reviewedModel)
  await closeSettings(page, 'en')
  const input = page.getByRole('textbox', { name: 'Task content', exact: true })
  await input.fill('hello')
  await input.press('Enter')
  await expect(page.getByTestId('conversation-turn').last()).toHaveAttribute('data-status', 'completed', {
    timeout: 25000,
  })
  const primaryLabel = await page.locator('#model').textContent()
  await page.locator('#model').click()
  await page.getByTestId('session-auxiliary-models').locator('summary, .agh-disclosure-summary').click()
  await expect(page.getByTestId('session-model-slot-fast')).toHaveValue(selected!)
  const verifier = page.getByTestId('session-model-slot-verifier')
  const sessionModel = await verifier.locator('option').evaluateAll((options) => {
    const model = options.find(
      (option) => (option as HTMLOptionElement).value && !(option as HTMLOptionElement).disabled,
    )
    return (model as HTMLOptionElement | undefined)?.value
  })
  expect(sessionModel).toBeTruthy()
  await selectValue(page, 'session-model-slot-verifier', sessionModel!)
  await page.getByTestId('session-model-slot-verifier-save').click()
  await expect(page.getByTestId('session-model-slot-status')).toContainText('Saved')
  await expect(page.locator('#model')).toHaveText(primaryLabel!)
  await page.getByTestId('session-model-slot-verifier').press('Escape')
  await preferences(page, 'zh-CN', 'dark')
  await page.reload()
  await settings(page, 'zh-CN')
  await section(page, 'model')
  await expand(page.getByTestId('auxiliary-models'))
  await expect(page.getByTestId('auxiliary-models')).toBeVisible()
  await expect(page.getByTestId('auxiliary-models')).toContainText('辅助模型')
  await expect(page.getByTestId('model-slot-fast')).toHaveValue(selected!)
  await selectValue(page, 'model-slot-fast', '')
  await expect(page.getByTestId('model-slots-status')).toContainText('新会话')
  await section(page, 'security')
  await expand(page.getByTestId('auto-review-customize'))
  await expect(page.getByTestId('auto-review-slot-status')).toContainText('审阅会交给你确认，不会改用主模型')
  await accessible(page, info, 'auxiliary-model-reviewer-status')
})
