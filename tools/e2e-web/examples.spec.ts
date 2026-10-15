import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { advanced, chooseWorkspace, closeSettings } from './ui.js'

// Explicit mutation opt-in: only point this flow at a disposable real daemon home.
for (const [locale, example, loop] of [
  ['zh-CN', 'dag-loop', 'example.dag'],
  ['en', 'react-loop', 'example.react'],
] as const) {
  test(`review, trust and enable an official example (${locale})`, async ({ page }) => {
    test.skip(process.env.AGH_INSTALL_EXAMPLES !== '1', 'Set AGH_INSTALL_EXAMPLES=1 for an isolated home.')
    test.setTimeout(90_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.addInitScript((locale: string) => localStorage.setItem('agnes-locale', locale), locale)
    await page.goto('/?page=plugins&tab=market')
    const card = page
      .getByTestId('market-card')
      .and(page.locator(`[data-plugin-id="@agnes-example/${example}"]`))
    const button = card.getByTestId('market-install')
    await expect(button).toBeVisible()
    const folder = process.env.AGH_UI_REPORT && join(process.env.AGH_UI_REPORT, 'flow', locale)
    if (folder) await mkdir(folder, { recursive: true })
    async function screen(name: string) {
      if (folder) await page.screenshot({ path: join(folder, `${name}.png`) })
    }
    await button.click()
    // The check runs on the card, then its review opens as a page, never a dialog.
    const review = page.getByTestId('install-review')
    await expect(review).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(review.getByTestId('install-review-confirm')).toHaveText(
      locale === 'en' ? 'Install and enable' : '安装并启用',
    )
    await screen('official-capability-review')
    const other = locale === 'en' ? 'zh-CN' : 'en'
    await page.evaluate((value: string) => {
      document.documentElement.lang = value
      window.dispatchEvent(new CustomEvent('agnes:locale-changed', { detail: value }))
    }, other)
    await expect(
      review.getByRole('heading', { name: other === 'en' ? 'What it gets' : '它会获得什么', exact: true }),
    ).toBeVisible()
    await page.evaluate((value: string) => {
      document.documentElement.lang = value
      window.dispatchEvent(new CustomEvent('agnes:locale-changed', { detail: value }))
    }, locale)
    await screen('official-trust-enable')
    await review.getByTestId('install-review-confirm').click()
    await expect(review).toBeHidden({ timeout: 30_000 })
    // Back on the marketplace: the card says it is installed, and nothing opened by itself.
    await expect(card).toContainText(locale === 'en' ? 'Installed' : '已安装', { timeout: 30_000 })
    await expect(page.locator('#plugin-detail')).toBeHidden()
    // An enabled execution mode is offered to every new session, in the composer's agent menu.
    await page.getByRole('button', { name: locale === 'en' ? 'New session' : '新会话', exact: true }).click()
    const workspace = process.env.AGH_UI_WORKSPACE
    if (!workspace) throw new Error('Official-example flow requires an isolated workspace')
    await chooseWorkspace(page, { workspace }, locale)
    await expect(page.locator('#prompt')).toBeEnabled()
    await advanced(page)
    await closeSettings(page, locale)
    await expect(page.getByTestId('composer-agent')).toBeVisible()
    await page.getByTestId('composer-agent').click()
    await expect(page.getByTestId('agent-options')).toContainText(loop)
    await screen('official-new-session')
  })
}
