import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test as base, expect } from '@playwright/test'
import { scanAccessibility } from './axe.js'
import { localeKeys, unresolvedLabels } from './i18n.js'
import { settled } from './quality.js'
import { isolatedRuntime, type Runtime } from './runtime.js'
import {
  advanced,
  chooseWorkspace,
  closeSettings,
  expandActivityGroups,
  section,
  sectionSurface,
} from './ui.js'

const root = process.env.AGH_UI_REPORT
const test = base.extend<{ uiServer: Runtime | undefined }>({
  uiServer: async ({ browserName }, use, info) => {
    if (browserName !== 'chromium') throw new Error('UI acceptance requires Chromium')
    if (process.env.AGH_UI_ISOLATED !== '1') {
      await use(undefined)
      return
    }
    const server = await isolatedRuntime()
    try {
      await server.start()
      await use(server)
    } finally {
      await info.attach('serve.log', { body: server.logs(), contentType: 'text/plain' })
      await server.dispose()
    }
  },
})
// This test always renders the main screens in both locales. Optional artifacts cover the
// full visual matrix; use a real daemon with an isolated home and the built-in demo model.
for (const locale of ['zh-CN', 'en'])
  for (const theme of ['light', 'dark'])
    for (const [width, height] of [
      [1440, 900],
      [1280, 800],
    ] as const) {
      test(`UI quality ${locale}/${theme}/${width}x${height}`, async ({ page, uiServer }) => {
        test.setTimeout(process.env.AGH_UI_AXE === '1' ? 240_000 : 120_000)
        const workspace = uiServer?.workspace ?? process.env.AGH_UI_WORKSPACE
        const deliverable = uiServer ? join(uiServer.workspace, 'report.md') : process.env.AGH_UI_DELIVERABLE
        const visit = (path: string) =>
          page.goto(new URL(path, uiServer?.url ?? process.env.AGH_WEB_URL).toString())
        const knownKeys = await localeKeys()
        const errors: string[] = []
        page.on('pageerror', (error: Error) => errors.push(error.message))
        await page.setViewportSize({ width, height })
        await page.addInitScript(
          ({ locale, theme }: { locale: string; theme: string }) => {
            localStorage.setItem('agnes-locale', locale)
            localStorage.setItem('agnes-theme', theme)
          },
          { locale, theme },
        )
        const folder = root && join(root, `${locale}-${theme}-${width}x${height}`)
        if (folder) await mkdir(folder, { recursive: true })
        async function screen(name: string) {
          await settled(page)
          const unresolved = await page.evaluate(unresolvedLabels, knownKeys)
          expect(unresolved, `${name}: unresolved locale keys`).toEqual([])
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
            `${name}: viewport overflow`,
          ).toBe(true)
          expect(errors, `${name}: uncaught browser errors`).toEqual([])
          if (folder) await page.screenshot({ path: join(folder, `${name}.png`) })
          if (process.env.AGH_UI_AXE === '1' && width === 1440) {
            const scan = await scanAccessibility(page)
            expect(
              scan.violations.map(({ id, nodes }) => ({
                id,
                targets: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
              })),
              `${name}: accessibility`,
            ).toEqual([])
          }
        }
        await visit('/?new=1')
        if (uiServer) {
          await chooseWorkspace(page, uiServer, locale)
          await expect(page.locator('#settings')).toBeVisible()
        } else {
          await expect(page.locator('#settings')).toBeVisible()
          await page.waitForTimeout(1000)
          if (
            await page
              .getByRole('dialog', {
                name: locale === 'en' ? 'Choose a workspace' : '选择工作区',
                exact: true,
              })
              .isVisible()
          ) {
            if (!workspace) throw new Error('Set AGH_UI_WORKSPACE to an isolated workspace for a fresh home')
            await page.locator('#new-session-cwd').fill(workspace)
            await page.locator('#new-session-create').click()
          } else {
            await page.locator('#new').click()
            await page.waitForTimeout(350)
            if (
              await page
                .getByRole('dialog', {
                  name: locale === 'en' ? 'Choose a workspace' : '选择工作区',
                  exact: true,
                })
                .isVisible()
            ) {
              if (!workspace) throw new Error('Set AGH_UI_WORKSPACE for workspace selection')
              await page.locator('#new-session-cwd').fill(workspace)
              await page.locator('#new-session-create').click()
            }
          }
        }
        await screen('home-empty')
        await expect(page.getByTestId('goal-bar')).toBeHidden()
        await advanced(page)
        await closeSettings(page, locale)
        await expect(page.getByTestId('composer-agent')).toBeEnabled()
        await expect(page.getByTestId('composer-agent')).toHaveAttribute(
          'aria-label',
          locale === 'en' ? 'More' : '更多',
        )
        await page.locator('#composer-permission').click()
        await screen('agent-options')
        await page.keyboard.press('Escape')
        await page.locator('#settings').click()
        await section(page, 'model')
        await screen('settings-model')
        await page.locator('#config-add-account').click()
        await screen('add-account')
        await page.locator('#account-dialog-close').click()
        for (const [id, name] of [
          ['skills-tab', 'skills'],
          ['mcp-tab', 'mcp'],
          ['computer-use-management', 'computer-use'],
          ['appearance-settings', 'general'],
        ]) {
          await section(
            page,
            id === 'skills-tab'
              ? 'skills'
              : id === 'mcp-tab'
                ? 'mcp'
                : id === 'computer-use-management'
                  ? 'computer-use'
                  : 'general',
          )
          if (id === 'skills-tab' || id === 'mcp-tab') {
            const tab = page
              .getByRole('tab')
              .filter({ has: page.getByTestId(`plugins-tab-${id === 'skills-tab' ? 'skills' : 'mcp'}`) })
            await expect(tab).toHaveAttribute('aria-selected', 'true')
            await expect(tab).toHaveAttribute('tabindex', '0')
          }
          await screen(`settings-${name}`)
        }
        for (const id of [
          'plugins',
          'providers',
          'search',
          'engines',
          'models',
          'bundles',
          'security',
          'context',
          'examples',
          'history',
          'jobs',
          'schedules',
        ]) {
          if (id === 'jobs') {
            await closeSettings(page, locale)
            await submitTurn('UI quality terminal context')
          }
          await section(page, id)
          await expect(sectionSurface(page, id)).toBeVisible()
          if (id === 'plugins') await expect(page.locator('#install-source')).toBeEnabled({ timeout: 30_000 })
          await screen(`runtime-${id}`)
          if (id === 'bundles' && (await page.getByTestId('session-tool-groups').count())) {
            await page
              .getByTestId('session-tool-groups')
              .first()
              .locator('summary, .agh-disclosure-summary')
              .first()
              .click()
            await screen('session-tool-info')
          }
          if (id === 'examples') {
            const cards = page.locator('[data-testid^="business-agent-"][data-package]')
            await expect(cards.first()).toBeVisible()
            expect(await cards.count()).toBeGreaterThan(0)
            await section(page, 'discover')
            for (const id of ['dag-loop', 'react-loop'])
              await expect(
                page.locator(`[data-testid="market-card"][data-plugin-id="@agnes-example/${id}"]`),
              ).toBeVisible()
          }
        }
        await section(page, 'archived')
        await screen('settings-archives')
        await section(page, 'schedules')
        await page
          .getByRole('tab')
          .filter({ hasText: locale === 'en' ? 'Scheduled tasks' : '定时任务' })
          .focus()
        await page.keyboard.press('ArrowRight')
        await expect(
          page.getByRole('tab').filter({ hasText: locale === 'en' ? 'Triggers' : '触发器' }),
        ).toBeFocused()
        await page.keyboard.press('Enter')
        await expect(page.getByTestId('home-page-automation')).toBeVisible()
        await expect(page).toHaveURL(/tab=triggers/)
        await section(page, 'plugins')
        await page.locator('#install-source').click()
        await screen('plugin-install')
        await page.locator('#source-cancel').click()
        await closeSettings(page, locale)
        async function submitTurn(input: string) {
          await expect(page.locator('#cancel')).toBeHidden({ timeout: 30_000 })
          const turns = page.locator('.conversation-turn')
          const before = await turns.count()
          await page.locator('#prompt').fill(input)
          await page.locator('#send').click()
          await expect(turns).toHaveCount(before + 1, { timeout: 30_000 })
          await expect(turns.last()).toHaveAttribute('data-status', 'completed', { timeout: 30_000 })
          await expect(page.locator('#prompt')).toBeEnabled()
        }
        await submitTurn('UI quality demo')
        await submitTurn('call ls {"path":"."}')
        await screen('active-session')
        const calls = [
          'call job_list {}',
          ...(deliverable ? ['call present ' + JSON.stringify({ files: [{ path: deliverable }] })] : []),
          'call ask_user_question ' +
            JSON.stringify({
              questions: [
                {
                  id: 'channel',
                  question: locale === 'en' ? 'Which delivery channel?' : '选择交付渠道',
                  options: locale === 'en' ? ['Web', 'Email'] : ['网页', '邮件'],
                  allowFreeText: true,
                },
              ],
            }),
        ]
        for (const call of calls) {
          await submitTurn(call)
        }
        for (const process of await page.getByTestId('turn-process-toggle').all()) {
          if ((await process.isVisible()) && (await process.getAttribute('aria-expanded')) !== 'true')
            await process.click()
          await expandActivityGroups(
            process.locator('xpath=ancestor::*[@data-testid="conversation-turn"][1]'),
          )
        }
        await expect(
          page
            .getByTestId('intelligent-ui-inline')
            .locator('[data-testid^="ui-surface-"]')
            .filter({ hasText: 'Questions / 问题' }),
        ).toBeVisible()
        await page
          .getByTestId('intelligent-ui-inline')
          .locator('[data-testid^="ui-surface-"]')
          .filter({ hasText: 'Questions / 问题' })
          .scrollIntoViewIfNeeded()
        await screen('active-session-cards')
        if (deliverable) {
          const files = page.getByTestId('turn-deliverables').filter({ hasText: 'report.md' }).last()
          await expect(files).toBeVisible()
          await expect(files).toHaveAttribute('aria-label', locale === 'en' ? 'Deliverables' : '交付物')
          await files.scrollIntoViewIfNeeded()
          await screen('deliverable-surface')
        }
        await expect(page.getByTestId('background-job-card')).toBeVisible()
        await section(page, 'jobs')
        await expect(page.getByTestId('terminal-panel')).toBeVisible()
        await page.getByTestId('workbench-right-toggle').click()

        await page.locator('#view-trace').click()
        await screen('trace')
        await page.locator('#view-chat').click()
        await visit('/?settings=bundles')
        await expect(page.getByTestId('settings-page-models')).toBeVisible()
        await expect(page.getByTestId('settings-subsection-bundles')).toHaveAttribute('data-open', 'true')
        await expect(page.locator('#new-session')).toBeHidden()
        await screen('deep-link-bundles')
        await section(page, 'schedules')
        await page.getByTestId('schedules-new').click()
        await page.getByTestId('schedules-title').fill('Synthetic reminder')
        await page.getByTestId('schedules-prompt').fill('Synthetic UI verification')
        await page.getByTestId('schedules-create').click()
        const scheduleActions = page.getByTestId('schedules-actions').first()
        await scheduleActions.click()
        await page.getByTestId('schedules-archive').click()
        const confirm = page.getByTestId('schedules-archive-confirm')
        await confirm.click({ trial: true })
        await screen('schedule-confirm')
        await page.keyboard.press('Escape')
        await expect(confirm).toBeHidden()
        await expect(page.getByTestId('home-page-automation')).toBeVisible()
        await expect(scheduleActions).toBeFocused()
        await scheduleActions.click()
        await page.getByTestId('schedules-archive').click()
        await expect(confirm).toBeVisible()
        // Navigating away destroys the moved page's detail lifetime without reopening a modal.
        await visit('/?page=agents')
        await expect(confirm).toBeHidden()
        await expect(page.getByTestId('home-page-agents')).toBeVisible()
        await expect(page.locator('#config')).toBeHidden()
      })
    }
