import { expect, test } from './fixtures.js'
import { accessible, screen, translated } from './quality.js'
import { chooseWorkspace, closeSettings, fresh, preferences, section, settings } from './ui.js'

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
        await input.fill(text)
        await input.press('Enter')
        await expect(turns).toHaveCount(before + 1, { timeout: 25_000 })
        await expect(turns.last()).toHaveAttribute('data-status', 'completed', { timeout: 25_000 })
      }
      async function request() {
        await page.locator('#view-trace').click()
        await page.locator('.trace-type-filter').selectOption('assistant')
        await page.locator('.trace-row').last().click()
        await expect(page.getByTestId('request-trace')).toBeVisible()
        await expect(page.getByTestId('request-trace-capture')).toBeVisible()
        await expect(page.getByTestId('request-trace-tab-system')).toHaveText(
          locale === 'en' ? 'System prompt' : '系统提示词',
        )
      }
      await send('Synthetic original persona request')
      const oldUrl = page.url()
      await request()
      await page.getByTestId('request-trace-baseline').click()
      await page.locator('#view-chat').click()
      await settings(page, locale)
      await section(page, 'system-prompt')
      await expect(page.getByTestId('system-prompt-editor')).toHaveAttribute('aria-busy', 'false')
      await expect(page.getByTestId('system-prompt-session-preview')).toBeVisible()
      await page
        .getByTestId('system-prompt-personaPrefix')
        .fill('Synthetic delivery persona: answer with clear next steps.')
      await page.getByTestId('system-prompt-save').click()
      await expect(page.getByTestId('system-prompt-saved')).toBeVisible()
      await translated(page)
      await accessible(page, info, 'system-prompt')
      await page.getByTestId('system-prompt-editor').evaluate((element) => {
        for (let parent = element.parentElement; parent; parent = parent.parentElement) parent.scrollTop = 0
      })
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
        page.getByTestId('request-trace-source').filter({ hasText: 'profile:system-prompt' }),
      ).toBeVisible()
      await page.getByTestId('request-trace-diff').check()
      await expect(page.getByTestId('request-trace-diff-content').locator('ins')).toContainText(
        'Synthetic delivery persona',
      )
      await page.getByTestId('request-trace-diff').uncheck()
      for (const pane of ['tools', 'messages', 'params', 'tokens', 'raw', 'system']) {
        await page.getByTestId(`request-trace-tab-${pane}`).click()
        await expect(page.getByTestId('request-trace-content')).toBeVisible()
      }
      await page.getByTestId('trace-view-chat').click()
      await expect(page.getByTestId('conversation-turn')).toBeVisible()
      await page.getByTestId('turn-view-trace').last().click()
      await expect(page.getByTestId('request-trace')).toBeVisible()
      await page.locator('#trace-timeline-mode').selectOption('sequence')
      await translated(page)
      await accessible(page, info, 'request-trace')
      await page
        .getByTestId('request-trace-source')
        .filter({ hasText: 'profile:system-prompt' })
        .scrollIntoViewIfNeeded()
      // Runtime elapsed time changes both text and toolbar geometry; keep a synthetic visual value.
      const elapsed = page.locator('.trace-stats .trace-stat').first()
      const originalElapsed = await elapsed.textContent()
      await elapsed.evaluate((element) => {
        element.textContent = (element.textContent ?? '').replace(/\d.*$/, '1.0s')
      })
      try {
        await screen(page, info, `request-trace-${locale}-${theme}`, [
          page.locator('.trace-stat'),
          page.locator('.trace-inspector-pane'),
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
      await page.getByTestId('request-trace-tab-raw').click()
      await expect(page.getByTestId('request-trace-content')).toContainText(
        locale === 'en' ? 'Final provider body unavailable' : '最终发送正文不可用',
      )
      await expect(page.getByTestId('request-trace-copy')).toBeDisabled()
      await page.getByTestId('request-trace-capture').locator('summary').click()
      await page.getByTestId('request-trace-delete-confirm').check()
      await page.getByTestId('request-trace-delete').click()
      await expect(page.getByTestId('request-trace')).toContainText(
        locale === 'en' ? 'This request was not retained.' : '此请求已不在保留范围内。',
      )
    })
