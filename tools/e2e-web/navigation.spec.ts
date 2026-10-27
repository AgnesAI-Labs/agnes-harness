import { expect, test } from '@playwright/test'
import { expand, section, sectionSurface } from './ui.js'

// Explicit Playwright tier. Run against an isolated demo home after all streams are integrated.
for (const locale of ['en', 'zh-CN']) {
  test(`runtime navigation (${locale})`, async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.addInitScript((value) => localStorage.setItem('agnes-locale', value), locale)
    await page.goto('/admin/plugins')
    await expect(page.getByTestId('home-page-plugins')).toBeVisible()
    await expect(page).toHaveURL(/page=plugins/)
    for (const id of ['plugins', 'discover', 'providers', 'models', 'bundles', 'security']) {
      await section(page, id)
      await expect(sectionSurface(page, id)).toBeVisible()
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
    await page.getByTestId('plugin-add-more').click()
    await expect(page.getByTestId('plugin-creator')).toBeVisible()
    await page.keyboard.press('Escape')
    await section(page, 'diagnostics')
    await expand(page.getByTestId('plugin-diagnostics'))
    // The technical details subpage folds publication and generations into their own sections.
    await expand(page.getByTestId('runtime-publication'))
    await expect(page.getByTestId('composition-publication')).toBeVisible()
    await expand(page.getByTestId('runtime-generations'))
    await expand(page.getByTestId('plugin-generations'))
    await expand(page.getByTestId('migration-manual'))
    await expect(page.getByTestId('migration-session-key')).toBeVisible()
    await expect(page.getByTestId('migrate-session')).toBeVisible()
    await expand(page.getByTestId('runtime-local'))
    await page.getByTestId('local-plugins').locator('summary, .agh-disclosure-summary').click()
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
      await page.getByTestId('security-details-toggle').click()
      const scrollRegion = policyTable.locator('..')
      await scrollRegion.focus()
      await scrollRegion.press('ArrowRight')
      await expect.poll(() => scrollRegion.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
    }
    await page.goto('/?page=plugins&tab=plugins.search')
    await expect(page.getByTestId('search-providers')).toBeVisible()
    await page.goto('/?page=agents')
    await expect(page.getByTestId('home-page-agents')).toBeVisible()
    // One feed: the catalog's applications and standalone agents beside the general assistant.
    await expect(
      page.getByTestId('agents-gallery').locator('[data-application], [data-agent-ref]').first(),
    ).toBeVisible()
    expect(pageErrors).toEqual([])
  })
}
test('confirms migration of an isolated fixture session', async ({ page }) => {
  const sessionId = process.env.AGH_MIGRATION_SESSION
  test.skip(!sessionId, 'Set AGH_MIGRATION_SESSION to a closed session in an isolated test home.')
  if (!sessionId) return
  // Keep the fixture closed: automatic selection would reopen the latest session.
  await page.goto('/admin/plugins?session=missing-migration-fixture')
  await section(page, 'diagnostics')
  await expand(page.getByTestId('plugin-diagnostics'))
  await expand(page.getByTestId('runtime-generations'))
  await expand(page.getByTestId('plugin-generations'))
  await expand(page.getByTestId('migration-manual'))
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

test('settings navigation, narrow master-detail and old links keep their destinations', async ({ page }) => {
  test.setTimeout(150_000)
  await page.goto('/?settings=model')
  await expect(page.locator('#config')).toBeVisible()
  // General, Models, Permissions and Application.
  const everyday = page.locator('#settings-everyday button[data-settings-group]')
  await expect(everyday).toHaveCount(4)
  // Advanced settings show until the reader turns them off.
  await expect(page.getByTestId('settings-advanced')).toBeVisible()
  await section(page, 'general')
  await page.getByTestId('settings-advanced-switch').click()
  await expect(page.getByTestId('settings-advanced')).toHaveCount(0)
  await page.getByTestId('settings-advanced-switch').click()
  await expect(page.getByTestId('settings-advanced')).toBeVisible()
  await section(page, 'model')
  await page.setViewportSize({ width: 375, height: 812 })
  await expect(page.getByTestId('settings-navigation')).toBeHidden()
  await page.getByTestId('settings-back').click()
  await expect(page.getByTestId('settings-navigation')).toBeVisible()
  await expect(page.locator('#settings-content-slots')).toBeHidden()
  await page.getByTestId('settings-nav-general').click()
  await expect(page.getByTestId('settings-back')).toBeFocused()
  await page.getByTestId('settings-back').click()
  await expect(page.getByTestId('settings-nav-general')).toBeFocused()
  // Provider kinds now live in the diagnostics technical-details subpage.
  for (const [old, target, anchor] of [
    ['context', 'models', '#settings-subsection-context'],
    ['providers', 'diagnostics', '[data-testid="settings-subsection-provider-types"]'],
  ] as const) {
    await page.goto(`/?settings=${old}`)
    await expect(page.getByTestId(`settings-page-${target}`)).toBeVisible()
    await expect(page.locator(anchor)).toBeVisible()
    // The address now names the current settings route instead of the old link, so a reload returns
    // to the same page.
    const route = new URL(page.url()).searchParams.get('settings')
    expect(route).not.toBeNull()
    expect(route).not.toBe(old)
    expect(new URL(page.url()).hash).toBe('')
    await page.reload()
    await expect(page.getByTestId(`settings-page-${target}`)).toBeVisible()
  }
  // Memory is part of 个性化 on the General page, which the advanced switch does not hide.
  await page.goto('/?settings=memory')
  await expect(page.locator('#settings-subsection-memory')).toBeVisible()
  expect(new URL(page.url()).searchParams.get('settings')).not.toBe('memory')
  for (const [old, target, tab, surface] of [
    // Capability pages open as subpages of the Plugins tab, which the address names.
    ['engines', 'plugins', 'plugins', 'plugins-subagents'],
    ['search', 'plugins', 'plugins', 'plugins-search'],
    ['skills', 'plugins', 'skills', 'plugins'],
    ['mcp', 'plugins', 'mcp', 'plugins'],
    ['examples', 'agents', null, 'agents'],
  ] as const) {
    await page.goto(`/?settings=${old}`)
    await expect(page.getByTestId(`home-page-${surface}`)).toBeVisible()
    expect(new URL(page.url()).searchParams.get('settings')).toBeNull()
    expect(new URL(page.url()).searchParams.get('page')).toBe(target)
    expect(new URL(page.url()).searchParams.get('tab')).toBe(tab)
    await page.reload()
    await expect(page.getByTestId(`home-page-${surface}`)).toBeVisible()
  }
  await page.goto('/?settings=terminal')
  await expect(page.locator('#config')).toBeHidden()
  await expect(page).not.toHaveURL(/settings=terminal/)
  // This server has a fixture session; let startup select it before checking its destination.
  await expect(page.getByTestId('workbench-tab-terminal')).toHaveAttribute('aria-selected', 'true')
  await expect(page).toHaveURL(/session=/)
  await expect(page.locator('.agh-toast')).toContainText('The terminal has moved to the session workbench.')
  // An unavailable explicit session prevents selection of sessions from other specs.
  await page.goto('/?session=missing-terminal-fixture&settings=terminal')
  await expect(page.locator('#config')).toBeHidden()
  await expect(page.getByTestId('workbench-tab-terminal')).toHaveCount(0)
  await expect(page.locator('.agh-toast')).toContainText('Open a session to use the terminal.')
  await expect(page).not.toHaveURL(/settings=terminal/)
})
