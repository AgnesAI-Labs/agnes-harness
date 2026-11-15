/**
 * The panel in a real browser, served the way the AGH page serves it: its own stylesheet must load under the page's
 * CSP and lay the views out, and the controls must be the AGH ones. The happy-dom tests check behaviour only and never
 * saw that the panel rendered as unstyled HTML when its stylesheet was an inline <style> the CSP refused.
 */
import { expect, type Page, test } from '@playwright/test'
import { openPanel, panelBundle, type Scenario } from './helpers/browser.js'

const feishuSettings: Scenario = {
  route: { page: 'settings', query: { group: 'source', source: 'feishu' } },
  language: 'zh-CN',
}
const box = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((node) => {
      const style = getComputedStyle(node)
      const rect = node.getBoundingClientRect()
      return {
        tag: node.tagName,
        display: style.display,
        maxWidth: style.maxWidth,
        borderWidth: style.borderTopWidth,
        borderRadius: Number.parseFloat(style.borderTopLeftRadius),
        background: style.backgroundColor,
        width: rect.width,
        height: rect.height,
        left: rect.left,
        top: rect.top,
      }
    })

test.beforeAll(async () => {
  test.setTimeout(120_000)
  await panelBundle()
})

for (const theme of ['light', 'dark'] as const)
  test(`the panel stylesheet loads under the page CSP and lays out the settings (${theme})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const opened = await openPanel(page, feishuSettings, { theme })
    await expect(page.locator('#dt-source-feishu')).toBeVisible()
    expect(opened.violations).toEqual([])
    // The page column, the outlined source card and the settings side list come from the panel's stylesheet.
    expect((await box(page, '.dt-page')).maxWidth).toBe('960px')
    const card = await box(page, '#dt-source-feishu')
    expect(card.borderWidth).toBe('1px')
    expect(card.borderRadius).toBeGreaterThanOrEqual(12)
    expect(card.background).not.toBe('rgba(0, 0, 0, 0)')
    expect((await box(page, '.dt-settings')).display).toBe('grid')
    // One row of page tabs: the settings groups are a side list, not a second row of tabs.
    const first = await box(page, '.dt-settings-link >> nth=0')
    const second = await box(page, '.dt-settings-link >> nth=1')
    expect(second.left).toBe(first.left)
    expect(second.top).toBeGreaterThan(first.top)
    expect(await page.locator('.dt-settings-picker').isVisible()).toBe(false)
    // The switch is the AGH switch: a small pill track with its handle, not an empty square box.
    const toggle = await box(page, '#dt-source-feishu [role="switch"]')
    expect(toggle.height).toBeLessThanOrEqual(24)
    expect(toggle.width).toBeGreaterThan(toggle.height)
    expect(toggle.borderRadius).toBeGreaterThanOrEqual(toggle.height / 2 - 1)
    const handle = await box(page, '#dt-source-feishu [role="switch"] .ant-switch-handle')
    expect(handle.width).toBeGreaterThan(0)
    // The help affordance is a quiet icon, not a bordered button.
    const help = await box(page, '#dt-source-feishu .dt-info')
    expect(help.tag).not.toBe('BUTTON')
    expect(help.borderWidth).toBe('0px')
    expect(help.width).toBeLessThanOrEqual(20)
  })

test('a narrow panel replaces the settings side list with one picker', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 900 })
  const opened = await openPanel(page, feishuSettings)
  await expect(page.locator('#dt-source-feishu')).toBeVisible()
  expect(opened.violations).toEqual([])
  await expect(page.locator('.dt-settings-nav')).toBeHidden()
  await expect(page.locator('.dt-settings-picker')).toBeVisible()
  // Nothing spills past the right edge of the page.
  const overflow = await page.evaluate(() => {
    const host = document.getElementById('home-page-host')
    return host ? host.scrollWidth - host.clientWidth : Number.NaN
  })
  expect(overflow).toBeLessThanOrEqual(0)
})

test('the offline state is the AGH empty state', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const opened = await openPanel(page, { route: { page: 'overview' }, language: 'zh-CN', offline: true })
  const empty = page.locator('.dt-empty.agh-empty-state')
  await expect(empty).toBeVisible()
  expect(opened.violations).toEqual([])
  expect((await box(page, '.dt-empty .agh-empty-state-icon')).width).toBeGreaterThan(0)
  expect((await box(page, '.dt-page')).maxWidth).toBe('960px')
})
