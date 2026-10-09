import type { Page } from '@playwright/test'
import { expect } from './fixtures.js'
import type { Runtime } from './runtime.js'

export async function preferences(page: Page, locale = 'en', theme = 'light') {
  await page.addInitScript(
    ({ locale, theme }) => {
      if (location.protocol !== 'http:') return
      localStorage.setItem('agnes-locale', locale)
      localStorage.setItem('agnes-theme', theme)
    },
    { locale, theme },
  )
}

export async function settings(page: Page, locale = 'en') {
  await page.getByRole('button', { name: locale === 'en' ? 'Settings' : '设置', exact: true }).click()
  await expect(page.getByTestId('settings-navigation')).toBeVisible()
}

export async function section(page: Page, id: string) {
  const first: Record<string, string> = {
    bundles: 'models',
    engines: 'models',
    'system-prompt': 'models',
    memory: 'models',
    discover: 'plugins',
    providers: 'plugins',
    examples: 'plugins',
    context: 'search',
    terminal: 'jobs',
    schedules: 'jobs',
    triggers: 'jobs',
    archived: 'history',
    feedback: 'history',
  }
  await page.getByTestId(`settings-nav-${first[id] ?? id}`).click()
  const tab = page.getByTestId(`settings-nav-${id}-tab`)
  if (await tab.count()) await tab.click()
}

export async function closeSettings(page: Page, locale = 'en') {
  await page
    .getByRole('button', { name: locale === 'en' ? 'Close settings' : '关闭设置', exact: true })
    .click()
  await expect(page.getByTestId('settings-navigation')).toBeHidden()
}

export async function chooseWorkspace(page: Page, runtime: Runtime, locale = 'en') {
  const skip = page.getByTestId('first-run-skip')
  await expect
    .poll(async () => (await skip.isVisible()) || (await page.locator('#new-session[open]').isVisible()))
    .toBe(true)
  if (await skip.isVisible()) await skip.click()
  const workspace = page.getByRole('dialog', {
    name: locale === 'en' ? 'Choose a workspace' : '选择工作区',
    exact: true,
  })
  await expect(workspace).toBeVisible()
  await workspace.getByTestId('workspace-manual-toggle').click()
  await workspace.getByRole('textbox').fill(runtime.workspace)
  await workspace
    .getByRole('button', {
      name: locale === 'en' ? 'Use this workspace' : '使用此工作区',
      exact: true,
    })
    .click()
  await expect(workspace).toBeHidden()
  const names = page.locator('.workspace-heading .workspace-name')
  await expect(names.filter({ hasText: /^w$/ })).toHaveCount(1)
  expect((await names.allTextContents()).every((name) => name.trim().length > 0)).toBe(true)
}

export async function fresh(page: Page, locale = 'en') {
  await page.getByRole('button', { name: locale === 'en' ? 'New session' : '新会话', exact: true }).click()
  await fullAccess(page, locale)
}

export async function fullAccess(page: Page, locale = 'en') {
  await expect(page.getByTestId('composer-agent')).toBeEnabled()
  await page.getByTestId('composer-agent').click()
  const permission = page.getByTestId('new-session-preset')
  await permission.click()
  const option = page.getByRole('option', { name: locale === 'en' ? /^Full access\b/ : /^完全权限/ })
  await expect(option).toBeVisible()
  // Playwright visibility includes opacity-zero menus. Finish the finite entry motion before
  // hit-testing an option whose popup is still translating; no sleep or action retry is needed.
  await option.evaluate(async (element) => {
    const motions: Animation[] = []
    for (let node: Element | null = element; node; node = node.parentElement)
      for (const motion of node.getAnimations())
        if (motion.playState === 'running' && motion.effect?.getComputedTiming().endTime !== Infinity)
          motions.push(motion)
    await Promise.all(motions.map((motion) => motion.finished.catch(() => undefined)))
  })
  await option.click()
  await expect(permission).toContainText(locale === 'en' ? 'Full access' : '完全权限')
  await page
    .getByRole('textbox', { name: locale === 'en' ? 'Task content' : '任务内容', exact: true })
    .click()
  await expect(
    page.getByRole('option', { name: locale === 'en' ? /^Full access\b/ : /^完全权限/ }),
  ).toBeHidden()
  await expect(page.getByTestId('composer-agent')).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('agent-options')).toBeHidden()
}

export async function send(page: Page, input: string) {
  const turns = page.getByTestId('conversation-turn')
  const before = await turns.count()
  const composer = page.getByRole('textbox', { name: 'Task content', exact: true })
  await expect(composer).toBeEnabled()
  await composer.fill(input)
  await composer.press('Enter')
  await expect(turns).toHaveCount(before + 1)
  return turns.last()
}

export async function turn(page: Page, input: string) {
  const current = await send(page, input)
  await expect(current).toHaveAttribute('data-status', 'completed', { timeout: 25_000 })
  await expect(page.getByRole('button', { name: 'Cancel turn', exact: true })).toHaveCount(0)
  return current
}
