import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startProviderFixture } from '../acceptance/provider-fixture.js'
import { firstRunSnapshots } from './first-run-snapshots.js'
import { expect, test } from './fixtures.js'
import { accessible, screen, translated } from './quality.js'
import { closeSettings, expand, fullAccess, preferences, send, settings } from './ui.js'

// The behavioral gate uses the same real flows without the decorative replay/pixel matrix.
const behaviorOnly = process.env.AGH_BEHAVIOR_ONLY === '1'
for (const locale of ['en', 'zh-CN']) {
  test.describe(`first-run ${locale}`, () => {
    test.describe.configure({ mode: 'serial' })
    let snapshots: Awaited<ReturnType<typeof firstRunSnapshots>> | undefined
    test.beforeAll(async () => {
      if (!behaviorOnly) snapshots = await firstRunSnapshots()
    })
    test.afterAll(async () => {
      await snapshots?.close()
    })
    test(`guided first run ${locale}/light/1440`, async ({ page, runtime }, info) => {
      test.setTimeout(150_000)
      const en = locale === 'en'
      const name = (english: string, chinese: string) => (en ? english : chinese)
      snapshots?.recordAssets(page)
      await page.setViewportSize({ width: 1440, height: 900 })
      await preferences(page, locale)
      await page.goto(runtime.url)
      const guide = page.getByTestId('first-run-guide')
      const quality = async (frame: string) => {
        await translated(page)
        await accessible(page, info, frame)
        // Static presentation frames have no timers to dismiss a captured success toast.
        await expect(page.locator('.agh-toast')).toHaveCount(0)
        if (!behaviorOnly) await screen(page, info, `${frame}-${locale}-light-1440`)
        await snapshots?.capture(page, frame)
      }
      await expect(guide).toHaveAttribute('data-step', 'account')
      await expect(page.getByTestId('composer-agent')).toHaveAttribute('aria-label', name('More', '更多'))
      const modal = page.getByRole('dialog', {
        name: name('Welcome to Agnes Harness', '欢迎使用 Agnes Harness'),
        exact: true,
      })
      await expect(modal).toHaveAttribute('aria-modal', 'true')
      await expect.poll(() => modal.evaluate((node) => node.contains(document.activeElement))).toBe(true)
      await page.keyboard.press('F6')
      await expect.poll(() => modal.evaluate((node) => node.contains(document.activeElement))).toBe(true)
      await quality('setup-account')
      await page.getByTestId('first-run-add').click()
      const connection = page.getByTestId('first-run-connection')
      await expect(connection.locator('#config-provider-trigger')).toBeEnabled()
      await expect(page.locator('#account-dialog[open]')).toHaveCount(0)
      await quality('setup-add-account')
      const client = await runtime.connect()
      const catalog = (await client.config.test({ providerId: 'deepseek' })).models
      const model = catalog[0]?.id
      if (!model) throw new Error('The provider catalog must declare a fixture model')
      const provider = await startProviderFixture('FIRST_TASK_COMPLETED', undefined, model)
      try {
        await connection.locator('#config-provider-trigger').click()
        await page.getByRole('option', { name: 'DeepSeek', exact: true }).click()
        await expand(connection.locator('#config-account-advanced'))
        await connection.locator('#config-base-url').fill(provider.baseUrl)
        await connection.locator('#config-api-key').fill(provider.apiKey)
        await page.getByTestId('first-run-next').click()
        await expect(guide).toHaveAttribute('data-step', 'workspace')
        // The completed progress step replaces the retired inline saved badge.
        await expect(guide.locator('.agnes-setup-progress li').first()).toHaveAttribute(
          'data-complete',
          'true',
        )
        expect((await client.config.get()).accounts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ providerId: 'deepseek', credentialConfigured: true }),
          ]),
        )
        await expect(page.locator('#config-api-key')).toHaveValue('')
        await guide.locator('.agh-disclosure > .agh-disclosure-summary').click()
        await guide
          .getByRole('textbox', { name: name('Folder path', '文件夹路径'), exact: true })
          .fill(runtime.workspace)
        await guide.getByRole('button', { name: name('Use folder', '使用此文件夹'), exact: true }).click()
        await expect(page.getByTestId('first-run-workspace')).toHaveText('w')
        const manualPath = guide.getByRole('textbox', {
          name: name('Folder path', '文件夹路径'),
          exact: true,
        })
        await expect(manualPath).toHaveValue(runtime.workspace)
        await quality('setup-workspace')
        await expect(manualPath).toHaveValue(runtime.workspace)
        await page.getByTestId('first-run-next').click()
        await expect(guide).toHaveAttribute('data-step', 'ready')
        await page.getByTestId('first-run-examples').click()
        await expect(page.getByTestId('home-page-agents')).toBeVisible()
        await closeSettings(page, locale)
        await expect(guide).toHaveAttribute('data-step', 'ready')
        await quality('setup-ready')
        await page.getByTestId('first-run-next').click()
        await expect(guide).toBeHidden()
        await expect(
          page.getByRole('dialog', {
            name: locale === 'en' ? 'Choose a workspace' : '选择工作区',
            exact: true,
          }),
        ).toBeHidden()
        const diagnostics = await client.request('_agnes/v1/doctor.run', {})
        expect(diagnostics.checks.find((check) => check.id === 'accounts')?.probed).toBe(false)
        if (diagnostics.checks.find((check) => check.id === 'sandbox')?.status !== 'ok')
          await fullAccess(page, locale)
        await send(page, 'Complete my first task')
        await expect(page.getByTestId('conversation-turn')).toContainText('FIRST_TASK_COMPLETED')
        await expect(page.getByTestId('conversation-turn')).toHaveAttribute('data-status', 'completed')
        const saved = await client.config.get()
        expect(saved.accounts?.find((a) => a.accountId === saved.defaultAccountId)?.model).toBe(model)
        expect(JSON.stringify(saved)).not.toContain(provider.apiKey)
        // Account creation is a settings subpage that borrows the controller's existing form.
        await settings(page, locale)
        await page.getByTestId('settings-nav-model').click()
        await page.locator('#config-add-account').click()
        const account = page.locator('.account-dialog-body[data-page="add"]')
        await expect(account).toHaveAttribute('data-account-step', 'provider')
        await account.locator('#config-provider-choices').locator('[data-provider="deepseek"]').click()
        await expect(account.locator('#config-account-advanced')).toHaveAttribute('data-open', 'false')
        await account.locator('#config-account-advanced > :is(summary, .agh-disclosure-summary)').click()
        await account.locator('#config-account-name').fill('Second account')
        await account.locator('#config-base-url').fill(provider.baseUrl)
        await account.locator('#config-api-key').fill(provider.apiKey)
        await account.locator('#config-save').click()
        await expect(account).toBeHidden()
        await expect(page.locator('.config-account')).toHaveCount(2)
        await page
          .getByRole('button', {
            name: name('Actions for Second account', 'Second account 的操作'),
            exact: true,
          })
          .click()
        await page
          .getByRole('menuitem', {
            name: name('Set as default Second account', '设为默认 Second account'),
            exact: true,
          })
          .click()
        await expect
          .poll(async () => (await client.config.get()).defaultAccountId)
          .not.toBe(saved.defaultAccountId)
        await closeSettings(page, locale)
        await page.locator('#model').click()
        await page
          .locator('#model-picker-popover [role="group"]')
          .filter({ hasText: 'Second account' })
          .getByRole('option')
          .first()
          .click()
        await expect(page.locator('#model')).toHaveAttribute('aria-busy', 'false')
        await expect(page.locator('#model-picker-popover')).toBeHidden()
        await page.locator('#model').click()
        await expect(
          page
            .locator('#model-picker-popover [role="group"]')
            .filter({ hasText: 'Second account' })
            .locator('[role="option"][aria-selected="true"]'),
        ).toHaveCount(1)
        await page.keyboard.press('Escape')
        await expect(page.locator('#new')).toHaveClass(/agh-btn--secondary/)
        await expect(page.locator('#settings')).toHaveClass(/agh-btn--ghost/)
        // Closing Settings retains its deep link. Restore the conversation URL before testing startup.
        const conversationUrl = new URL(page.url())
        conversationUrl.searchParams.delete('settings')
        conversationUrl.hash = ''
        await page.goto(conversationUrl.href)
        const marker = join(runtime.home, 'home-layout.json'),
          original = await readFile(marker, 'utf8')
        await writeFile(marker, JSON.stringify({ version: 99 }))
        try {
          await page.reload()
          await expect(page.getByTestId('doctor-notice')).toBeVisible()
          await page
            .getByRole('button', { name: name('View diagnostics', '查看运行诊断'), exact: true })
            .click()
          await expect(page.getByTestId('doctor-check-home')).toContainText(
            name('Check failed', '检查未通过'),
          )
          await writeFile(marker, original)
          await page.getByTestId('diagnostics-doctor-run').click()
          await expect(page.getByTestId('doctor-check-home')).toContainText(name('Ready', '就绪'))
          await expect(page.locator('[data-testid^="doctor-check-"]')).toHaveCount(11)
          await closeSettings(page, locale)
          await page
            .getByRole('button', { name: name('Dismiss runtime notice', '关闭运行提示'), exact: true })
            .click()
          await expect(page.getByTestId('doctor-notice')).toBeHidden()
          await page.reload()
          await expect(page.getByTestId('doctor-notice')).toBeHidden()
        } finally {
          await writeFile(marker, original)
        }
        await expect(guide).toBeHidden()
        await expect(page.getByTestId('conversation-turn')).toContainText('FIRST_TASK_COMPLETED')
      } finally {
        await provider.close()
      }
    })
    if (!behaviorOnly)
      for (const appearance of ['light', 'dark'])
        for (const width of [1440, 1280]) {
          if (appearance === 'light' && width === 1440) continue
          test(`first run presentation ${locale}/${appearance}/${width}`, async ({ page }, info) => {
            if (!snapshots) throw new Error('Missing first-run frames')
            for (const frame of ['setup-account', 'setup-add-account', 'setup-workspace', 'setup-ready']) {
              await snapshots.show(page, frame, appearance, width)
              await translated(page)
              await accessible(page, info, frame)
              await screen(page, info, `${frame}-${locale}-${appearance}-${width}`)
            }
          })
        }
  })
}

test('first run Demo and skip remain scoped to the fresh home', async ({ page, runtime }) => {
  await preferences(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(runtime.url)
  const guide = page.getByTestId('first-run-guide')
  await expect(guide).toHaveAttribute('data-step', 'account')
  await page.getByTestId('first-run-demo').click()
  await page.getByTestId('first-run-next').click()
  await expect(guide).toHaveAttribute('data-step', 'workspace')
  await page.getByTestId('first-run-skip').click()
  await expect(guide).toBeHidden()
  const client = await runtime.connect()
  expect((await client.config.get()).accounts).toHaveLength(0)
  await page.reload()
  await expect(guide).toBeHidden()
})

test('first run Demo reaches a conversation without storing an account', async ({ page, runtime }) => {
  await preferences(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(runtime.url)
  const guide = page.getByTestId('first-run-guide')
  await page.getByTestId('first-run-demo').click()
  await page.getByTestId('first-run-next').click()
  await guide.locator('.agh-disclosure > .agh-disclosure-summary').click()
  await guide.getByRole('textbox', { name: 'Folder path', exact: true }).fill(runtime.workspace)
  await guide.getByRole('button', { name: 'Use folder', exact: true }).click()
  await expect(page.getByTestId('first-run-workspace')).toHaveText('w')
  await page.getByTestId('first-run-next').click()
  await page.getByTestId('first-run-next').click()
  await expect(guide).toBeHidden()
  const composer = page.getByRole('textbox', { name: 'Task content', exact: true })
  await page.evaluate(() => document.fonts.ready)
  const height = () => composer.evaluate((input) => input.getBoundingClientRect().height)
  const restingHeight = await height()
  const multilineDraft = Array.from({ length: 8 }, (_, row) => `Demo draft line ${row + 1}`).join('\n')
  await composer.fill(multilineDraft)
  await expect(composer).toHaveValue(multilineDraft)
  await expect
    .poll(height, { message: 'The composer grows to show a multiline draft' })
    .toBeGreaterThan(restingHeight)
  await composer.fill('')
  await expect
    .poll(height, { message: 'Clearing the draft restores the compact composer' })
    .toBeLessThanOrEqual(restingHeight + 1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  await send(page, 'Hello from Demo')
  await expect(page.getByTestId('conversation-turn')).toHaveAttribute('data-status', 'completed')
  const client = await runtime.connect()
  expect((await client.config.get()).accounts).toHaveLength(0)
  expect((await client.apis()).profile.models).toEqual(
    expect.arrayContaining([expect.objectContaining({ route: 'demo', id: 'demo-model' })]),
  )
})
