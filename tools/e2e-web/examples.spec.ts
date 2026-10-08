import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const packagePath = process.env.AGH_PLAYWRIGHT_PACKAGE
if (!packagePath) throw new Error('Run through the web smoke runner')
const { test, expect } = require(join(packagePath, 'test.js'))
// Explicit mutation opt-in: only point this flow at a disposable real daemon home.
for (const [locale, example, loop] of [
  ['zh-CN', 'dag-loop', 'example.dag'],
  ['en', 'react-loop', 'example.react'],
]) {
  test(`review, trust and enable an official example (${locale})`, async ({ page }) => {
    test.skip(process.env.AGH_INSTALL_EXAMPLES !== '1', 'Set AGH_INSTALL_EXAMPLES=1 for an isolated home.')
    test.setTimeout(90_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.addInitScript((locale: string) => localStorage.setItem('agnes-locale', locale), locale)
    await page.goto('/?settings=examples')
    const button = page.getByTestId(`example-install-${example}`)
    await expect(button).toBeVisible()
    const folder = process.env.AGH_UI_REPORT && join(process.env.AGH_UI_REPORT, 'flow', locale)
    if (folder) await mkdir(folder, { recursive: true })
    async function screen(name: string) {
      if (folder) await page.screenshot({ path: join(folder, `${name}.png`) })
    }
    if (!(await button.isDisabled())) {
      await button.click()
      await expect(page.locator('#plugin-confirm[open]')).toBeVisible()
      if (
        (await page.locator('#plugin-confirm-action').textContent()) ===
        (locale === 'en' ? 'Confirm installation' : '确认安装')
      ) {
        await screen('official-capability-review')
        const other = locale === 'en' ? 'zh-CN' : 'en'
        await page.evaluate((value: string) => {
          document.documentElement.lang = value
          window.dispatchEvent(new Event('agnes:locale-changed'))
        }, other)
        await expect(page.locator('#plugin-confirm h3').first()).toHaveText(
          other === 'en' ? 'Requested capabilities' : '请求的能力',
        )
        await page.evaluate((value: string) => {
          document.documentElement.lang = value
          window.dispatchEvent(new Event('agnes:locale-changed'))
        }, locale)

        await page.locator('#plugin-confirm-action').click()
        await expect(page.locator('#plugin-confirm-action')).toHaveText(
          locale === 'en' ? 'Confirm enable' : '确认启用',
          { timeout: 30_000 },
        )
      }
      await screen('official-trust-enable')
      await page.locator('#plugin-confirm-action').click()
    }
    const start = page.getByTestId(`example-start-${example}`)
    await expect(start).toBeVisible({ timeout: 30_000 })
    await start.scrollIntoViewIfNeeded()
    await screen('official-available')
    await start.click()
    await expect(page.getByTestId('composer-agent')).toBeVisible()
    await page.waitForTimeout(1000)
    if (await page.locator('#new-session[open]').count()) {
      const workspace = process.env.AGH_UI_WORKSPACE
      if (!workspace) throw new Error('Set AGH_UI_WORKSPACE for the isolated home')
      await page.locator('#workspace-manual').evaluate((element: HTMLDetailsElement) => {
        element.open = true
      })
      await page.locator('#new-session-cwd').fill(workspace)
      await page.locator('#new-session-create').click()
    }
    await page.getByTestId('composer-agent').click()
    await expect(page.getByTestId('agent-options')).toContainText(loop)
    await screen('official-new-session')
  })
}
