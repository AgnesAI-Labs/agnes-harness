import { expect, test } from './fixtures.js'
import { accessible, screen, translated } from './quality.js'
import { chooseWorkspace, preferences, section, settings } from './ui.js'

const pages = [
  'model',
  'models',
  'bundles',
  'engines',
  'plugins',
  'discover',
  'providers',
  'examples',
  'skills',
  'mcp',
  'search',
  'context',
  'jobs',
  'schedules',
  'terminal',
  'security',
  'history',
  'archived',
  'computer-use',
  'general',
]

for (const locale of ['en', 'zh-CN'])
  for (const theme of ['light', 'dark']) {
    test(`main screens and every settings section ${locale}/${theme}`, async ({ page, runtime }, info) => {
      test.setTimeout(150_000)
      await preferences(page, locale, theme)
      await page.goto(runtime.url)
      await expect(
        page.getByRole('dialog', {
          name: locale === 'en' ? 'Choose a workspace' : '选择工作区',
          exact: true,
        }),
      ).toBeVisible()
      const quality = async (name: string, visual = false) => {
        await translated(page)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name).toBe(
          true,
        )
        await accessible(page, info, name)
        if (visual) await screen(page, info, `${name}-${locale}-${theme}`)
      }
      await quality('first-run', true)
      await chooseWorkspace(page, runtime, locale)
      await quality('new-session', true)
      await page.getByTestId('composer-agent').click()
      await expect(page.getByTestId('agent-options')).toBeVisible()
      await quality('agent-options', true)
      await page.keyboard.press('Escape')
      await settings(page, locale)
      const add = page.getByRole('button', {
        name: locale === 'en' ? 'Add account' : '添加账户',
        exact: true,
      })
      await expect(add).toBeEnabled()
      await quality('accounts', true)
      await add.click()
      const account = page.getByRole('dialog', {
        name: locale === 'en' ? 'Add account' : '添加账户',
        exact: true,
      })
      await expect(account).toBeVisible()
      await quality('add-account', true)
      await account
        .getByRole('button', {
          name: locale === 'en' ? 'Close account details' : '关闭账户详情',
          exact: true,
        })
        .click()
      for (const id of pages) {
        await section(page, id)
        if (!['model', 'skills', 'mcp', 'archived', 'computer-use', 'general'].includes(id))
          await expect(page.getByTestId(`settings-page-${id}`)).toBeVisible()
        await quality(`settings-${id}`, id === 'general' || ['plugins', 'discover', 'skills'].includes(id))
      }
    })
  }
