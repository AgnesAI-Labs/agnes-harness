import { copyFile, mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page, TestInfo } from '@playwright/test'
import { expect, test } from './fixtures.js'
import { accessible, screen, settled, translated } from './quality.js'
import { prompt, toolResult } from './sdk.js'
import { chooseWorkspace, preferences, section, settings } from './ui.js'

const phone = { width: 375, height: 812 }
const tablet = { width: 768, height: 1024 }
const viewports = [phone, tablet]
const sections = [
  'model',
  'models',
  'bundles',
  'engines',
  'system-prompt',
  'memory',
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
  'diagnostics',
  'general',
]

/** Measure the live layout, including clipped controls even when the document hides overflow. */
async function usable(page: Page, info: TestInfo, name: string) {
  await settled(page)
  const layout = await page.evaluate(() => {
    const visible = (node: Element) =>
      node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden'
    const dialogs = [...document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]')].filter(
      visible,
    )
    const sheet = [...document.querySelectorAll<HTMLElement>('#workbench-right, #workbench-bottom')].find(
      (node) => visible(node) && getComputedStyle(node).position === 'fixed',
    )
    const root = dialogs.at(-1) ?? sheet ?? document
    const issues: string[] = []
    if (Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 1)
      issues.push('Document overflows horizontally')
    for (const node of root.querySelectorAll<HTMLElement>(
      'button, a[href], summary, select, input:not([type="hidden"]), [role="combobox"], [role="tab"], [role="switch"], hr[tabindex], [tabindex="0"]',
    )) {
      if (!visible(node) || node.closest('[inert]') || node.matches(':disabled, [aria-disabled="true"]'))
        continue
      const target =
        (node.matches('input[type=checkbox], input[type=radio]')
          ? node.closest('label')
          : node.closest('.ant-tabs-tab, .ant-select')) ?? node
      const rect = target.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1 || rect.bottom <= 0 || rect.top >= innerHeight) continue
      const label =
        node.dataset.testid ||
        node.id ||
        node.getAttribute('aria-label') ||
        node.textContent?.trim().slice(0, 50) ||
        `${node.tagName}.${node.className}`
      if (rect.width < 31.5 || rect.height < 31.5)
        issues.push(`${label}: target ${Math.round(rect.width)}×${Math.round(rect.height)}`)
      const scrollable = (axis: 'x' | 'y') => {
        for (let parent = target.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent)
          if (
            /auto|scroll/.test(axis === 'x' ? style.overflowX : style.overflowY) &&
            (axis === 'x'
              ? parent.scrollWidth > parent.clientWidth + 1
              : parent.scrollHeight > parent.clientHeight + 1)
          )
            return true
        }
        return false
      }
      if ((rect.left < -1 || rect.right > innerWidth + 1) && !scrollable('x'))
        issues.push(
          `${label}: outside horizontal viewport ${Math.round(rect.left)}–${Math.round(rect.right)} in ${target.parentElement?.className}`,
        )
    }
    const report = document.getElementById('report-problem')?.getBoundingClientRect()
    return {
      issues,
      viewport: innerWidth,
      rootScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      reportProblem: report ? { left: report.left, right: report.right, width: report.width } : null,
    }
  })
  await info.attach(`layout-${name}.json`, {
    body: JSON.stringify(layout, null, 2),
    contentType: 'application/json',
  })
  expect.soft(layout.issues, `${name}: controls fit and have at least 32px tap targets`).toEqual([])
  await translated(page)
  await accessible(page, info, name)
}

for (const locale of ['en', 'zh-CN'])
  for (const theme of ['light', 'dark'])
    test(`narrow screens ${locale}/${theme}`, async ({ page, runtime }, info) => {
      test.setTimeout(300_000)
      const en = locale === 'en'
      const name = (english: string, chinese: string) => (en ? english : chinese)
      let shots = 0
      const capture = async (surface: string, width: number) => {
        expect(++shots).toBeLessThanOrEqual(12)
        const key = `narrow-${surface}-${locale}-${theme}-${width}`
        if (surface === 'settings') {
          await settled(page)
          // Focusing a rail item can retain a horizontal scroll offset from earlier sections.
          // Frame navigation from its first item at both widths.
          await page.getByTestId('settings-nav-model').evaluate((button) => {
            if (button.parentElement) button.parentElement.scrollLeft = 0
          })
        }
        if (surface === 'session') {
          // Opening a tool after the phone flow can retain the previous reading position.
          // Frame the completed first turn from its start at both widths.
          const conversation = page.getByRole('region', { name: /^(Conversation|对话)$/, exact: true })
          await conversation.evaluate((viewport) => viewport.scrollTo({ top: 0, behavior: 'instant' }))
          await expect.poll(() => conversation.evaluate((viewport) => viewport.scrollTop)).toBe(0)
        }
        // Frame the review itself, independent of the preceding plugin pane's scroll anchor.
        if (surface === 'settings' && width === 375) {
          await page.getByTestId('candidate-review').evaluate((review) => {
            review.scrollIntoView({ block: 'start', behavior: 'instant' })
          })
          await expect(page.getByTestId('candidate-approve')).toBeInViewport({ ratio: 1 })
          await expect(page.getByTestId('candidate-reject')).toBeInViewport({ ratio: 1 })
        }
        await screen(page, info, key, [
          page.locator('.trace-stats .trace-stat'),
          page.getByTestId('request-trace').locator('time'),
          ...(surface === 'settings' && width === 768
            ? [page.getByTestId('memory-root'), page.getByTestId('memory-workspace')]
            : []),
        ])
        if (process.env.AGH_NARROW_REPORT) {
          await mkdir(process.env.AGH_NARROW_REPORT, { recursive: true })
          await copyFile(info.outputPath(`${key}.png`), join(process.env.AGH_NARROW_REPORT, `${key}.png`))
        }
      }
      const inspect = async (surface: string, both = true) => {
        const size = page.viewportSize()
        if (!size) throw new Error('The narrow matrix requires a viewport')
        for (const viewport of both ? viewports : [size]) {
          await page.setViewportSize(viewport)
          await usable(page, info, `${surface}-${viewport.width}`)
        }
      }
      await preferences(page, locale, theme)
      await page.setViewportSize(phone)
      await page.goto(runtime.url)
      const guide = page.getByTestId('first-run-guide')
      await expect(guide).toHaveAttribute('data-step', 'welcome')
      await inspect('wizard-welcome')
      await page.setViewportSize(phone)
      await capture('wizard', 375)
      // Seed tool history with the teaching model before configuring the wizard account.
      const client = await runtime.connect()
      const session = await client.session.new({
        cwd: runtime.workspace,
        preset: 'full-access',
        sessionKey: 'narrow-session',
      })
      await session.attach()
      session.onPermissionRequest(async () => ({ verdict: 'allowed-once' }))
      await client.session.rename(session.id, 'Review the delivery and its execution evidence')
      await prompt(session, 'call read {"path":"report.md"}')
      await prompt(session, 'call present {"files":[{"path":"report.md","name":"Delivery report.md"}]}')
      await prompt(session, 'call plugin_helper_guide {"kind":"tool"}')
      const result = (await toolResult(session, 'plugin_helper_guide'))?.content[0]
      if (result?.type !== 'text') throw new Error('The authoring guide must provide fixture files')
      await prompt(
        session,
        `call plugin_helper_create ${JSON.stringify({ files: JSON.parse(result.text).files })}`,
      )
      const created = (await toolResult(session, 'plugin_helper_create'))?.content[0]
      if (created?.type !== 'text') throw new Error('The fixture candidate must be created')
      const candidate = JSON.parse(created.text) as { candidateId: string; packageId: string }
      await prompt(
        session,
        `call plugin_helper_install ${JSON.stringify({ action: 'test', proposalId: candidate.candidateId })}`,
      )
      await prompt(
        session,
        'call plugin_helper_install ' +
          JSON.stringify({ action: 'commit', proposalId: candidate.candidateId }),
      )
      await prompt(session, 'call write {"path":"review notes.ts","content":"export const result = 42\\n"}')
      await prompt(session, '/goal --max-rounds 1 Review the delivery')
      expect((await client.apis()).profile.models).toEqual(
        expect.arrayContaining([expect.objectContaining({ route: 'demo', id: 'demo-model' })]),
      )
      await page.getByTestId('first-run-next').click()
      await inspect('wizard-account')
      await page.getByTestId('first-run-add').click()
      const account = page.getByRole('dialog', { name: name('Add account', '添加账户'), exact: true })
      await expect(account).toBeVisible()
      await inspect('wizard-account-form')
      // Traverse every wizard step with a real loopback account.
      const catalog = (await client.config.test({ providerId: 'deepseek' })).models
      const model = catalog[0]?.id
      if (!model) throw new Error('The installed provider must declare a fixture model')
      const { startProviderFixture } = await import('../acceptance/provider-fixture.js')
      const provider = await startProviderFixture('NARROW_READY', undefined, model)
      try {
        await account
          .getByRole('textbox', { name: name('Account name', '账户名称'), exact: true })
          .fill('Local test account')
        await account.getByRole('combobox', { name: en ? /^Provider:/ : /^Provider：/ }).click()
        await page.getByRole('option', { name: 'DeepSeek', exact: true }).click()
        await account
          .getByRole('textbox', { name: name('Base URL', '服务地址'), exact: true })
          .fill(provider.baseUrl)
        await account.getByLabel('API Key', { exact: true }).fill(provider.apiKey)
        await account.getByRole('button', { name: name('Test connection', '测试连接'), exact: true }).click()
        await expect(
          account.getByRole('button', { name: name('Save account', '保存账户'), exact: true }),
        ).toBeEnabled()
        await account.getByRole('button', { name: name('Save account', '保存账户'), exact: true }).click()
        await expect(guide).toHaveAttribute('data-step', 'model')
        await inspect('wizard-model')
        await page.getByTestId('first-run-next').click()
        await expect(guide).toHaveAttribute('data-step', 'examples')
        await inspect('wizard-examples')
        await page.getByTestId('first-run-next').click()
        await expect(guide).toHaveAttribute('data-step', 'ready')
        await inspect('wizard-ready')
        await page.getByTestId('first-run-next').click()
        await expect(guide).toBeHidden()
        await expect(page.locator('#new-session[open]')).toBeVisible()
        await inspect('new-session-workspace')
        await chooseWorkspace(page, runtime, locale)
        for (const viewport of viewports) {
          await page.setViewportSize(viewport)
          await usable(page, info, `home-${viewport.width}`)
          await capture('home', viewport.width)
          await page.getByTestId('composer-agent').click()
          await expect(page.getByTestId('agent-options')).toBeVisible()
          await usable(page, info, `composer-chips-${viewport.width}`)
          await page.keyboard.press('Escape')
          await expect(page.getByTestId('composer-agent')).toBeFocused()
        }
        const route = (await client.config.get()).provider?.route
        if (!route) throw new Error('The wizard must configure a provider route')
        await expect
          .poll(async () =>
            (await client.apis()).profile.models?.some(
              (entry) => entry.route === route && entry.id === model,
            ),
          )
          .toBe(true)
        const offered = (await client.apis()).profile.models
        expect(offered).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ route: 'demo', id: 'demo-model' })]),
        )
        // Saving an account retires the teaching route. Select an offered model for continuation;
        // recorded tool/request history still belongs to the demo model that actually produced it.
        await session.setModel({ slot: 'primary', route, model })
        await info.attach('configured-model-catalog.json', {
          body: JSON.stringify(offered?.map(({ route, id }) => ({ route, id }))),
          contentType: 'application/json',
        })
        await page.goto(`${runtime.url}/?session=${session.id}`)
        await expect(page.getByTestId('conversation-turn').last()).toHaveAttribute('data-status', 'completed')
        for (const viewport of viewports) {
          await page.setViewportSize(viewport)
          await expect(page.locator('#model')).toContainText(model)
          await expect(page.locator('#model')).toBeEnabled()
          await expect(page.locator('#composer-hint')).not.toHaveText(
            name(
              'The current model is no longer available; pick another model',
              '当前模型已不可用，请重新选择模型',
            ),
          )
          await page.getByTestId('conversation-turn').first().getByTestId('turn-process-toggle').click()
          await page.getByTestId('tool-detail-toggle').first().click()
          await expect(page.getByTestId('tool-detail-text').first()).toContainText('Synthetic delivery')
          await usable(page, info, `session-${viewport.width}`)
          await capture('session', viewport.width)
          await expect(page.locator('#report-problem')).toBeInViewport({ ratio: 1 })
          await page.locator('#report-problem').click()
          const diagnostics = page.locator('.diagnostics-dialog')
          await expect(diagnostics).toBeVisible()
          await usable(page, info, `report-problem-${viewport.width}`)
          await diagnostics.locator('[data-action="share"]').click()
          await usable(page, info, `diagnostics-share-${viewport.width}`)
          await page.keyboard.press('Escape')
          await expect(diagnostics).toBeHidden()
          await expect(page.locator('#report-problem')).toBeFocused()
          const delivery = page.getByTestId('deliverable-open')
          await delivery.scrollIntoViewIfNeeded()
          await usable(page, info, `delivery-${viewport.width}`)
          await page.getByTestId('conversation-turn').last().scrollIntoViewIfNeeded()
          await usable(page, info, `session-last-turn-${viewport.width}`)
          await page.getByTestId('tool-detail-toggle').first().click()
          const evidence = page.getByTestId('tool-fact-chain').first()
          await evidence.click()
          await expect(page.getByTestId('fact-chain').locator('[data-fact-kind="receipt"]')).toBeVisible()
          await usable(page, info, `facts-${viewport.width}`)
          if (viewport.width === 375) await capture('facts', viewport.width)
          const boundary = await page.locator('#workbench-right').evaluate((host) => {
            const nodes = [
              ...host.querySelectorAll<HTMLElement>(
                'button, input, textarea, select, summary, a[href], [tabindex]',
              ),
            ].filter(
              (node) =>
                node.tabIndex >= 0 &&
                !node.matches(':disabled') &&
                node.getClientRects().length > 0 &&
                getComputedStyle(node).visibility !== 'hidden',
            )
            nodes.forEach((node, index) => {
              node.dataset.narrowFocus = String(index)
            })
            return nodes.length - 1
          })
          const first = page.locator('#workbench-right [data-narrow-focus="0"]')
          const last = page.locator(`#workbench-right [data-narrow-focus="${boundary}"]`)
          await first.press('Shift+Tab')
          await expect(last).toBeFocused()
          await page.keyboard.press('Tab')
          await expect(first).toBeFocused()
          await page.keyboard.press('Escape')
          await expect(evidence).toBeFocused()
          await page.getByTestId('conversation-turn').first().getByTestId('turn-process-toggle').click()
          await page.locator('#view-trace').click()
          await page.locator('.trace-type-filter').selectOption('assistant')
          await usable(page, info, `trace-${viewport.width}`)
          await page.locator('.trace-row').first().click()
          await expect(page.getByTestId('request-trace')).toBeVisible()
          const selectPane = async (pane: string) => {
            const picker = page.getByTestId('request-trace-pane')
            const tab = page.getByTestId(`request-trace-tab-${pane}`)
            await expect.poll(async () => (await picker.isVisible()) || (await tab.isVisible())).toBe(true)
            if (await picker.isVisible()) await picker.selectOption(pane)
            else await tab.click()
          }
          for (const pane of ['system', 'tools', 'messages', 'params', 'tokens', 'raw']) {
            await selectPane(pane)
            await usable(page, info, `request-${pane}-${viewport.width}`)
          }
          await selectPane('system')
          await capture('request', viewport.width)
          await page.locator('.trace-inspector-close').press('Escape')
          await expect(page.locator('.trace-row').first()).toBeFocused()
          await page.locator('#view-chat').click()
          await page.getByTestId('workbench-right-toggle').click()
          await page.getByTestId('workbench-tab-files').click()
          await page.getByTestId('files-panel').locator('[data-path="report.md"]').click()
          await expect(page.getByTestId('file-preview')).toContainText('Synthetic delivery')
          await usable(page, info, `files-${viewport.width}`)
          if (viewport.width === 768) await capture('workbench', viewport.width)
          await page.getByTestId('workbench-tab-goal').click()
          await expect(page.getByTestId('goal-panel-phase')).toBeVisible()
          await usable(page, info, `goal-${viewport.width}`)
          await page.getByTestId('workbench-tab-changed-files').click()
          await page.getByTestId('changed-file').filter({ hasText: 'review notes.ts' }).click()
          await expect(page.getByTestId('changes-diff')).toContainText('result = 42')
          await expect(page.getByTestId('changed-file').filter({ hasText: 'review notes.ts' })).toBeFocused()
          await usable(page, info, `changes-${viewport.width}`)
          await page.getByTestId('changes-mention').click()
          await expect(page.locator('#workbench-right')).toBeHidden()
          await expect(page.locator('#prompt')).toBeFocused()
          await expect(page.locator('#prompt')).toHaveValue('"review notes.ts"')
          await page.locator('#prompt').fill('')
          await page.getByTestId('workbench-bottom-toggle').click()
          await expect(page.getByTestId('terminal-panel')).toBeVisible()
          await usable(page, info, `terminal-${viewport.width}`)
          await page.getByTestId('terminal-new').click()
          await expect(page.getByTestId('terminal-new')).toBeEnabled()
          await expect(
            page.getByTestId('terminal-panel').getByTestId('terminal-tab-close').first(),
          ).toBeVisible()
          const output = page.getByTestId('workbench-terminal-output')
          await expect(output).toHaveValue(/[$#] /)
          await output.pressSequentially(
            "PS1='narrow$ '; printf '\\033[2J\\033[H'; printf 'NARROW_TERMINAL_OK\\n'",
          )
          await output.press('Enter')
          await expect(output).toHaveValue(/NARROW_TERMINAL_OK\r?\n/)
          await usable(page, info, `terminal-running-${viewport.width}`)
          if (viewport.width === 375) await capture('workbench', viewport.width)
          if (viewport.width === 768) {
            await page.locator('#workbench-bottom .workbench-resize').press('Shift+Tab')
            await expect
              .poll(() =>
                page.locator('#workbench-bottom').evaluate((host) => host.contains(document.activeElement)),
              )
              .toBe(false)
          }
          await page.getByTestId('workbench-tab-terminal').press('Escape')
          await expect(page.getByTestId('workbench-bottom-toggle')).toBeFocused()
          expect(
            (await session.jobsRead()).jobs
              .filter((job) => job.owner === 'human')
              .every((job) => job.status === 'running'),
          ).toBe(true)
          await page.locator('.sidebar-toggle').click()
          await settings(page, locale)
          for (const id of sections) {
            await section(page, id)
            if (id === 'memory') {
              await expect(page.getByTestId('memory-panel')).toHaveAttribute('aria-busy', 'false')
              await page.getByTestId('memory-workspace').selectOption(await realpath(runtime.workspace))
              await page.getByTestId('memory-open').click()
              await expect(page.getByTestId('memory-content')).toBeVisible()
            }
            await usable(page, info, `settings-${id}-${viewport.width}`)
            if (id === 'plugins') {
              await page.getByTestId('candidate-open').filter({ hasText: candidate.packageId }).click()
              await expect(page.getByTestId('candidate-approve')).toBeInViewport({ ratio: 1 })
              await expect(page.getByTestId('candidate-reject')).toBeInViewport({ ratio: 1 })
              await usable(page, info, `candidate-review-${viewport.width}`)
              if (viewport.width === 375) await capture('settings', viewport.width)
            }
            if (id === 'memory' && viewport.width === 768) await capture('settings', viewport.width)
          }
          await page.keyboard.press('Escape')
          await expect(page.getByTestId('settings-navigation')).toBeHidden()
          await page.keyboard.press('Escape')
          await expect(page.locator('.sidebar')).toBeHidden()
          if (viewport.width === 768) {
            await page.getByTestId('workbench-bottom-toggle').click()
            await page.getByTestId('workbench-right-toggle').click()
            await expect(page.locator('#workbench-bottom')).toBeVisible()
            await page.setViewportSize(phone)
            await expect(page.locator('#workbench-bottom')).toBeHidden()
            await expect(page.locator('#workbench-right')).toBeVisible()
            await usable(page, info, 'resize-to-one-sheet')
            await page.getByTestId('workbench-tab-changed-files').press('Escape')
            await expect(page.getByTestId('workbench-right-toggle')).toBeFocused()
            await page.setViewportSize(tablet)
          }
        }
        expect(shots).toBe(12)
      } finally {
        await provider.close()
      }
    })
