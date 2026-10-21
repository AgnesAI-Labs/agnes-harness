import { copyFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AGH_DIR } from '@agnes/protocol'
import { expect, test } from './fixtures.js'
import { accessible, screen, translated } from './quality.js'
import {
  advanced,
  chooseWorkspace,
  closeSettings,
  expand,
  fresh,
  preferences,
  section,
  sectionSurface,
  selectValue,
  settings,
  turn,
} from './ui.js'

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
  'memory',
  'system-prompt',
  'diagnostics',
  'context',
  'jobs',
  'schedules',
  'security',
  'application',
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
      // CLI setup may already have selected the workspace. Open the same picker explicitly.
      const workspace = page.getByRole('dialog', {
        name: locale === 'en' ? 'Choose a workspace' : '选择工作区',
        exact: true,
      })
      if (!(await workspace.isVisible())) {
        await page.locator('#composer-workspace').click()
        await page
          .getByRole('region', { name: locale === 'en' ? 'Select workspace' : '选择工作区', exact: true })
          .getByRole('button', { name: locale === 'en' ? 'New workspace…' : '新建工作区…', exact: true })
          .click()
      }

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
      // The hero now offers one composer hint; browse the same agents from the sidebar gallery.
      await page.getByTestId('home-entry-agents').click()
      await expect(page.getByTestId('home-page-agents')).toBeVisible()
      await expect(page.getByTestId('general-agent')).toBeVisible()
      await expect(page.locator('[data-agent-ref^="@agnes-fde/"]')).toHaveCount(0)
      await closeSettings(page, locale)
      await expect(page.locator('#empty-state')).toBeVisible()
      await advanced(page)
      await closeSettings(page, locale)
      await quality('new-session', true)
      await expect(page.getByTestId('composer-agent')).toBeEnabled()
      await expect(page.getByTestId('composer-agent')).toHaveAttribute(
        'aria-label',
        locale === 'en' ? 'More' : '更多',
      )
      await page.locator('#composer-permission').click()
      await expect(page.locator('#permission-picker-popover')).toBeVisible()
      await quality('agent-options', true)
      await page.keyboard.press('Escape')
      await settings(page, locale)
      await section(page, 'model')
      const add = page.locator('.config-accounts-welcome [data-provider="deepseek"]')
      await expect(add).toBeEnabled()
      await expand(page.getByTestId('advanced-models'))
      await expand(page.getByTestId('auxiliary-models'))
      await expect(page.getByTestId('model-slot-fast')).toHaveValue('')
      await expect(page.getByTestId('model-slot-verifier')).toHaveValue('')
      await quality('accounts', true)
      await add.click()
      const account = page.getByTestId('account-page-add')
      await expect(account).toBeVisible()
      await quality('add-account', true)
      await page.locator('#config-account-cancel').click()
      await page.locator('#config-account-discard-confirm').click()
      await expect(account).toBeHidden()
      await expect(add).toBeVisible()
      let fieldSurface = ''
      let popupSurface = ''
      let inputSurface = ''
      for (const id of pages) {
        if (id === 'jobs') {
          await closeSettings(page, locale)
          await turn(page, 'UI gate terminal context')
        }
        await section(page, id)
        await expect(sectionSurface(page, id)).toBeVisible()
        // Catalogue reads refresh on page entry/focus; the redesign removed the universal
        // refresh button. Keep the loaded, error-free guarantee for every actual page.
        await expect(page.getByTestId('settings-refresh')).not.toBeVisible()
        await expect(sectionSurface(page, id)).not.toHaveAttribute('aria-busy', 'true')
        await expect(page.getByTestId('settings-catalog-state')).toHaveCount(0)
        if (id === 'plugins') {
          await expect(page.getByTestId('plugin-candidates')).toHaveCount(0)
          fieldSurface = await page
            .getByRole('searchbox', { name: locale === 'en' ? 'Search plugins' : '搜索插件', exact: true })
            .evaluate((input) => getComputedStyle(input).backgroundColor)
          popupSurface = await page.getByTestId('home-page-plugins').evaluate((owner) => {
            const probe = document.createElement('div')
            probe.style.background = 'var(--agnes-bg-control)'
            owner.appendChild(probe)
            const color = getComputedStyle(probe).backgroundColor
            probe.remove()
            return color
          })
          inputSurface = await page.getByTestId('home-page-plugins').evaluate((owner) => {
            const probe = document.createElement('div')
            probe.style.background = 'var(--agnes-input-surface)'
            owner.appendChild(probe)
            const color = getComputedStyle(probe).backgroundColor
            probe.remove()
            return color
          })
        }
        if (id === 'search') {
          await quality('settings-search', true)
          await page.getByTestId('search-add').click()
          await expand(page.getByTestId('search-advanced'))
          await expect(page.getByTestId('search-api-key')).toBeEnabled()
          for (const control of [
            'search-api-key',
            'search-endpoint',
            'search-max-results',
            'search-test-query',
          ]) {
            await expect(page.locator(`#${control}`)).toHaveCSS('background-color', fieldSurface)
          }
          await accessible(page, info, 'search-editor')
          await page.getByRole('button', { name: locale === 'en' ? 'Cancel' : '取消', exact: true }).click()
        }
        if (id === 'memory') {
          await advanced(page)
          await section(page, 'memory')
          await expect(page.getByTestId('memory-panel')).toHaveAttribute('aria-busy', 'false')
          const workspaceField = page.locator('#memory-workspace-trigger')
          await expect(workspaceField).toBeVisible()
          await expect(workspaceField).toHaveCSS('background-color', inputSurface)
          await page.getByTestId('memory-open').click()
          await expect(page.getByTestId('memory-content')).toBeVisible()
          const mode = page.getByTestId('memory-mode')
          await expect(mode).toHaveRole('radiogroup')
          const trackSurface = await mode.evaluate((node) => {
            const probe = document.createElement('div')
            probe.style.background = 'var(--agnes-segment-track)'
            node.appendChild(probe)
            const color = getComputedStyle(probe).backgroundColor
            probe.remove()
            return color
          })
          await expect(mode).toHaveCSS('background-color', trackSurface)
          await expect(mode.locator('.agh-segmented-thumb')).toHaveCSS('background-color', popupSurface)
          await expect(page.getByTestId('memory-actions')).toContainText('MEMORY.md')
          const editor = page.getByTestId('memory-content')
          const codeSurface = await editor.evaluate((node) => {
            const probe = document.createElement('div')
            probe.style.backgroundColor = getComputedStyle(node).getPropertyValue('--agnes-bg-fill')
            node.parentElement!.appendChild(probe)
            const color = getComputedStyle(probe).backgroundColor
            probe.remove()
            return color
          })
          await page.mouse.move(0, 0)
          await expect(editor).toHaveCSS('background-color', codeSurface)
          await editor.focus()
          await expect(editor).toHaveCSS('background-color', inputSurface)
        }
        if (id === 'mcp') {
          await page
            .locator('.plugins-page-resources .plugin-list article')
            .filter({ hasText: 'Synthetic MCP' })
            .getByRole('button')
            .first()
            .click()
          await page
            .locator('#resource-detail')
            .getByRole('button', { name: locale === 'en' ? 'Edit' : '编辑', exact: true })
            .click()
          await expect(page.locator('#mcp-dialog')).toBeVisible()
          await expect(page.locator('#mcp-dialog .dialog-intro')).not.toContainText('<code>')
          await expect(page.locator('#mcp-dialog .dialog-intro')).toContainText(
            locale === 'en' ? 'Connect external tools' : '连接外部工具',
          )
          await expect(page.locator('#mcp-secret')).toBeHidden()
          await page.locator('#mcp-advanced > :is(summary, .agh-disclosure-summary)').click()
          await page.locator('#mcp-secret-kind-trigger').click()
          await page.locator('#mcp-secret-kind-listbox-1').click()
          await expect(page.locator('#mcp-secret-kind')).toHaveValue('stdio-env')
          await expect(page.locator('#mcp-secret')).toBeVisible()
          await expect(page.locator('#mcp-secret')).toHaveAttribute('placeholder', /secret:\/\//)
          await page.mouse.move(0, 0)
          for (const control of ['mcp-name', 'mcp-executable', 'mcp-args', 'mcp-secret', 'mcp-tools']) {
            await expect(page.locator(`#${control}`)).toHaveCSS('background-color', fieldSurface)
          }
          await expect(page.locator('#mcp-sandbox-trigger')).toHaveCSS('background-color', inputSurface)
          await accessible(page, info, 'mcp-advanced')
          await page.locator('#mcp-secret-kind-trigger').click()
          await page.locator('#mcp-secret-kind-listbox-0').click()
          await expect(page.locator('#mcp-secret-kind')).toHaveValue('none')
          await page.locator('#mcp-advanced > :is(summary, .agh-disclosure-summary)').click()
          await quality('mcp-form', true)
          await page.locator('#mcp-cancel').click()
          await page.keyboard.press('Escape')
          await page.getByTestId('mcp-create').click()
          await expect(page.locator('#mcp-methods')).toBeVisible()
          await quality('mcp-choose-method')
          await info.attach('mcp-choose-method.png', {
            body: await page.locator('#mcp-dialog').screenshot(),
            contentType: 'image/png',
          })
          await page.locator('#mcp-method-local').click()
          await expect(page.locator('#mcp-command')).toBeVisible()
          await expect(page.locator('#mcp-command')).toBeFocused()
          await quality('mcp-local-connection')
          await page.locator('#mcp-cancel').click()
          await expect(page.getByTestId('mcp-create')).toBeFocused()
          await expect(page.getByRole('dialog', { name: 'Synthetic MCP', exact: true })).toBeHidden()
        }
        if (id === 'providers') {
          const disclosures = page.getByTestId('provider-technical-details')
          await expect(disclosures.first()).toBeVisible()
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
          await page.getByTestId('settings-subsection-provider-types').evaluate((section) => {
            section.scrollIntoView({ block: 'start', behavior: 'instant' })
          })
          await screen(page, info, `plugin-kinds-${locale}-${theme}`)
        }
        if (id === 'discover') {
          await quality('discover-duplicate-versions')
          const packageRow = page
            .getByTestId('market-card')
            .and(page.locator('[data-plugin-id="@agnes-examples/client-multi-panel"]'))
          await expect(packageRow).toHaveCount(1)
          await expect(packageRow.getByRole('heading')).toHaveCount(1)
          const versions = packageRow.getByTestId('plugin-other-versions')
          await expect(versions).toHaveAttribute('data-open', 'false')
          await packageRow.scrollIntoViewIfNeeded()
          await expect(packageRow).toBeVisible()
          await screen(page, info, `discover-duplicate-versions-${locale}-${theme}`)
          await versions.locator('.agh-disclosure-summary').click()
          await expect(packageRow.locator('.plugin-source')).toHaveCount(0)
          await packageRow.scrollIntoViewIfNeeded()
          await expect(packageRow).toBeInViewport({ ratio: 1 })
          await screen(page, info, `discover-version-picker-${locale}-${theme}`)
          const picker = packageRow.getByTestId('plugin-version-picker')
          await expect(picker).toHaveClass(/agnes-ui-select/)
          const combo = picker.getByRole('combobox')
          await combo.click()
          const listId = await combo.getAttribute('aria-controls')
          if (!listId) throw new Error('Version picker must identify its option list')
          await expect(page.locator(`[id="${listId}"]`).getByRole('option')).toHaveCount(2)
          await page.getByRole('option', { name: '2.0.0', exact: true }).click()
          await expect(packageRow).toHaveAttribute('data-plugin-version', '2.0.0')
          await versions.locator('summary, .agh-disclosure-summary').click()
          await page
            .getByRole('searchbox', { name: locale === 'en' ? 'Search plugins' : '搜索插件', exact: true })
            .fill('@agnes-example/dag-loop')
          const results = page.getByTestId('market-card')
          await expect(results).toHaveCount(1)
          await expect(results).toHaveAttribute('data-plugin-id', '@agnes-example/dag-loop')
          await expect(results.getByRole('heading')).toHaveText(
            locale === 'en' ? 'Task graph Loop' : '任务图 Loop',
          )
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
    await selectValue(page, 'locale-select', locale)
    await expect(page.locator('html')).toHaveAttribute('lang', locale)
    await expect(page.locator('#settings')).toHaveText(en ? 'Settings' : '设置')
    await expect(page.locator('#new')).toHaveAccessibleName(en ? 'New conversation' : '新对话')
    await expect(page.locator('#new')).toContainText(en ? 'New conversation' : '新对话')
    await expect(page.locator('#skin-select option').first()).toHaveText(en ? 'AGH default' : 'AGH 默认')
    await expect(page.locator('#skin-select')).toHaveValue('')
    await closeSettings(page, locale)
    await settings(page, locale)
    await section(page, 'general')
  }
})
