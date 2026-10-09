import { copyFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AGH_DIR } from '@agnes/protocol'
import { expect, test } from './fixtures.js'
import { accessible, screen, translated } from './quality.js'
import { chooseWorkspace, closeSettings, fresh, preferences, section, settings } from './ui.js'

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
      // This matrix owns the genuinely empty Skills screen; the slash flow owns discovery.
      await rm(join(runtime.workspace, AGH_DIR, 'skills'), { recursive: true })
      await copyFile(resolve('tools/e2e-web/fixtures/mcp.mjs'), join(runtime.workspace, 'fixture.mjs'))
      await runtime.cli([
        'mcp',
        'add',
        'e2e',
        '--name',
        'Synthetic MCP',
        '--stdio',
        'node',
        '--arg',
        './fixture.mjs',
        '--sandbox-profile',
        'off-with-warning',
        '--yes',
      ])
      await preferences(page, locale, theme)
      await page.goto(runtime.url)
      await expect(page.getByTestId('first-run-skip')).toBeVisible()
      await page.getByTestId('first-run-skip').click()
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
      let fieldSurface = ''
      for (const id of pages) {
        await section(page, id)
        const native: Record<string, [string, string]> = {
          model: ['Model accounts', '模型账户'],
          skills: ['Skills', '技能'],
          mcp: ['MCP', 'MCP'],
          archived: ['Archived sessions', '已归档会话'],
          'computer-use': ['Computer Use', 'Computer Use'],
          general: ['General', '通用设置'],
        }
        const heading = native[id]
        if (heading)
          await expect(
            page.getByRole('heading', { name: heading[locale === 'en' ? 0 : 1], exact: true }),
          ).toBeVisible()
        else await expect(page.getByTestId(`settings-page-${id}`)).toBeVisible()
        if (id === 'plugins') {
          await expect(page.getByTestId('plugin-candidates')).toHaveCount(0)
          fieldSurface = await page
            .getByRole('searchbox', { name: locale === 'en' ? 'Search plugins' : '搜索插件', exact: true })
            .evaluate((input) => getComputedStyle(input).backgroundColor)
        }
        if (id === 'search') {
          await expect(page.getByTestId('search-api-key')).toBeEnabled()
          for (const control of [
            'search-api-key',
            'search-endpoint',
            'search-max-results',
            'search-test-query',
          ]) {
            await expect(page.locator(`#${control}`)).toHaveCSS('background-color', fieldSurface)
          }
          await quality('settings-search', true)
        }
        if (id === 'mcp') {
          await page
            .locator('#resource-list article')
            .filter({ hasText: 'Synthetic MCP' })
            .getByRole('button')
            .first()
            .click()
          await page
            .locator('#resource-detail')
            .getByRole('button', { name: locale === 'en' ? 'Edit' : '编辑', exact: true })
            .click()
          await expect(page.locator('#mcp-dialog')).toBeVisible()
          await page.mouse.move(0, 0)
          for (const control of ['mcp-name', 'mcp-executable', 'mcp-args', 'mcp-secret', 'mcp-tools']) {
            await expect(page.locator(`#${control}`)).toHaveCSS('background-color', fieldSurface)
          }
          await expect(page.locator('#mcp-sandbox-trigger')).toHaveCSS('background-color', fieldSurface)
          await quality('mcp-form', true)
          await page.locator('#mcp-cancel').click()
          await page.keyboard.press('Escape')
          await expect(page.locator('#resource-detail')).toBeHidden()
        }
        if (id === 'providers') {
          const disclosures = page.getByTestId('provider-technical-details')
          expect(await disclosures.count()).toBeGreaterThan(0)
          const excess = await disclosures.evaluateAll((details) =>
            details.map((detail) => {
              const row = detail.closest('article')
              if (!row) throw new Error('Provider disclosure has no shared row')
              return (
                row.getBoundingClientRect().bottom -
                detail.getBoundingClientRect().bottom -
                Number.parseFloat(getComputedStyle(row).paddingBottom)
              )
            }),
          )
          expect(
            Math.max(...excess),
            'Provider rows have no gap beyond their shared padding',
          ).toBeLessThanOrEqual(1)
          await screen(page, info, `plugin-kinds-${locale}-${theme}`)
        }
        if (id === 'discover') {
          await quality('discover-duplicate-versions')
          const packageRow = page.locator('article[data-plugin-id="@agnes-examples/client-multi-panel"]')
          await expect(packageRow).toHaveCount(1)
          await expect(packageRow.getByRole('heading')).toHaveCount(1)
          const versions = packageRow.getByTestId('plugin-other-versions')
          await expect(versions).not.toHaveAttribute('open', '')
          await screen(page, info, `discover-duplicate-versions-${locale}-${theme}`)
          await versions.getByTestId('plugin-other-versions-toggle').click()
          await expect(packageRow.locator('.plugin-source')).toHaveCount(0)
          await screen(page, info, `discover-version-picker-${locale}-${theme}`)
          const picker = packageRow.getByTestId('plugin-version-picker')
          await expect(picker).toHaveClass(/agnes-ui-select/)
          await picker.getByRole('combobox').click()
          await expect(page.getByRole('option')).toHaveCount(2)
          await page.getByRole('option', { name: '2.0.0', exact: true }).click()
          await expect(packageRow).toHaveAttribute('data-plugin-version', '2.0.0')
          await versions.locator('summary').click()
          await page
            .getByRole('searchbox', { name: locale === 'en' ? 'Search plugins' : '搜索插件', exact: true })
            .fill('@agnes-example/dag-loop')
          await expect(page.getByRole('heading', { name: /DAG/ })).toHaveCount(1)
        }
        await quality(`settings-${id}`, id === 'general' || ['plugins', 'discover', 'skills'].includes(id))
      }
      await closeSettings(page, locale)
      // This visual read flow uses the same explicit preset as the offline runtime flows.
      await fresh(page, locale)
      const composer = page.getByRole('textbox', {
        name: locale === 'en' ? 'Task content' : '任务内容',
        exact: true,
      })
      await composer.fill('call read {"path":"report.md"}')
      await composer.press('Enter')
      const current = page.getByTestId('conversation-turn')
      await expect(current).toHaveAttribute('data-status', 'completed')
      await current.getByTestId('turn-process-toggle').click()
      await current.getByTestId('tool-detail-toggle').click()
      await expect(current.getByTestId('tool-detail-text')).toContainText('Synthetic delivery')
      await quality('tool-row', true)
    })
  }

test('live language switching updates sidebar and cached skin options without reloading', async ({
  page,
  runtime,
}) => {
  await preferences(page, 'en', 'light')
  await page.goto(runtime.url)
  await chooseWorkspace(page, runtime)
  await settings(page)
  await section(page, 'general')
  for (const locale of ['zh-CN', 'en', 'zh-CN']) {
    const en = locale === 'en'
    await page.locator(`input[name="agnes-locale"][value="${locale}"]`).check()
    await expect(page.locator('html')).toHaveAttribute('lang', locale)
    await expect(page.locator('#settings')).toHaveText(en ? 'Settings' : '设置')
    await expect(page.locator('#new')).toHaveText(en ? 'New session' : '新会话')
    await expect(page.locator('#skin-option-items')).toContainText(
      en ? 'Follow the theme (default)' : '跟随主题（默认）',
    )
    await expect(page.locator('input[name="agnes-skin"][value=""]')).toBeChecked()
    await closeSettings(page, locale)
    await settings(page, locale)
    await section(page, 'general')
  }
})
