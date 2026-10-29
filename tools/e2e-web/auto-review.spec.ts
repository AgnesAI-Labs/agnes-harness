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
  await page.getByRole('button', { name: 'New conversation', exact: true }).click()
  await settings(page, 'en')
  await advanced(page)
  await section(page, 'security')
  await expect(page.getByTestId('auto-review-enabled')).toBeEnabled()
  await page.getByTestId('auto-review-enabled').click()
  await expect(page.getByTestId('auto-review-enabled')).toBeChecked()
  await expand(page.getByTestId('auto-review-customize'))
  await page.getByTestId('auto-review-tools').getByRole('textbox').fill('shell')
  await page.getByTestId('auto-review-tools').getByRole('textbox').press('Enter')
  await page.getByTestId('auto-review-maxReviews').fill('0')
  await page.getByTestId('auto-review-maxReviews').press('Tab')
  const client = await runtime.connect()
  await expect.poll(async () => (await client.autoReview.get()).maxReviews).toBe(0)
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
  await expand(page.getByTestId('trace-auto-review').locator('.agh-disclosure'))
  await page.getByTestId('review-future-ask').click()
  await expect(
    page.getByRole('status').filter({ hasText: 'Rule saved. Applies to future identical calls' }),
  ).toBeVisible()
  await expect.poll(async () => (await client.autoReview.get()).overrides?.length).toBe(1)
  await preferences(page, 'zh-CN', 'dark')
  await page.reload()
  await settings(page, 'zh-CN')
  await section(page, 'security')
  await expect(page.getByTestId('auto-review-settings')).toContainText('自动审阅')
  await expect(page.getByTestId('auto-review-enabled')).toBeChecked()
  await expand(page.getByTestId('auto-review-customize'))
  await expect(page.getByTestId('auto-review-maxReviews')).toHaveValue('0')
  await page.getByTestId('settings-subpage-back').click()
  const rules = page.getByTestId('auto-review-overrides')
  await expect(rules).toContainText('审批规则')
  await expect(rules).toContainText('1 条')
  await expand(rules)
  await expect(page.getByTestId('auto-review-clear-overrides')).toBeEnabled()
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
  await page.getByRole('button', { name: 'New conversation', exact: true }).click()
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
  await expect(page.getByRole('status').filter({ hasText: 'Model settings saved.' })).toBeVisible()
  await selectValue(page, 'model-slot-verifier', selected!)
  await expect(page.getByRole('status').filter({ hasText: 'Model settings saved.' })).toBeVisible()
  await section(page, 'security')
  await expand(page.getByTestId('auto-review-customize'))
  await expect(page.getByTestId('auto-review-slot-status')).toHaveCount(0)
  const [, reviewedModel] = JSON.parse(selected!) as [string, string]
  await expect(page.getByTestId('auto-review-model')).toHaveValue('fast')
  await expect(page.getByTestId('auto-review-model').locator('option:checked')).toContainText(reviewedModel)
  await closeSettings(page, 'en')
  const input = page.getByRole('textbox', { name: 'Task content', exact: true })
  await input.fill('hello')
  await input.press('Enter')
  await expect(page.getByTestId('conversation-turn').last()).toHaveAttribute('data-status', 'completed', {
    timeout: 25000,
  })
  const primaryLabel = await page.locator('#model').textContent()
  await page.locator('#model').click()
  await page.locator('#model-picker-auxiliary').click()
  const auxiliary = page.getByTestId('session-auxiliary-models')
  await expect(auxiliary).toContainText(reviewedModel)
  await auxiliary.getByTestId('session-model-slot-verifier').getByRole('combobox').click()
  await page
    .locator('.ant-select-dropdown:visible .ant-select-item-option-content')
    .filter({ hasText: /^demo-model · demo$/ })
    .click()
  await expect(page.getByRole('status').filter({ hasText: 'Background models updated.' })).toBeVisible()
  const sessionId = new URL(page.url()).searchParams.get('session')!
  const client = await runtime.connect()
  const session = await client.session.load(sessionId, { cwd: runtime.workspace })
  const [route, model] = JSON.parse(selected!) as [string, string]
  expect((await session.capabilities())?.modelRoutes.value?.fast).toEqual({ route, model })
  await expect
    .poll(async () => (await session.capabilities())?.modelRoutes.value?.verifier)
    .toEqual({ route: 'demo', model: 'demo-model' })
  await expect(page.locator('#model')).toHaveText(primaryLabel!)
  await page.keyboard.press('Escape')
  await preferences(page, 'zh-CN', 'dark')
  await page.reload()
  await settings(page, 'zh-CN')
  await section(page, 'model')
  await expand(page.getByTestId('advanced-models'))
  await expand(page.getByTestId('auxiliary-models'))
  await expect(page.getByTestId('auxiliary-models')).toBeVisible()
  await expect(page.getByTestId('auxiliary-models')).toContainText('辅助模型')
  await expect(page.getByTestId('model-slot-fast')).toHaveValue(selected!)
  await selectValue(page, 'model-slot-fast', '')
  await expect(page.getByRole('status').filter({ hasText: '已保存' })).toBeVisible()
  await section(page, 'security')
  await expand(page.getByTestId('auto-review-customize'))
  await expect(page.getByTestId('auto-review-slot-status')).toContainText('审阅会交给你确认，不会改用主模型')
  await accessible(page, info, 'auxiliary-model-reviewer-status')
})
