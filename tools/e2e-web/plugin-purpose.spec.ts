import { expect, test } from './fixtures.js'
import { install } from './sdk.js'
import { chooseWorkspace, preferences, section, settings } from './ui.js'

for (const locale of ['en', 'zh-CN'] as const) {
  test(`plugin purpose, category, registered settings and details (${locale})`, async ({ page, runtime }) => {
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
    await expect(row.getByTestId('plugin-provides')).toHaveCount(0)
    await expect(row.locator('.agh-tag')).toHaveCount(0)
    await page.getByRole('button', { name: locale === 'en' ? 'Filter' : '筛选', exact: true }).click()
    const category = page.getByTestId('plugin-category-filter')
    await category.selectOption('tools')
    await expect(row).toHaveCount(0)
    await category.selectOption('collaboration')
    await expect(row).toHaveCount(1)
    await page.getByRole('button', { name: locale === 'en' ? 'Filter' : '筛选', exact: true }).click()
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
    await page.getByTestId('plugin-permissions-tab').click()
    await expect(page.getByTestId('plugin-permissions-detail')).toBeVisible()
    await page.getByTestId('plugin-versions-tab').click()
    await expect(page.getByTestId('plugin-versions-detail')).toBeVisible()
    await page.getByTestId('plugin-config-tab').click()
    await expect(page.getByTestId('plugin-settings-detail')).toBeVisible()
    await expect(page.getByTestId('plugin-config-field/name')).toHaveValue('Support')
    await page.getByTestId('plugin-config-field/name').fill('Unsaved purpose draft')
    await page.getByTestId('plugin-details-tab').click()
    await page.getByTestId('plugin-config-tab').click()
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
    const list = page.locator('#resource-list')
    await expect(
      list.getByRole('tab', { name: locale === 'en' ? 'My skills' : '我的技能', exact: true }),
    ).toBeVisible()
    await list.getByRole('tab', { name: locale === 'en' ? 'Pending review' : '待审阅', exact: true }).click()
    await expect(list.getByTestId('plugin-candidates')).toBeVisible()
    await list.getByRole('tab', { name: locale === 'en' ? 'Feedback' : '反馈', exact: true }).click()
    await expect(list.getByTestId('feedback-admin')).toBeVisible()
    await list.getByRole('tab', { name: locale === 'en' ? 'My skills' : '我的技能', exact: true }).click()
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
