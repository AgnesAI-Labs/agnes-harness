import { expect, test } from '@playwright/test'
import { section } from './ui.js'

// Explicit Playwright tier. Run against an isolated demo home after all streams are integrated.
for (const locale of ['en', 'zh-CN']) {
  test(`runtime navigation (${locale})`, async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.addInitScript((value) => localStorage.setItem('agnes-locale', value), locale)
    await page.goto('/admin/plugins')
    await expect(page.getByTestId('settings-navigation')).toBeVisible()
    for (const id of ['plugins', 'providers', 'search', 'models', 'bundles', 'security', 'examples']) {
      await section(page, id)
      const canonical = ['models', 'bundles'].includes(id)
        ? 'models'
        : id === 'providers'
          ? 'diagnostics'
          : id === 'examples'
            ? 'discover'
            : id
      await expect(page.getByTestId(`settings-page-${canonical}`)).toBeVisible()
      if (id === 'search') await expect(page.getByTestId('search-providers')).toBeVisible()
    }
    await section(page, 'providers')
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
    await section(page, 'plugins')
    await expect(page.getByTestId('plugin-creator')).toBeVisible()
    await section(page, 'diagnostics')
    await page.getByTestId('plugin-diagnostics').locator('summary').first().click()
    await expect(page.getByTestId('composition-publication')).toBeVisible()
    await page.getByTestId('plugin-generations').locator('summary').click()
    await expect(page.getByTestId('migration-session-key')).toBeVisible()
    await expect(page.getByTestId('migrate-session')).toBeVisible()
    await page.getByTestId('local-plugins').locator('summary').click()
    await expect(page.getByTestId('reload-local-plugins')).toBeVisible()
    await section(page, 'security')
    await expect(
      page.getByTestId('sandbox-security-status').or(page.getByTestId('sandbox-status-unavailable')),
    ).toBeVisible()
    await page.setViewportSize({ width: 375, height: 812 })
    await expect(page.getByTestId('settings-navigation')).toBeHidden()
    await page.getByTestId('settings-back').click()
    await expect(page.getByTestId('settings-nav-security')).toBeVisible()
    await expect(page.getByTestId('settings-nav-security')).toBeFocused()
    await section(page, 'security')
    await expect(page.getByTestId('settings-back')).toBeFocused()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(
      true,
    )
    const policyTable = page.getByTestId('permission-preset-status')
    if (await policyTable.count()) {
      const scrollRegion = policyTable.locator('..')
      await scrollRegion.focus()
      await scrollRegion.press('ArrowRight')
      await expect.poll(() => scrollRegion.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
    }
    expect(pageErrors).toEqual([])
  })
}
test('confirms migration of an isolated fixture session', async ({ page }) => {
  const sessionId = process.env.AGH_MIGRATION_SESSION
  test.skip(!sessionId, 'Set AGH_MIGRATION_SESSION to a closed session in an isolated test home.')
  if (!sessionId) return
  await page.goto('/admin/plugins')
  await section(page, 'diagnostics')
  await page.getByTestId('plugin-diagnostics').locator('summary').first().click()
  await page.getByTestId('plugin-generations').locator('summary').click()
  await page.getByTestId('migration-session-key').fill(sessionId)
  await page.getByTestId('migrate-session').click()
  await expect(page.getByTestId('confirm-session-migration')).toBeVisible()
  await page.getByTestId('confirm-session-migration').click()
  await expect(page.getByTestId('session-migration-result')).toBeVisible()
  await expect(page.getByTestId('session-migration-result').locator('code')).toHaveCount(2)
})
// End-of-round acceptance extends this with trusted fixture install/update/rollback, defaults,
// bundle/preset creation, real workspace sandbox probes, MCP/Skills mutations and session turns.
// Conversation questions, plans, deliverables, jobs and children are supplied by their owning streams.

test('settings search, narrow master-detail and old links keep their destinations', async ({ page }) => {
  test.setTimeout(150_000)
  await page.goto('/?settings=model')
  await expect(page.locator('#config')).toBeVisible()
  const everyday = page.locator('#settings-everyday button[data-settings-group]')
  await expect(everyday).toHaveCount(8)
  await expect(page.getByTestId('settings-advanced')).not.toHaveAttribute('open')
  await page.locator('#config-title').click()
  await page.keyboard.press('/')
  await expect(page.getByTestId('settings-search')).toBeFocused()
  await page.getByTestId('settings-search').fill('memory')
  await expect(page.getByTestId('settings-nav-models')).toBeVisible()
  await expect(page.getByTestId('settings-nav-model')).toBeHidden()
  await page.getByTestId('settings-search').fill('nothing-matches-this-query')
  await expect(page.locator('#settings-search-empty')).toBeVisible()
  await page.getByTestId('settings-search').fill('')
  await expect(page.getByTestId('settings-advanced')).not.toHaveAttribute('open')
  await page.setViewportSize({ width: 375, height: 812 })
  await expect(page.getByTestId('settings-navigation')).toBeHidden()
  await page.getByTestId('settings-back').click()
  await expect(page.getByTestId('settings-navigation')).toBeVisible()
  await expect(page.locator('#settings-content-slots')).toBeHidden()
  await page.getByTestId('settings-nav-mcp').click()
  await expect(page.getByTestId('settings-back')).toBeFocused()
  await page.getByTestId('settings-nav-mcp-tab').press('ArrowRight')
  await expect(page.getByTestId('settings-nav-search-tab')).toBeFocused()
  await expect(page.getByTestId('settings-page-search')).toBeVisible()
  await page.getByTestId('settings-back').click()
  await expect(page.getByTestId('settings-nav-mcp')).toBeFocused()
  for (const [old, target] of [
    ['memory', 'models'],
    ['context', 'models'],
    ['providers', 'diagnostics'],
    ['examples', 'discover'],
  ]) {
    await page.goto(`/?settings=${old}`)
    await expect(page.getByTestId(`settings-page-${target}`)).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`[?&]settings=${target}#settings-subsection-${old}$`))
    await expect(page.locator(`#settings-subsection-${old}`)).toBeVisible()
    if (old === 'memory' || old === 'context')
      await expect(page.locator(`#settings-subsection-${old}`)).toHaveAttribute('open')
  }
  await page.goto('/?settings=terminal')
  await expect(page.locator('#config')).toBeHidden()
  await expect(page.getByTestId('workbench-tab-terminal')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.agh-toast')).toContainText('terminal')
  await expect(page).not.toHaveURL(/settings=terminal/)
})
