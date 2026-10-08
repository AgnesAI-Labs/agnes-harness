import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startProviderFixture } from '../acceptance/provider-fixture.js'
import { expect, test } from './fixtures.js'
import { accessible, screen, translated } from './quality.js'
import { chooseWorkspace, closeSettings, preferences } from './ui.js'

for (const locale of ['en', 'zh-CN'])
  for (const theme of ['light', 'dark'])
    for (const width of [1440, 1280]) {
      test(`guided first run ${locale}/${theme}/${width}`, async ({ page, runtime }, info) => {
        test.setTimeout(150_000)
        const en = locale === 'en'
        await page.setViewportSize({ width, height: width === 1440 ? 900 : 800 })
        await preferences(page, locale, theme)
        await page.goto(runtime.url)
        const guide = page.getByTestId('first-run-guide')
        const quality = async (name: string) => {
          await translated(page)
          await accessible(page, info, name)
          await screen(page, info, `${name}-${locale}-${theme}-${width}`)
        }
        await expect(guide).toHaveAttribute('data-step', 'welcome')
        await expect(page.getByTestId('composer-agent')).toBeEnabled()
        await quality('setup-welcome')
        await page.getByTestId('first-run-next').click()
        await expect(guide).toHaveAttribute('data-step', 'account')
        await quality('setup-account')
        await page.getByTestId('first-run-add').click()
        const account = page.getByRole('dialog', { name: en ? 'Add account' : '添加账户', exact: true })
        await expect(account).toBeVisible()
        await quality('setup-add-account')
        const client = await runtime.connect()
        const catalog = (await client.config.test({ providerId: 'deepseek' })).models
        const firstModel = catalog[0]
        const model = firstModel?.id
        if (!firstModel || !model) throw new Error('The installed model catalog must provide a fixture model')
        const provider = await startProviderFixture('FIRST_TASK_COMPLETED', undefined, model)
        try {
          await account
            .getByRole('textbox', { name: en ? 'Account name' : '账户名称', exact: true })
            .fill(en ? 'Local test account' : '本地测试账户')
          await account.getByRole('combobox', { name: en ? /^Provider:/ : /^Provider：/ }).click()
          await page.getByRole('option', { name: 'DeepSeek', exact: true }).click()
          await account
            .getByRole('textbox', { name: en ? 'Base URL' : '服务地址', exact: true })
            .fill(provider.baseUrl)
          await account.getByLabel('API Key', { exact: true }).fill(provider.apiKey)
          await account
            .getByRole('button', { name: en ? 'Test connection' : '测试连接', exact: true })
            .click()
          await expect(
            account.getByRole('button', { name: en ? 'Save account' : '保存账户', exact: true }),
          ).toBeEnabled()
          await account.getByRole('button', { name: en ? 'Save account' : '保存账户', exact: true }).click()
          await expect(account).toBeHidden()
          await expect(guide).toHaveAttribute('data-step', 'model')
          await expect(page.getByTestId('first-run-model')).toContainText(firstModel.name)
          await page.getByTestId('first-run-model').getByRole('combobox').click()
          await page.getByTestId('first-run-model').getByRole('combobox').press('Enter')
          await quality('setup-model')
          await page.getByTestId('first-run-next').click()
          await expect(guide).toHaveAttribute('data-step', 'examples')
          await quality('setup-examples')
          await page.getByTestId('first-run-examples').click()
          await expect(page.getByTestId('settings-page-examples')).toBeVisible()
          await expect(page.locator('[data-testid^="example-install-"]').first()).toBeVisible()
          await closeSettings(page, locale)
          await expect(guide).toHaveAttribute('data-step', 'examples')
          await page.getByTestId('first-run-next').click()
          await expect(guide).toHaveAttribute('data-step', 'ready')
          await quality('setup-ready')
          await page.getByTestId('first-run-next').click()
          await expect(guide).toBeHidden()
          await chooseWorkspace(page, runtime, locale)
          const diagnostics = await client.request('_agnes/v1/doctor.run', {})
          expect(diagnostics.checks.find((check) => check.id === 'accounts')?.probed).toBe(false)
          if (diagnostics.checks.find((check) => check.id === 'sandbox')?.status !== 'ok') {
            // A restricted host cannot admit L1. Select the existing explicit permission preset.
            await page.getByTestId('composer-agent').click()
            await page.getByTestId('new-session-preset').click()
            await page.getByRole('option', { name: en ? /^Full access\b/ : /^完全权限/ }).click()
            await page.getByTestId('composer-agent').click()
          }
          const composer = page.getByRole('textbox', { name: en ? 'Task content' : '任务内容', exact: true })
          await composer.fill('Complete my first task')
          await composer.press('Enter')
          await expect(page.getByTestId('conversation-turn')).toContainText('FIRST_TASK_COMPLETED')
          await expect(page.getByTestId('conversation-turn')).toHaveAttribute('data-status', 'completed')
          const saved = await client.config.get()
          expect(saved.accounts?.find((a) => a.accountId === saved.defaultAccountId)?.model).toBe(model)
          expect(JSON.stringify(saved)).not.toContain(provider.apiKey)
          expect(runtime.logs()).toMatch(/Doctor:|运行诊断：|运行诊断:/)
          // Deliberately damage only our synthetic marker while the daemon remains live.
          const marker = join(runtime.home, 'home-layout.json'),
            original = await readFile(marker, 'utf8')
          await writeFile(marker, JSON.stringify({ version: 99 }))
          try {
            await page.goto(runtime.url)
            await expect(page.getByTestId('doctor-notice')).toBeVisible()
            // The notice precedes session restoration; capture the usable workspace, not that interim frame.
            await expect(composer).toBeEnabled()
            await expect(page.getByTestId('workbench-right-toggle')).toBeVisible()
            await quality('doctor-notice')
            await page
              .getByRole('button', { name: en ? 'View diagnostics' : '查看运行诊断', exact: true })
              .click()
            await expect(page.getByTestId('doctor-panel')).toBeVisible()
            await expect(page.getByTestId('doctor-check-home')).toContainText(
              en ? 'Check failed' : '检查未通过',
            )
            await writeFile(marker, original)
            await page.getByTestId('doctor-refresh').click()
            await expect(page.getByTestId('doctor-check-home')).toContainText(en ? 'Ready' : '就绪')
            await expect(page.locator('[data-testid^="doctor-check-"]')).toHaveCount(11)
            await page.getByTestId('doctor-check-mcp').scrollIntoViewIfNeeded()
            await page
              .getByTestId('settings-page-doctor')
              .getByRole('heading', { name: en ? 'Runtime diagnostics' : '运行诊断', exact: true })
              .scrollIntoViewIfNeeded()
            await quality('runtime-doctor')
            await closeSettings(page, locale)
            await page
              .getByRole('button', { name: en ? 'Dismiss runtime notice' : '关闭运行提示', exact: true })
              .click()
            await expect(page.getByTestId('doctor-notice')).toBeHidden()
          } finally {
            await writeFile(marker, original)
          }
          await page.reload()
          await expect(page.getByTestId('first-run-guide')).toBeHidden()
          await expect(page.getByTestId('conversation-turn')).toContainText('FIRST_TASK_COMPLETED')
        } finally {
          await provider.close()
        }
      })
    }
