import { expect, test } from './fixtures.js'
import { accessible, screen, translated } from './quality.js'
import { chooseWorkspace, closeSettings, expand, fresh, preferences, section, settings } from './ui.js'

for (const locale of ['en', 'zh-CN'])
  for (const theme of ['light', 'dark'])
    test(`pinned persona and real request comparison ${locale}/${theme}`, async ({ page, runtime }, info) => {
      test.setTimeout(120_000)
      await preferences(page, locale, theme)
      await page.goto(runtime.url)
      await chooseWorkspace(page, runtime, locale)
      await fresh(page, locale)
      async function send(text: string) {
        const input = page.getByRole('textbox', {
          name: locale === 'en' ? 'Task content' : '任务内容',
          exact: true,
        })
        const turns = page.getByTestId('conversation-turn')
        const before = await turns.count()
        await expect(page.locator('#composer')).toHaveAttribute('data-busy', 'false')
        await input.fill(text)
        await expect(page.locator('#send')).toBeEnabled()
        await input.press('Enter')
        await expect(turns).toHaveCount(before + 1, { timeout: 25_000 })
        await expect(turns.last()).toHaveAttribute('data-status', 'completed', { timeout: 25_000 })
      }
      async function request() {
        await expect(page.locator('#prompt')).toBeEditable()
        const trace = page.locator('#view-trace')
        // Reload may briefly expose the previous view before session state is restored.
        // Always make an explicit selection so this request does not trust that transient state.
        await trace.click()
        await expect(trace).toHaveAttribute('aria-selected', 'true')
        const chip = page.locator('.trace-chip[data-kind=assistant]')
        if ((await chip.getAttribute('aria-pressed')) !== 'true') await chip.click()
        await page.locator('.trace-row').last().click()
        await page.locator('.trace-tab[data-pane=request]').click()
        await expect(page.getByTestId('request-trace-section-system')).toContainText(
          locale === 'en' ? 'System prompt' : '系统提示词',
        )
      }
      await send('Synthetic original persona request')
      const oldUrl = page.url()
      await request()
      async function more(en: string, zh: string) {
        await page.getByTestId('trace-inspector-more').click()
        await page.getByRole('menuitem', { name: locale === 'en' ? en : zh, exact: true }).click()
      }
      await more('Use this request as comparison', '将此请求设为对比基准')
      await page.locator('#view-chat').click()
      // The custom instructions are on the General page of settings.
      await settings(page, locale)
      await section(page, 'general')
      await page
        .getByTestId('system-prompt-personaPrefix')
        .fill('Synthetic delivery persona: answer with clear next steps.')
      await page.getByTestId('system-prompt-personaPrefix').press('Tab')
      const client = await runtime.connect()
      await expect
        .poll(async () => (await client.systemPrompt.get()).config.personaPrefix)
        .toBe('Synthetic delivery persona: answer with clear next steps.')
      await settings(page, locale)
      await section(page, 'models')
      await expand(page.getByTestId('settings-drill-prompt-preview'))
      const previewModes = page.getByTestId('system-prompt-preview-view')
      await previewModes.locator('input[value="session"]').check()
      await expect(page.getByTestId('system-prompt-session-preview')).toBeVisible()
      for (const section of await page.getByTestId('system-prompt-section').all()) await expand(section)
      await expect(page.getByTestId('system-prompt-preview')).not.toContainText('Synthetic delivery persona')
      await previewModes.locator('input[value="defaults"]').check()
      for (const section of await page.getByTestId('system-prompt-section').all()) await expand(section)
      await expect(page.getByTestId('system-prompt-preview')).toContainText('Synthetic delivery persona')
      await translated(page)
      await accessible(page, info, 'system-prompt')
      await page.getByTestId('system-prompt-preview').scrollIntoViewIfNeeded()
      await expect(page.getByTestId('system-prompt-preview')).toBeInViewport()
      await page.mouse.move(0, 0)
      await screen(page, info, `system-prompt-${locale}-${theme}`)
      await closeSettings(page, locale)
      await send('Same original session after changing profile settings')
      await request()
      await expect(page.getByTestId('request-trace-content')).not.toContainText('Synthetic delivery persona')
      await page.locator('#view-chat').click()
      await fresh(page, locale)
      await send('Synthetic new persona request')
      await request()
      await expect(page.getByTestId('request-trace-content')).toContainText('Synthetic delivery persona')
      await expect(
        page
          .getByTestId('request-trace-source')
          .filter({ hasText: locale === 'en' ? 'Your custom persona' : '你的自定义角色' }),
      ).toBeVisible()
      await more('Compare with pinned baseline', '与固定基准对比')
      await expect(
        page
          .getByTestId('request-trace-section-system')
          .getByTestId('request-trace-diff-content')
          .locator('ins'),
      ).toContainText('Synthetic delivery persona')
      await more('Stop comparing', '停止对比')
      for (const section of ['tools', 'messages', 'params']) {
        await expand(page.getByTestId(`request-trace-section-${section}`))
        await expect(page.getByTestId(`request-trace-section-${section}`)).toBeVisible()
      }
      await page
        .getByTestId('request-trace-mode')
        .getByRole('radio', { name: locale === 'en' ? 'Sent JSON' : '实际发送 JSON', exact: true })
        .check()
      await expect(page.getByTestId('request-trace-content')).toContainText(
        locale === 'en' ? 'Final provider body unavailable' : '最终发送正文不可用',
      )
      await page.locator('.trace-tab[data-pane=usage]').click()
      await expect(page.getByTestId('request-trace-summary')).toContainText('demo')
      await page.locator('.trace-tab[data-pane=request]').click()
      await page.getByTestId('trace-view-chat').click()
      await expect(page.getByTestId('conversation-turn')).toBeVisible()
      await page.locator('#view-trace').click()
      await expect(page.getByTestId('request-trace')).toBeVisible()
      await page.getByTestId('trace-toolbar-more').click()
      await page.getByTestId('trace-timeline-sequence').click()
      await translated(page)
      await accessible(page, info, 'request-trace')
      await page.locator('.trace-tab[data-pane=usage]').click()
      await expect(page.getByTestId('request-trace-summary')).toContainText('demo')
      const tabs = await page.locator('.trace-inspector-tabs').getByRole('tab').all()
      const boxes = await Promise.all(tabs.map((tab) => tab.boundingBox()))
      expect(new Set(boxes.map((box) => Math.round(box!.y))).size).toBe(1)
      if (locale === 'zh-CN') await expect(page.locator('.trace-inspector-head')).not.toContainText('Step 1')
      // Keep request controls and the real unavailable-body explanation visible in this frame.
      await page.locator('.trace-tab[data-pane=request]').click()
      await expect(page.locator('.trace-tab[data-pane=request]')).toHaveAttribute('aria-selected', 'true')
      await page
        .getByTestId('request-trace-mode')
        .getByRole('radio', { name: locale === 'en' ? 'Sent JSON' : '实际发送 JSON', exact: true })
        .check()
      await expect(page.getByTestId('request-trace-content')).toContainText(
        locale === 'en' ? 'Final provider body unavailable' : '最终发送正文不可用',
      )
      await page.locator('.trace-inspector-body').evaluate((body) => {
        body.scrollTop = 0
      })
      // Runtime elapsed time changes both text and toolbar geometry; keep a synthetic visual value.
      const elapsed = page.locator('.trace-stats .trace-stat').first()
      const originalElapsed = await elapsed.textContent()
      await elapsed.evaluate((element) => {
        element.textContent = (element.textContent ?? '').replace(/\d.*$/, '1.0s')
      })
      try {
        await screen(page, info, `request-trace-${locale}-${theme}`, [
          page.locator('.trace-stat'),
          page.locator('.request-trace-summary time'),
        ])
      } finally {
        await elapsed.evaluate((element, original) => {
          element.textContent = original
        }, originalElapsed)
      }
      const currentUrl = page.url()
      expect(currentUrl).not.toBe(oldUrl)
      await page.goto(oldUrl)
      await expect(page.getByTestId('conversation-turn')).toHaveCount(2)
      await request()
      await expect(page.getByTestId('request-trace-content')).not.toContainText('Synthetic delivery persona')
      await page
        .getByTestId('request-trace-mode')
        .getByRole('radio', { name: locale === 'en' ? 'Sent JSON' : '实际发送 JSON', exact: true })
        .check()
      await expect(page.getByTestId('request-trace-content')).toContainText(
        locale === 'en' ? 'Final provider body unavailable' : '最终发送正文不可用',
      )
      await expect(page.getByTestId('request-trace-copy')).toBeDisabled()
      await page.locator('.trace-tab[data-pane=source]').click()
      await expand(page.getByTestId('request-trace-capture'))
      await page.getByTestId('request-trace-delete-confirm').check()
      await page.getByTestId('request-trace-delete').click()
      await page.locator('.trace-tab[data-pane=request]').click()
      await expect(page.locator('.trace-inspector')).toContainText(
        locale === 'en' ? 'This request was not retained.' : '此请求已不在保留范围内。',
      )
    })
