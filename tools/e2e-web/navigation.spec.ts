import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const playwrightPackage = process.env.AGH_PLAYWRIGHT_PACKAGE
if (!playwrightPackage) throw new Error('Run this spec through pnpm test:web-smoke')
const { test, expect } = require(join(playwrightPackage, 'test.js'))

// Explicit Playwright tier. Run against an isolated demo home after all streams are integrated.
for (const locale of ['en', 'zh-CN']) {
  test(`runtime navigation (${locale})`, async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.addInitScript((value) => localStorage.setItem('agnes-locale', value), locale)
    await page.goto('/admin/plugins')
    await expect(page.getByTestId('settings-navigation')).toBeVisible()
    for (const id of ['plugins', 'providers', 'models', 'bundles', 'security', 'resources', 'examples']) {
      await page.getByTestId(`settings-nav-${id}`).click()
      await expect(page.getByTestId(`settings-page-${id}`)).toBeVisible()
      await expect(page.getByTestId(`settings-nav-${id}`)).toHaveAttribute('aria-current', 'page')
    }
    await page.getByTestId('settings-nav-providers').click()
    await expect(page.getByTestId('providers-loop')).toBeVisible()
    for (const kind of [
      'model-adapter',
      'compaction',
      'persistence',
      'sandbox',
      'tool-runtime',
      'tool-policy',
      'child-agent',
    ])
      await expect(page.getByTestId(`providers-${kind}`)).toBeVisible()
    await page.getByTestId('settings-nav-plugins').click()
    await expect(page.getByTestId('plugin-creator')).toBeVisible()
    await expect(page.getByTestId('composition-publication')).toBeVisible()
    await page.getByTestId('plugin-generations').locator('summary').click()
    await expect(page.getByTestId('migration-session-key')).toBeVisible()
    await expect(page.getByTestId('migrate-session')).toBeVisible()
    await page.getByTestId('local-plugins').locator('summary').click()
    await expect(page.getByTestId('reload-local-plugins')).toBeVisible()
    expect(pageErrors).toEqual([])
  })
}
// End-of-round acceptance extends this with trusted fixture install/update/rollback, defaults,
// bundle/preset creation, real workspace sandbox probes, MCP/Skills mutations and session turns.
// Conversation questions, plans, deliverables, jobs and children are supplied by their owning streams.
