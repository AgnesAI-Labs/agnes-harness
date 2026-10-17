import { expect, test } from './fixtures.js'
import { install } from './sdk.js'
import { chooseWorkspace, pluginTab, preferences, section, settings } from './ui.js'

for (const locale of ['en', 'zh-CN'] as const) {
  test(`plugin purpose, provides, registered settings and details (${locale})`, async ({ page, runtime }) => {
    const client = await runtime.connect()
    const pkg = await install(client, 'tools/e2e-web/fixtures/plugin-config')
    await preferences(page, locale)
    await page.goto(runtime.url)
    await chooseWorkspace(page, runtime, locale)
    await settings(page, locale)
    await section(page, 'plugins')
    const row = page.locator(`.plugin-row[data-plugin-id="${pkg.id}"]`)
    await expect(row.getByTestId('plugin-summary')).toHaveText(
      locale === 'en' ? 'Coordinates sample work queues for a team.' : '协调团队的样例任务队列。',
    )
    await expect(row.getByTestId('plugin-provides')).toHaveText(
      locale === 'en' ? 'Includes: Service' : '包含：服务',
    )
    const source = row.getByTestId('plugin-source-badge')
    await expect(source).toHaveAttribute('data-origin', 'local-source')
    await expect(source).toHaveText(locale === 'en' ? 'Local' : '本地')
    await expect(row.locator('.agh-tag')).toHaveCount(1)
    await page.getByTestId('plugin-add-more').click()
    await expect(page.getByTestId('plugin-install-source')).toBeVisible()
    await expect(page.getByTestId('plugin-creator')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByTestId('plugin-filter').click()
    const capability = page.getByRole('combobox', {
      name: locale === 'en' ? 'Filter by capability' : '按能力筛选',
      exact: true,
    })
    await capability.click()
    await page.getByRole('option', { name: locale === 'en' ? 'Tool' : '工具', exact: true }).click()
    await expect(row).toHaveCount(0)
    await capability.click()
    await page.getByRole('option', { name: locale === 'en' ? 'Service' : '服务', exact: true }).click()
    await expect(row).toHaveCount(1)
    await page.getByTestId('plugin-filter').click()
    const search = page.locator('#plugin-search')
    await search.fill(locale === 'en' ? 'sample work queues' : '样例任务队列')
    await expect(row).toHaveCount(1)
    await search.fill(locale === 'en' ? 'Settings' : '设置')
    await expect(row).toHaveCount(1)
    await search.fill('no-such-purpose')
    await expect(row).toHaveCount(0)
    await search.fill('')
    await page.setViewportSize({ width: 390, height: 844 })
    await row.locator('.plugin-details-button').focus()
    await page.keyboard.press('Enter')
    const detail = page.getByTestId('plugin-purpose-detail')
    await expect(detail).toBeVisible()
    await expect(detail.getByTestId('plugin-overview')).toContainText(
      locale === 'en' ? 'Demonstrates configurable work queues' : '演示可配置的任务队列',
    )
    for (const name of ['provides', 'appears'])
      await expect(detail.getByTestId(`plugin-${name}-detail`)).toBeVisible()
    await expect(detail.getByTestId('plugin-appears-detail')).toContainText(
      locale === 'en' ? 'Settings' : '设置页',
    )
    await pluginTab(page, 'permissions').click()
    await expect(page.getByTestId('plugin-permissions-detail')).toBeVisible()
    await pluginTab(page, 'versions').click()
    await expect(page.getByTestId('plugin-versions-detail')).toBeVisible()
    await pluginTab(page, 'config').click()
    await expect(page.getByTestId('plugin-settings-detail')).toBeVisible()
    await expect(page.getByTestId('plugin-config-field/name')).toHaveValue('Support')
    await page.getByTestId('plugin-config-field/name').fill('Unsaved purpose draft')
    // Overview is clipped after scrolling the phone tab strip; keyboard focus reveals it.
    await pluginTab(page, 'details').focus()
    await pluginTab(page, 'details').press('Enter')
    await pluginTab(page, 'config').click()
    await expect(page.getByTestId('plugin-config-field/name')).toHaveValue('Unsaved purpose draft')
  })
}

for (const locale of ['en', 'zh-CN'] as const) {
  test(`skills teach creation and expose review tabs (${locale})`, async ({ page, runtime }) => {
    await preferences(page, locale)
    await page.goto(runtime.url)
    await chooseWorkspace(page, runtime, locale)
    await settings(page, locale)
    await section(page, 'skills')
    const list = page.locator('.plugins-page-resources .plugin-list')
    await expect(page.getByTestId('skill-new')).toBeVisible()
    await page.getByTestId('plugins-tab-review').click()
    await expect(page.getByTestId('plugin-candidates')).toBeVisible()
    await page
      .getByTestId('review-view')
      .getByRole('radio', { name: locale === 'en' ? 'Feedback' : '反馈记录', exact: true })
      .check()
    await expect(page.getByTestId('feedback-admin')).toBeVisible()
    await page.getByTestId('plugins-tab-skills').click()
    await list.locator('#skill-search').fill('no-such-skill')
    await expect(
      list.getByRole('heading', {
        name: locale === 'en' ? 'No matching skills' : '没有匹配的技能',
        exact: true,
      }),
    ).toBeVisible()
    await expect(list).not.toContainText('AGNES_SKILLS_IMPORT_USER')
    await list.locator('#skill-search').fill('')
    await list.getByTestId('skill-locations').click()
    await expect(page.locator('.agnes-ui-popover')).toBeVisible()
  })
}
