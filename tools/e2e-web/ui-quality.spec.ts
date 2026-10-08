import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { localeKeys, unresolvedLabels } from './i18n.js'

const root = process.env.AGH_UI_REPORT
const workspace = process.env.AGH_UI_WORKSPACE
// This test always renders the main screens in both locales. Optional artifacts cover the
// full visual matrix; use a real daemon with an isolated home and the built-in demo model.
for (const locale of ['zh-CN', 'en'])
  for (const theme of ['light', 'dark'])
    for (const [width, height] of [
      [1440, 900],
      [1280, 800],
    ] as const) {
      test(`UI quality ${locale}/${theme}/${width}x${height}`, async ({ page }) => {
        test.setTimeout(process.env.AGH_UI_AXE === '1' ? 240_000 : 120_000)
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
          await page.waitForTimeout(250)
          await page.evaluate(() =>
            Promise.all(
              document
                .getAnimations()
                .filter((animation) => animation instanceof CSSTransition)
                .map((animation) => animation.finished.catch(() => undefined)),
            ),
          )
          const unresolved = await page.evaluate(unresolvedLabels, knownKeys)
          expect(unresolved, `${name}: unresolved locale keys`).toEqual([])
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
            `${name}: viewport overflow`,
          ).toBe(true)
          expect(errors, `${name}: uncaught browser errors`).toEqual([])
          if (folder) await page.screenshot({ path: join(folder, `${name}.png`) })
          if (process.env.AGH_UI_AXE === '1' && width === 1440) {
            const scan = await new AxeBuilder({ page })
              .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
              .analyze()
            expect(
              scan.violations.map(({ id, nodes }) => ({
                id,
                targets: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
              })),
              `${name}: accessibility`,
            ).toEqual([])
          }
        }
        await page.goto('/?new=1')
        await expect(page.locator('#settings')).toBeVisible()
        await page.waitForTimeout(1000)
        if (await page.locator('#new-session[open]').count()) {
          if (!workspace) throw new Error('Set AGH_UI_WORKSPACE to an isolated workspace for a fresh home')
          await page.locator('#workspace-manual').evaluate((element: HTMLDetailsElement) => {
            element.open = true
          })
          await page.locator('#new-session-cwd').fill(workspace)
          await page.locator('#new-session-create').click()
        } else {
          await page.locator('#new').click()
          await page.waitForTimeout(350)
          if (await page.locator('#new-session[open]').count()) {
            if (!workspace) throw new Error('Set AGH_UI_WORKSPACE for workspace selection')
            await page.locator('#workspace-manual').evaluate((element: HTMLDetailsElement) => {
              element.open = true
            })
            await page.locator('#new-session-cwd').fill(workspace)
            await page.locator('#new-session-create').click()
          }
        }
        await screen('home-empty')
        await expect(page.getByTestId('goal-bar')).toBeHidden()
        await page.getByTestId('composer-agent').click()
        await screen('agent-options')
        await page.keyboard.press('Escape')
        await page.locator('#settings').click()
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
          await page.locator(`#${id}`).click()
          if (id === 'skills-tab' || id === 'mcp-tab') {
            await expect(page.locator(`#${id}`)).not.toHaveAttribute('role', 'tab')
            await expect(page.locator(`#${id}`)).toHaveAttribute('tabindex', '0')
          }
          await screen(`settings-${name}`)
        }
        const groups: Record<string, string> = {
          plugins: 'plugins',
          providers: 'plugins',
          examples: 'plugins',
          models: 'models',
          bundles: 'models',
          engines: 'models',
          search: 'search',
          context: 'search',
          jobs: 'jobs',
          terminal: 'jobs',
          schedules: 'jobs',
          security: 'security',
          history: 'history',
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
          'terminal',
          'jobs',
          'schedules',
        ]) {
          await page.getByTestId(`settings-nav-${groups[id]}`).click()
          const tab = page.getByTestId(`settings-nav-${id}-tab`)
          if (await tab.count()) await tab.click()
          await expect(page.getByTestId(`settings-page-${id}`)).toBeVisible()
          if (id === 'plugins') await expect(page.locator('#install-source')).toBeEnabled()
          await screen(`runtime-${id}`)
          if (id === 'bundles' && (await page.getByTestId('session-tool-groups').count())) {
            await page.getByTestId('session-tool-groups').first().locator('summary').first().click()
            await screen('session-tool-info')
          }
          if (id === 'examples') {
            await expect(page.getByTestId('example-install-dag-loop')).toBeVisible()
            await expect(page.getByTestId('example-install-react-loop')).toBeVisible()
            await expect(page.locator('[data-testid^="example-install-"]')).toHaveCount(17)
          }
        }
        await page.getByTestId('settings-nav-history').click()
        await page.locator('#archived-settings').click()
        await screen('settings-archives')
        await page.getByTestId('settings-nav-models').click()
        await page.getByTestId('settings-nav-models-tab').focus()
        await page.keyboard.press('ArrowRight')
        await expect(page.getByTestId('settings-nav-bundles-tab')).toBeFocused()
        await expect(page.getByTestId('settings-page-bundles')).toBeVisible()
        await page.getByTestId('settings-nav-plugins').click()
        await page.getByTestId('settings-nav-plugins-tab').click()
        await page.locator('#install-source').click()
        await screen('plugin-install')
        await page.locator('#source-cancel').click()
        await page.locator('#config-close').click()
        await page.locator('#prompt').fill('UI quality demo')
        await page.locator('#send').click()
        await expect(page.locator('#prompt')).toBeEnabled()
        await page.waitForTimeout(750)
        await page.locator('#prompt').fill('call ls {"path":"."}')
        await page.locator('#send').click()
        await page.waitForTimeout(1000)
        await screen('active-session')
        const calls = [
          'call job_list {}',
          ...(process.env.AGH_UI_DELIVERABLE
            ? ['call present ' + JSON.stringify({ files: [{ path: process.env.AGH_UI_DELIVERABLE }] })]
            : []),
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
          await page.locator('#prompt').fill(call)
          await page.locator('#send').click()
          await page.waitForTimeout(900)
        }
        await expect(page.getByTestId('question-card')).toBeVisible()
        await page.getByTestId('question-card').scrollIntoViewIfNeeded()
        await screen('active-session-cards')
        if (process.env.AGH_UI_DELIVERABLE) {
          await expect(page.getByTestId('deliverable-card')).toBeVisible()
          await page.getByTestId('deliverable-card').scrollIntoViewIfNeeded()
          await screen('deliverable-card')
        }
        await expect(page.getByTestId('background-job-card')).toBeVisible()

        await page.locator('#view-trace').click()
        await screen('trace')
        await page.locator('#view-chat').click()
        await page.goto('/?settings=bundles')
        await expect(page.getByTestId('settings-page-bundles')).toBeVisible()
        await expect(page.locator('#new-session')).toBeHidden()
        await screen('deep-link-bundles')
      })
    }
