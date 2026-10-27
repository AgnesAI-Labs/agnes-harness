import { copyFile, mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import type { Page, TestInfo } from '@playwright/test'
import { expect, test } from './fixtures.js'
import { accessible, screen, settled, translated } from './quality.js'
import { describingFirst, prompt, toolResult } from './sdk.js'
import {
  advanced,
  closeSettings,
  expand,
  preferences,
  section,
  selectValue,
  settings,
  workbenchTab,
} from './ui.js'

const phone = { width: 375, height: 812 }
const tablet = { width: 768, height: 1024 }
const viewports = [phone, { width: 390, height: 844 }, tablet]
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
  'security',
  'application',
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
      'button, a[href], summary, select, input:not([type="hidden"]), [role="combobox"], [role="tab"], [role="switch"], [role="option"], hr[tabindex], [tabindex="0"]',
    )) {
      if (!visible(node) || node.closest('[inert]') || node.matches(':disabled, [aria-disabled="true"]'))
        continue
      const target =
        (node.matches('input[type=checkbox], input[type=radio]')
          ? node.closest('label')
          : node.matches('.xterm-helper-textarea')
            ? node.closest('.xterm')
            : node.closest('.ant-tabs-tab, .ant-select')) ?? node
      const rect = target.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1 || rect.bottom <= 0 || rect.top >= innerHeight) continue
      const label =
        node.dataset.testid ||
        node.id ||
        node.getAttribute('aria-label') ||
        node.textContent?.trim().slice(0, 50) ||
        `${node.tagName}.${node.className}`
      // Read-only code scrollports keep their original 32px floor; actions need 44px.
      const minimum = innerWidth <= 767 && !node.matches('pre') ? 44 : 32
      const after = getComputedStyle(target, '::after')
      const expanded =
        after.content !== 'none' && after.position === 'absolute' && after.pointerEvents !== 'none'
      const width = Math.max(rect.width, expanded ? Number.parseFloat(after.width) || 0 : 0)
      const height = Math.max(rect.height, expanded ? Number.parseFloat(after.height) || 0 : 0)
      if (width < minimum - 0.5 || height < minimum - 0.5)
        issues.push(`${label}: target ${Math.round(width)}×${Math.round(height)}`)
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
      overflow: [...document.querySelectorAll<HTMLElement>('body *')]
        .filter(visible)
        .flatMap((node) => {
          const rect = node.getBoundingClientRect()
          return rect.right > innerWidth + 1 && rect.top < innerHeight && rect.bottom > 0
            ? [
                {
                  tag: node.tagName,
                  className: node.className,
                  id: node.id,
                  text: node.textContent?.slice(0, 80),
                  right: rect.right,
                  width: rect.width,
                  display: getComputedStyle(node).display,
                  minWidth: getComputedStyle(node).minWidth,
                },
              ]
            : []
        })
        .slice(0, 40),
      reportProblem: report ? { left: report.left, right: report.right, width: report.width } : null,
    }
  })
  await info.attach(`layout-${name}.json`, {
    body: JSON.stringify(layout, null, 2),
    contentType: 'application/json',
  })
  expect
    .soft(layout.issues, `${name}: controls fit and have 44px phone / 32px tablet tap targets`)
    .toEqual([])
  await translated(page)
  await accessible(page, info, name)
}

for (const locale of ['en', 'zh-CN'])
  for (const theme of ['light', 'dark'])
    test(`narrow screens ${locale}/${theme}`, async ({ page, runtime }, info) => {
      // This flow performs the full wizard, workbench and settings audit at three widths.
      // Give the complete audit room to finish; individual action/assertion deadlines stay unchanged.
      test.setTimeout(600_000)
      const en = locale === 'en'
      const name = (english: string, chinese: string) => (en ? english : chinese)
      let shots = 0
      const capture = async (surface: string, width: number) => {
        if (width === 390) return // Additional behavioural coverage keeps the existing pixel matrix.
        expect(++shots).toBeLessThanOrEqual(12)
        const key = `narrow-${surface}-${locale}-${theme}-${width}`
        if (surface === 'settings' && width === 768)
          await page.getByTestId('memory-content').scrollIntoViewIfNeeded()
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
          page.locator('.trace-inspector-meta'),
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
      await expect(guide).toHaveAttribute('data-step', 'account')
      await inspect('wizard-welcome')
      await page.setViewportSize(phone)
      await capture('wizard', 375)
      // Seed tool history with the teaching model before configuring the wizard account.
      const client = await runtime.connect()
      const session = await client.session.new({
        cwd: runtime.workspace,
        preset: 'standard',
        permission: 'full-access',
        sessionKey: 'narrow-session',
      })
      await session.attach()
      session.onPermissionRequest(async () => ({ verdict: 'allowed-once' }))
      await client.session.rename(session.id, 'Review the delivery and its execution evidence')
      await prompt(session, 'call read {"path":"report.md"}')
      await prompt(session, 'call present {"files":[{"path":"report.md","name":"Delivery report.md"}]}')
      // The on-demand authoring tools are described first; their turns live in a session of their
      // own so the inspected conversation keeps its turns inside the opening window.
      const authoring = await client.session.new({
        cwd: runtime.workspace,
        preset: 'standard',
        // Under full access a commit publishes at once; this flow inspects the pending review.
        permission: 'workspace-write',
        sessionKey: 'narrow-authoring',
      })
      await authoring.attach()
      authoring.onPermissionRequest(async () => ({ verdict: 'allowed-once' }))
      await client.session.rename(authoring.id, 'Prepare the reviewed plugin')
      const promptOnDemand = describingFirst((input) => prompt(authoring, input))
      await promptOnDemand('call plugin_helper_guide {"kind":"tool"}')
      const result = (await toolResult(authoring, 'plugin_helper_guide'))?.content[0]
      if (result?.type !== 'text') throw new Error('The authoring guide must provide fixture files')
      await promptOnDemand(
        `call plugin_helper_create ${JSON.stringify({ files: JSON.parse(result.text).files })}`,
      )
      const created = (await toolResult(authoring, 'plugin_helper_create'))?.content[0]
      if (created?.type !== 'text') throw new Error('The fixture candidate must be created')
      const candidate = JSON.parse(created.text) as { candidateId: string; packageId: string }
      await promptOnDemand(
        `call plugin_helper_install ${JSON.stringify({ action: 'test', proposalId: candidate.candidateId })}`,
      )
      await promptOnDemand(
        'call plugin_helper_install ' +
          JSON.stringify({ action: 'commit', proposalId: candidate.candidateId }),
      )
      await prompt(session, 'call write {"path":"review notes.ts","content":"export const result = 42\\n"}')
      await prompt(session, '/goal --max-rounds 1 Review the delivery')
      expect((await client.apis()).profile.models).toEqual(
        expect.arrayContaining([expect.objectContaining({ route: 'demo', id: 'demo-model' })]),
      )
      await inspect('wizard-account')
      await page.getByTestId('first-run-add').click()
      const account = page.getByTestId('first-run-connection')
      await expect(account.locator('#config-provider-trigger')).toBeEnabled()
      await expand(account.locator('#config-account-advanced'))
      await inspect('wizard-account-form')
      // Traverse every wizard step with a real loopback account.
      const catalog = (await client.config.test({ providerId: 'deepseek' })).models
      const model = catalog[0]?.id
      if (!model) throw new Error('The installed provider must declare a fixture model')
      const { startProviderFixture } = await import('../acceptance/provider-fixture.js')
      const provider = await startProviderFixture('NARROW_READY', undefined, model)
      try {
        await expand(account.locator('#config-account-advanced'))
        await account
          .getByRole('textbox', { name: name('Account name', '账户名称'), exact: true })
          .fill('Local test account')
        await account.getByRole('combobox', { name: en ? /^Provider:/ : /^服务商：/ }).click()
        await page.getByRole('option', { name: 'DeepSeek', exact: true }).click()
        await account
          .getByRole('textbox', { name: name('Base URL', '服务地址'), exact: true })
          .fill(provider.baseUrl)
        await account.locator('#config-api-key').fill(provider.apiKey)
        await page.getByTestId('first-run-next').click()
        await expect(guide).toHaveAttribute('data-step', 'workspace')
        await guide.locator('.agh-disclosure > .agh-disclosure-summary').click()
        await guide
          .getByRole('textbox', { name: name('Folder path', '文件夹路径'), exact: true })
          .fill(runtime.workspace)
        await guide.getByRole('button', { name: name('Use folder', '使用此文件夹'), exact: true }).click()
        await expect(page.getByTestId('first-run-workspace')).toHaveText('w')
        await inspect('wizard-workspace')
        await page.getByTestId('first-run-next').click()
        await expect(guide).toHaveAttribute('data-step', 'ready')
        await inspect('wizard-ready')
        await page.getByTestId('first-run-next').click()
        await expect(guide).toBeHidden()
        await expect(
          page.getByRole('dialog', {
            name: locale === 'en' ? 'Choose a workspace' : '选择工作区',
            exact: true,
          }),
        ).toBeHidden()
        await advanced(page)
        await closeSettings(page, locale)
        await inspect('selected-workspace')
        for (const viewport of viewports) {
          await page.setViewportSize(viewport)
          await usable(page, info, `home-${viewport.width}`)
          await capture('home', viewport.width)
          await expect(page.getByTestId('composer-agent')).toBeEnabled()
          await expect(page.getByTestId('composer-agent')).toHaveAttribute(
            'aria-label',
            locale === 'en' ? 'More' : '更多',
          )
          if ((await page.locator('#sidebar-toggle').getAttribute('aria-expanded')) === 'true')
            await page.locator('#sidebar-close').click()
          await page.locator('#composer-permission').click()
          await expect(page.locator('#permission-picker-popover')).toBeVisible()
          await usable(page, info, `composer-chips-${viewport.width}`)
          await page.keyboard.press('Escape')
          await expect(page.locator('#composer-permission')).toBeFocused()
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
        // Inspect the recorded deliverable through both placements, then return to the conversation.
        const delivery = page.getByTestId('turn-deliverables').filter({ hasText: 'Delivery report.md' })
        await expect(delivery).toHaveAttribute('aria-label', name('Deliverables', '交付物'))
        await expand(
          page.getByTestId('conversation-turn').nth(1).getByTestId('turn-process-toggle').locator('..'),
        )
        await expect(delivery).toContainText('Delivery report.md')
        await delivery.locator('.agh-list-row-title').first().click()
        await expect(page.getByTestId('workbench-deliverables')).toContainText('Delivery report.md')
        await page
          .locator('#workbench-right')
          .getByRole('button', { name: name('Close this dock', '关闭此停靠面板'), exact: true })
          .click()
        await expect(page.getByTestId('workbench-right-toggle')).toHaveAttribute('aria-expanded', 'false')
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
          const input = page.locator('#prompt')
          await expect(input).toHaveValue('')
          await expect
            .poll(
              () =>
                input.evaluate((node) =>
                  Math.abs(
                    node.getBoundingClientRect().height -
                      2 * Number.parseFloat(getComputedStyle(node).lineHeight),
                  ),
                ),
              { message: 'The empty prompt follows two current line heights after viewport changes' },
            )
            .toBeLessThanOrEqual(1)
          const process = page.getByTestId('conversation-turn').first().getByTestId('turn-process-toggle')
          if ((await process.getAttribute('aria-expanded')) !== 'true') await process.click()
          await expect(process).toHaveAttribute('aria-expanded', 'true')
          const detail = page.getByTestId('tool-detail-toggle').first()
          if ((await detail.getAttribute('aria-expanded')) !== 'true') await detail.click()
          await expect(page.getByTestId('tool-detail-text').first()).toContainText('Synthetic delivery')
          await usable(page, info, `session-${viewport.width}`)
          await capture('session', viewport.width)
          const report = page.locator('#report-problem')
          const reportTrigger = (await report.isVisible()) ? report : page.locator('#topbar-more')
          await expect(reportTrigger).toBeInViewport({ ratio: 1 })
          await reportTrigger.click()
          if (!(await report.isVisible())) {
            const label = await report.getAttribute('aria-label')
            if (!label) throw new Error('Report action must have an accessible name')
            await page.getByRole('menuitem', { name: label, exact: true }).click()
          }
          const diagnostics = page.locator('.diagnostics-dialog')
          await expect(diagnostics).toBeVisible()
          await usable(page, info, `report-problem-${viewport.width}`)
          await diagnostics.locator('[data-action="share"]').click()
          await usable(page, info, `diagnostics-share-${viewport.width}`)
          await page.keyboard.press('Escape')
          await expect(diagnostics).toBeHidden()
          await expect(reportTrigger).toBeFocused()
          await expect(delivery).toContainText('Delivery report.md')
          await delivery.scrollIntoViewIfNeeded()
          await usable(page, info, `delivery-${viewport.width}`)
          await page.getByTestId('conversation-turn').last().scrollIntoViewIfNeeded()
          await usable(page, info, `session-last-turn-${viewport.width}`)
          await expect(page.getByTestId('tool-detail-toggle').first()).toHaveAttribute(
            'aria-expanded',
            'true',
          )
          const evidence = page.getByTestId('tool-fact-chain').first()
          await evidence.click()
          const inspector = page.locator('.trace-inspector')
          await expect(inspector.locator('[data-link="receipt"]')).toBeVisible()
          // On narrow screens the inspector replaces the toolbar; close it to change timeline mode.
          const selectedId = await page
            .locator('.trace-row[aria-current="true"]')
            .getAttribute('data-trace-row-id')
          const sourceRow = page.locator(`.trace-row[data-trace-row-id="${selectedId}"]`)
          await inspector.locator('.trace-inspector-close').click()
          await page.getByTestId('trace-toolbar-more').click()
          await page.getByTestId('trace-timeline-sequence').click()
          await sourceRow.click()
          await expect(inspector).toBeInViewport()
          await usable(page, info, `facts-${viewport.width}`)
          if (viewport.width === 375) await capture('facts', viewport.width)
          await inspector.locator('.trace-inspector-close').press('Escape')
          await expect(sourceRow).toBeFocused()
          await page.locator('#view-chat').click()
          await expect(evidence).toBeVisible()
          await evidence.click()
          await page.keyboard.press('F6')
          expect(
            await page.locator('#trace-panel').evaluate((node) => node.contains(document.activeElement)),
          ).toBe(true)
          await inspector.locator('.trace-inspector-close').click()
          await page.locator('.trace-search').focus()
          await expect(page.locator('#composer')).toBeHidden()
          for (const key of ['F6', 'Shift+F6']) {
            await page.keyboard.press(key)
            expect(
              await page.locator('#trace-panel').evaluate((node) => node.contains(document.activeElement)),
            ).toBe(true)
          }
          const chip = page.locator('.trace-chip[data-kind="assistant"]')
          if ((await chip.getAttribute('aria-pressed')) !== 'true') await chip.click()
          await usable(page, info, `trace-${viewport.width}`)
          await page.locator('.trace-row').first().click()
          await page.locator('.trace-tab[data-pane="request"]').click()
          await expect(page.getByTestId('request-trace')).toBeVisible()
          for (const section of ['system', 'tools', 'messages', 'params']) {
            await expand(page.getByTestId(`request-trace-section-${section}`))
            await usable(page, info, `request-${section}-${viewport.width}`)
          }
          await page.locator('.trace-tab[data-pane="usage"]').click()
          await expect(page.getByTestId('request-trace-summary')).toBeVisible()
          await usable(page, info, `request-tokens-${viewport.width}`)
          await page.locator('.trace-tab[data-pane="request"]').click()
          await page
            .getByTestId('request-trace-mode')
            .getByRole('radio', { name: name('Sent JSON', '实际发送 JSON'), exact: true })
            .check()
          await usable(page, info, `request-raw-${viewport.width}`)
          await page
            .getByTestId('request-trace-mode')
            .getByRole('radio', { name: name('Logical request', '逻辑请求'), exact: true })
            .check()
          await capture('request', viewport.width)
          await page.locator('.trace-inspector-close').press('Escape')
          await expect(page.locator('.trace-row').first()).toBeFocused()
          await page.locator('#view-chat').click()
          await workbenchTab(page, 'files')
          await page
            .getByTestId('files-panel')
            .getByTestId('workspace-file')
            .and(page.locator('[data-path="report.md"]'))
            .click()
          await expect(page.getByTestId('file-preview')).toContainText('Synthetic delivery')
          await usable(page, info, `files-${viewport.width}`)
          if (viewport.width === 768) await capture('workbench', viewport.width)
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
          await expect(page.getByTestId('workbench-right-toggle')).toBeFocused()
          await workbenchTab(page, 'files')
          await page.keyboard.press('F6')
          expect(
            await page.locator('#composer').evaluate((node) => node.contains(document.activeElement)),
          ).toBe(true)
          await workbenchTab(page, 'files')
          await workbenchTab(page, 'goal')
          await expect(page.getByTestId('goal-panel-phase')).toBeVisible()
          await usable(page, info, `goal-${viewport.width}`)
          await workbenchTab(page, 'changed-files')
          await page.getByTestId('changed-file').filter({ hasText: 'review notes.ts' }).click()
          await expect(page.getByTestId('changes-diff')).toContainText('result = 42')
          await expect(page.getByTestId('changed-file').filter({ hasText: 'review notes.ts' })).toBeFocused()
          await usable(page, info, `changes-${viewport.width}`)
          await page.getByTestId('changes-mention').click()
          await expect(page.locator('#workbench-right')).toBeHidden()
          await expect(page.locator('#prompt')).toBeFocused()
          await expect(page.locator('#prompt')).toHaveValue('@review notes.ts ')
          await page.locator('#prompt').fill('')
          if ((await page.getByTestId('workbench-right-toggle').getAttribute('aria-expanded')) === 'true')
            await page
              .locator('#workbench-right')
              .getByRole('button', { name: name('Close this dock', '关闭此停靠面板'), exact: true })
              .click()
          await workbenchTab(page, 'terminal')
          await expect(page.getByTestId('terminal-panel')).toBeVisible()
          await usable(page, info, `terminal-${viewport.width}`)
          await page.getByTestId('terminal-new').click()
          await expect(page.getByTestId('terminal-new')).toBeEnabled()
          await expect(
            page.getByTestId('terminal-panel').getByTestId('terminal-tab-close').first(),
          ).toBeVisible()
          const output = page.getByTestId('workbench-terminal-output')
          const terminalText = output.locator('.xterm-accessibility-tree')
          const terminalInput = output.locator('textarea')
          await expect(terminalInput).toBeEditable()
          // xterm focuses its hidden IME textarea from the entire visible terminal surface.
          // Measure and exercise that hit area, as with a radio's surrounding label.
          await output.locator('.xterm').click({ position: { x: 20, y: 20 } })
          await expect(terminalInput).toBeFocused()
          await expect(terminalText).toContainText(/[$#%]\s/)
          const selectedTerminal = page.getByTestId('terminal-tab').and(page.locator('[aria-pressed="true"]'))
          const terminalId = (await selectedTerminal.getAttribute('id'))?.replace(/^terminal-tab-/, '')
          if (!terminalId) throw new Error('The visible terminal must identify its real process')
          await terminalInput.pressSequentially(
            "PS1='narrow$ '; printf '\\033[2J\\033[H'; printf 'NARROW_TERMINAL_OK\\n'",
          )
          await terminalInput.press('Enter')
          await expect
            .poll(async () =>
              stripVTControlCharacters((await session.jobsRead(terminalId)).job?.stdout ?? ''),
            )
            .toMatch(/\nNARROW_TERMINAL_OK\r?\n/)
          await expect(terminalText).toContainText('NARROW_TERMINAL_OK')
          await usable(page, info, `terminal-running-${viewport.width}`)
          if (viewport.width === 375) await capture('workbench', viewport.width)
          if (viewport.width === 768) {
            await page.locator('#workbench-right .workbench-resize').press('Shift+Tab')
            await expect
              .poll(() =>
                page.locator('#workbench-right').evaluate((host) => host.contains(document.activeElement)),
              )
              .toBe(true)
          }
          await page.getByTestId('workbench-tab-terminal').press('Escape')
          await expect(page.getByTestId('workbench-right-toggle')).toBeFocused()
          expect(
            (await session.jobsRead()).jobs
              .filter((job) => job.owner === 'human')
              .every((job) => job.status === 'running'),
          ).toBe(true)
          await settings(page, locale)
          await settings(page, locale)
          for (const id of sections) {
            await section(page, id)
            if (id === 'memory') {
              await expect(page.getByTestId('memory-panel')).toHaveAttribute('aria-busy', 'false')
              await selectValue(page, 'memory-workspace', await realpath(runtime.workspace))
              await page.getByTestId('memory-open').click()
              await expect(page.getByTestId('memory-content')).toBeVisible()
            }
            await usable(page, info, `settings-${id}-${viewport.width}`)
            if (id === 'plugins') {
              await section(page, 'review')
              await page
                .locator('li[data-candidate-id]')
                .filter({ hasText: candidate.packageId })
                .getByTestId('candidate-open')
                .click()
              await expect(page.getByTestId('candidate-approve')).toBeInViewport({ ratio: 1 })
              await expect(page.getByTestId('candidate-reject')).toBeInViewport({ ratio: 1 })
              await usable(page, info, `candidate-review-${viewport.width}`)
              if (viewport.width === 375) await capture('settings', viewport.width)
            }
            if (id === 'memory' && viewport.width === 768) await capture('settings', viewport.width)
          }
          await closeSettings(page, locale)
          await expect(page.getByTestId('settings-navigation')).toBeHidden()
          await page.keyboard.press('Escape')
          await expect(page.locator('.sidebar')).toBeHidden()
          if (viewport.width === 768) {
            await page.getByTestId('workbench-right-toggle').click()
            await expect(page.getByTestId('workbench-bottom-toggle')).toHaveCount(0)
            await expect(page.locator('#workbench-bottom')).toBeHidden()
            await expect(page.locator('#workbench-right')).toBeVisible()
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
