import { mkdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
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
    // Teaching Loops are installed deliberately from their source; the marketplace advertises the
    // showcase applications only.
    await page.goto('/?page=plugins')
    await page.getByTestId('plugin-install-source').click()
    await page.locator('#source-type').selectOption('file')
    await page.locator('#source-ref').fill(`file:${resolve('examples/loops', example).split(sep).join('/')}`)
    const folder = process.env.AGH_UI_REPORT && join(process.env.AGH_UI_REPORT, 'flow', locale)
    if (folder) await mkdir(folder, { recursive: true })
    async function screen(name: string) {
      if (folder) await page.screenshot({ path: join(folder, `${name}.png`) })
    }
    await page.locator('#source-form .dialog-actions button:not(#source-cancel)').click()
    // The checked source opens its review as a page, never a dialog.
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
    // Back on the plugin list: the package is listed as installed, and nothing opened by itself.
    await expect(page.locator(`.plugin-row[data-plugin-id="@agnes-example/${example}"]`)).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.locator('#plugin-detail')).toBeHidden()
    // Activation finishes after the review closes; a draft started later offers the new Loop.
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const response = await fetch('/admin/api/loops', {
              credentials: 'same-origin',
              cache: 'no-store',
            })
            return ((await response.json()) as { loops: { id: string }[] }).loops.map((entry) => entry.id)
          }),
        { timeout: 30_000 },
      )
      .toContain(loop)
    // An enabled execution mode is offered to every new session, in the composer's agent menu.
    await page
      .getByRole('button', { name: locale === 'en' ? 'New conversation' : '新对话', exact: true })
      .click()
    const workspace = process.env.AGH_UI_WORKSPACE
    if (!workspace) throw new Error('Official-example flow requires an isolated workspace')
    await chooseWorkspace(page, { workspace }, locale)
    await expect(page.locator('#prompt')).toBeEnabled()
    await advanced(page)
    await closeSettings(page, locale)
    await expect(page.getByTestId('composer-agent')).toBeVisible()
    await page.getByTestId('composer-agent').click()
    // With a second Loop the running mode is a choice: the new Loop is one of its options.
    await page.getByTestId('agent-options').getByTestId('new-session-loop').click()
    await expect(page.locator('.ant-select-item-option').filter({ hasText: loop })).toBeVisible()
    await screen('official-new-session')
  })
}
