import assert from 'node:assert/strict'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

/** Uses real adopted application/BFF/services; no DOM or backend interception. */
export async function captureBrowser(rt) {
  const browser = await chromium.launch({ headless: true })
  const evidence = { screenshots: [], errors: [], requestsFailed: [] }
  let page, context
  async function capture(label, target = 'home', locale = 'zh-CN', theme = 'light') {
    await context?.close()
    context = await browser.newContext({
      viewport: { width: 1600, height: 1100 },
      locale,
      colorScheme: theme,
    })
    page = await context.newPage()
    page.on('pageerror', (e) => evidence.errors.push(e.message))
    page.on('requestfailed', (r) => {
      if (!r.failure()?.errorText.includes('ERR_ABORTED'))
        evidence.requestsFailed.push({ url: r.url(), error: r.failure()?.errorText })
    })
    await page.addInitScript(
      ({ locale, theme }) => {
        localStorage.setItem('agnes-locale', locale)
        localStorage.setItem('agnes-theme', theme)
      },
      { locale, theme },
    )
    await page.goto(
      `${rt.url}/?page=pharma-${target}&pagePackage=${encodeURIComponent('@agnes-showcase/pharma-gmp')}`,
    )
    await page.locator(`[data-pharma-page="${target}"]`).waitFor({ timeout: 30000 })
    await page.locator('.ph-context').filter({ hasText: /36/ }).waitFor({ timeout: 30000 })
    await page.locator('.ph-app .ph-card').first().waitFor()
    if (target === 'em') await page.locator('.ph-app figure svg').first().waitFor({ timeout: 30000 })
    await page.evaluate(() => document.fonts.ready)
    const path = join(rt.root, `${label}-${target}-${locale}-${theme}.png`)
    await page.screenshot({ path, fullPage: true })
    evidence.screenshots.push(path)
    assert.equal(await page.locator('html').getAttribute('lang'), locale)
    assert.equal(await page.locator('html').evaluate((e) => e.classList.contains('dark')), theme === 'dark')
    if (target === 'release' && label === 'initial')
      assert.ok(
        await page
          .getByRole('button', {
            name: locale === 'en' ? 'Request human approval and sign release' : '请求人工批准并签署放行',
            exact: true,
          })
          .isDisabled(),
      )
    return page
  }
  try {
    for (const locale of ['zh-CN', 'en'])
      for (const theme of ['light', 'dark'])
        for (const target of ['home', 'batches', 'deviations', 'em', 'release', 'audit'])
          await capture('initial', target, locale, theme)
    const detail = await capture('detail', 'home')
    await detail.getByRole('button', { name: 'B-2410-017', exact: true }).click()
    await detail.getByRole('dialog').waitFor()
    const path = join(rt.root, 'batch-detail-zh-light.png')
    await detail.screenshot({ path, fullPage: true })
    evidence.screenshots.push(path)
    assert.equal(evidence.errors.length, 0, JSON.stringify(evidence.errors))
  } catch (e) {
    if (page) {
      const path = join(rt.root, 'browser-failure.png')
      await page.screenshot({ path, fullPage: true }).catch(() => {})
      evidence.screenshots.push(path)
      evidence.body = await page.locator('body').innerText()
    }
    await rt.save('browser.json', evidence)
    await browser.close()
    throw e
  }
  return {
    evidence,
    capture,
    async captureApproval(sessionId) {
      await page.goto(`${rt.url}/?session=${encodeURIComponent(sessionId)}`)
      await page.locator('[data-testid="approval-card"]').waitFor({ timeout: 30000 })
      const path = join(rt.root, 'human-signature-approval-zh-light.png')
      await page.screenshot({ path, fullPage: true })
      evidence.screenshots.push(path)
    },
    async close() {
      await rt.save('browser.json', evidence)
      await browser.close()
      assert.deepEqual(evidence.errors, [])
    },
  }
}
