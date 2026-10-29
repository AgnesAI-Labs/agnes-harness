import { expect, test } from './fixtures.js'
import { accessible, translated } from './quality.js'
import {
  advanced,
  chooseView,
  chooseWorkspace,
  closeSettings,
  expand,
  fresh,
  homePage,
  preferences,
  section,
  settings,
  sidebar,
  turn,
} from './ui.js'

test('v3 home entries, deep links and browser back/forward retain the selected page', async ({
  page,
  runtime,
}) => {
  await preferences(page)
  await page.goto(runtime.url)
  await chooseWorkspace(page, runtime)
  for (const id of ['agents', 'plugins', 'automation']) {
    await homePage(page, id)
    expect(new URL(page.url()).searchParams.get('page')).toBe(id)
  }
  await page.goBack()
  await expect(page.getByTestId('home-page-plugins')).toBeVisible()
  await page.goBack()
  await expect(page.getByTestId('home-page-agents')).toBeVisible()
  await page.goForward()
  await expect(page.getByTestId('home-page-plugins')).toBeVisible()
  await page.goto(`${runtime.url}/?page=automation&tab=triggers`)
  await expect(page.getByTestId('home-page-automation')).toBeVisible()
  // The automation page intentionally exposes schedules only, including legacy trigger links.
  await expect(page.getByRole('tab', { name: 'Triggers', exact: true })).toHaveCount(0)
  await expect(page.getByTestId('schedules-new')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('tab', { name: 'Triggers', exact: true })).toHaveCount(0)
  await expect(page.getByTestId('schedules-new')).toBeVisible()
})

test('v3 command-K searches durable session text and opens the matching session', async ({
  page,
  runtime,
}) => {
  await preferences(page)
  await page.goto(runtime.url)
  await chooseWorkspace(page, runtime)
  await fresh(page)
  await turn(page, 'REG5_SEARCH_NEEDLE')
  const id = new URL(page.url()).searchParams.get('session')!
  await fresh(page)
  await page.keyboard.press('Meta+k')
  const search = page.getByTestId('session-search')
  await expect(search).toBeVisible()
  await search.getByTestId('session-search-input').fill('REG5_SEARCH_NEEDLE')
  const hit = search.getByTestId('session-search-option').filter({ hasText: 'REG5_SEARCH_NEEDLE' })
  await expect(hit).toHaveCount(1)
  await search.getByTestId('session-search-filters').click()
  const workspace = search.getByTestId('session-search-workspace')
  await workspace.fill(runtime.workspace.split('/').at(-2)!.toUpperCase())
  await expect(hit).toHaveCount(1)
  await workspace.fill('%missing_')
  await expect(search.getByTestId('session-search-option')).toHaveCount(0)
  await expect(search.getByText('Search is temporarily unavailable', { exact: false })).toHaveCount(0)
  await workspace.fill(runtime.workspace)
  await expect(hit).toHaveCount(1)
  await hit.click()
  await expect(search).toBeHidden()
  await expect.poll(() => new URL(page.url()).searchParams.get('session')).toBe(id)
  await expect(page.getByTestId('conversation-turn')).toContainText('REG5_SEARCH_NEEDLE')
})

test('v3 archive filter restores the same session and its conversation', async ({ page, runtime }) => {
  await preferences(page, 'zh-CN')
  await page.goto(runtime.url)
  await chooseWorkspace(page, runtime, 'zh-CN')
  await fresh(page, 'zh-CN')
  const input = page.getByRole('textbox', { name: '任务内容', exact: true })
  await input.fill('REG5_ARCHIVE_CONTENT')
  await input.press('Enter')
  await expect(page.getByTestId('conversation-turn')).toHaveAttribute('data-status', 'completed')
  const id = new URL(page.url()).searchParams.get('session')!
  await page.locator(`.session[data-session="${id}"]`).hover()
  await page.locator(`[data-session-action-id="${id}"]`).click()
  await page.getByRole('menuitem', { name: '归档会话', exact: true }).click()
  const client = await runtime.connect()
  await expect
    .poll(async () => (await client.session.list()).items.find((row) => row.sessionId === id)?.archived)
    .toBe(true)
  await chooseView(page, 'archived')
  // The row's open button carries the session id; the restore action sits beside it in the same row.
  const row = page
    .getByTestId('session-inventory')
    .locator('.session-row')
    .filter({ has: page.locator(`[data-session="${id}"]`) })
  await expect(row).toBeVisible()
  // The restore action appears when the row is pointed at.
  await row.hover()
  await row.getByTestId('archived-restore').click()
  await expect
    .poll(async () => (await client.session.list()).items.find((row) => row.sessionId === id)?.archived)
    .toBe(false)
  await chooseView(page, 'active')
  await page.locator(`.session[data-session="${id}"]`).click()
  await expect(page.getByTestId('conversation-turn')).toContainText('REG5_ARCHIVE_CONTENT')
})

test('v3 settings exposes four everyday pages, persistent advanced settings and legacy plugin redirects', async ({
  page,
  runtime,
}) => {
  await preferences(page, 'zh-CN')
  await page.goto(runtime.url)
  await chooseWorkspace(page, runtime, 'zh-CN')
  await fresh(page, 'zh-CN')
  await turn(page, 'Keep the settings navigation session across reloads')
  await settings(page, 'zh-CN')
  // A browser that never chose shows the advanced group; turning it off is remembered.
  expect(await page.evaluate(() => localStorage.getItem('agnes.settings.advanced'))).toBeNull()
  await expect(page.getByTestId('settings-advanced')).toBeVisible()
  await section(page, 'general')
  await page.getByTestId('settings-advanced-switch').click()
  await expect(page.getByTestId('settings-advanced-switch')).toHaveAttribute('aria-checked', 'false')
  expect(await page.evaluate(() => localStorage.getItem('agnes.settings.advanced'))).toBe('0')
  await page.reload()
  // A persisted settings URL restores its dialog after the session binding finishes.
  await expect(page.locator('#config[open]')).toBeVisible()
  await settings(page, 'zh-CN')
  await expect(page.getByTestId('settings-navigation').locator('[data-settings-section]')).toHaveCount(4)
  await expect(page.getByTestId('settings-advanced')).toHaveCount(0)
  for (const id of ['general', 'model', 'security', 'application']) await section(page, id)
  await expect(page.getByTestId('auto-review-customize')).toHaveCount(0)
  await advanced(page)
  await expect(page.getByTestId('settings-advanced')).toBeVisible()
  await section(page, 'security')
  await expand(page.getByTestId('auto-review-customize'))
  await expect(page.getByTestId('auto-review-tools')).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('agnes.settings.advanced'))).toBe('1')
  const subpage = page.url()
  expect(new URL(subpage).searchParams.get('settings')).toBe('security/auto-review')
  await page.goBack()
  await expect(page.getByTestId('auto-review-tools')).toBeHidden()
  expect(new URL(page.url()).searchParams.get('settings')).toBe('security')
  await page.goForward()
  await expect(page.getByTestId('auto-review-tools')).toBeVisible()
  await page.reload()
  await expect(page.getByTestId('auto-review-tools')).toBeVisible()
  expect(page.url()).toBe(subpage)
  await page.goto(subpage)
  await expect(page.getByTestId('auto-review-tools')).toBeVisible()
  await page.reload()
  await expect(page.getByTestId('auto-review-tools')).toBeVisible()
  await settings(page, 'zh-CN')
  await expect(page.getByTestId('settings-advanced')).toBeVisible()
  await closeSettings(page, 'zh-CN')
  await page.goto(`${runtime.url}/?settings=plugins`)
  await expect(page.getByTestId('home-page-plugins')).toBeVisible()
  expect(new URL(page.url()).searchParams.get('settings')).toBeNull()
  expect(new URL(page.url()).searchParams.get('page')).toBe('plugins')
  await page.goto(`${runtime.url}/?settings=model/add-account`)
  await expect(page.getByTestId('account-page-add')).toBeVisible()
  await page.locator('#config-account-cancel').click()
  await expect(page.locator('#config-account-discard')).toBeVisible()
  await page.locator('#config-account-discard-confirm').click()
  await expect.poll(() => new URL(page.url()).searchParams.get('settings')).toBe('model')
  await expect(page.getByTestId('account-page-add')).toHaveCount(0)
  await page.reload()
  await expect(page.locator('#model-settings-pane')).toBeVisible()
  await expect(page.getByTestId('account-page-add')).toHaveCount(0)
  await page.locator('.config-accounts-welcome [data-provider="deepseek"]').click()
  await expect(page.getByTestId('account-page-add')).toBeVisible()
  await page.goBack()
  await expect.poll(() => new URL(page.url()).searchParams.get('settings')).toBe('model')
  await expect(page.getByTestId('account-page-add')).toHaveCount(0)
})

for (const locale of ['en', 'zh-CN'])
  for (const theme of ['light', 'dark']) {
    test(`v3 every home page and capability locale/theme and 390px smoke ${locale}/${theme}`, async ({
      page,
      runtime,
    }, info) => {
      test.setTimeout(150_000)
      await preferences(page, locale, theme)
      await page.goto(runtime.url)
      await chooseWorkspace(page, runtime, locale)
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 })
        for (const id of ['agents', 'plugins', 'automation']) {
          await homePage(page, id)
          await translated(page)
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
            `${id}/${width}`,
          ).toBe(true)
          await accessible(page, info, `${id}-${width}`)
        }
        for (const tab of ['skills', 'mcp', 'review', 'market']) {
          await homePage(page, 'plugins', tab)
          await translated(page)
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
            `${tab}/${width}`,
          ).toBe(true)
          await accessible(page, info, `${tab}-${width}`)
        }
        for (const capability of ['search', 'computer-use', 'subagents']) {
          await homePage(page, 'plugins')
          const label = {
            search: /^(Web search|网页搜索)/,
            'computer-use': /^(Computer use|电脑操作)/,
            subagents: /^(Subagents|子代理)/,
          }[capability]!
          await page.getByTestId('plugin-capability-settings').getByRole('button', { name: label }).click()
          await expect(page.getByTestId(`home-page-plugins-${capability}`)).toBeVisible()
          await translated(page)
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
            `${capability}/${width}`,
          ).toBe(true)
          await accessible(page, info, `${capability}-${width}`)
        }
        await sidebar(page)
        await settings(page, locale)
        for (const id of ['general', 'model', 'security', 'application']) {
          await section(page, id)
          await translated(page)
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
            `${id}/${width}`,
          ).toBe(true)
          await accessible(page, info, `${id}-${width}`)
        }
        await closeSettings(page, locale)
      }
    })
  }

test('browser locale initializes the shell and a saved choice wins after reload', async ({
  browser,
  runtime,
}, info) => {
  for (const locale of ['zh-CN', 'fr-FR']) {
    const context = await browser.newContext({ locale })
    const page = await context.newPage()
    try {
      await page.goto(runtime.url)
      await expect(page.locator('html')).toHaveAttribute('lang', locale === 'zh-CN' ? 'zh-CN' : 'en')
      expect(await page.evaluate(() => navigator.language)).toBe(locale)
      expect(await page.evaluate(() => localStorage.getItem('agnes-locale'))).toBeNull()
      if (locale === 'zh-CN') {
        await expect(page.locator('#new')).toContainText('新对话')
        await info.attach('browser-zh-CN.png', { body: await page.screenshot(), contentType: 'image/png' })
        await info.attach('browser-locale.json', {
          body: JSON.stringify(
            await page.evaluate(() => ({
              browser: navigator.language,
              document: document.documentElement.lang,
              saved: localStorage.getItem('agnes-locale'),
            })),
          ),
          contentType: 'application/json',
        })
        await page.evaluate(() => localStorage.setItem('agnes-locale', 'en'))
        await page.reload()
        await expect(page.locator('html')).toHaveAttribute('lang', 'en')
      }
    } finally {
      await context.close()
    }
  }
})
