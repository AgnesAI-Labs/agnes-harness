import type { Page } from '@playwright/test'
import { expect } from './fixtures.js'
import { settled } from './quality.js'
import type { Runtime } from './runtime.js'

/** Select the interactive tab, whose localized label may span several lines on a phone. */
export function pluginTab(page: Page, name: 'permissions' | 'versions' | 'config' | 'details') {
  return page.getByRole('tab').filter({ has: page.getByTestId(`plugin-${name}-tab`) })
}

/** Use the visible select control, including the shared select's custom popup. */
export async function selectValue(page: Page, id: string, value: string) {
  const native = page.locator(`[id="${id}"]`).or(page.getByTestId(id))
  await expect(native).toBeAttached()
  if (await native.isVisible()) await native.selectOption(value)
  else {
    const label = await native
      .locator('option')
      .evaluateAll(
        (options, selected) =>
          options.find((option) => (option as HTMLOptionElement).value === selected)?.textContent?.trim(),
        value,
      )
    if (!label) throw new Error(`Select ${id} does not offer ${value}`)
    const controlId = await native.getAttribute('id')
    if (!controlId) throw new Error(`Custom select ${id} has no control id`)
    await page.locator(`[id="${controlId}-trigger"]`).click()
    await page.getByRole('option', { name: label, exact: true }).click()
  }
  await expect(native).toHaveValue(value)
}

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
  await sidebar(page)
  await page.getByRole('button', { name: locale === 'en' ? 'Settings' : '设置', exact: true }).click()
  // A reopened phone dialog retains its last detail page; return through its real navigation.
  await expect(page.locator('#config')).toBeVisible()
  const back = page.getByTestId('settings-back')
  if (await back.isVisible()) await back.click()
  await expect(page.getByTestId('settings-navigation')).toBeVisible()
}

/** Open a disclosure through its rendered control, including the React disclosure used by v3. */
export async function expand(root: import('@playwright/test').Locator) {
  await expect(root).toBeVisible()
  const toggle = root.locator(':scope > summary, :scope > .agh-disclosure-summary').first()
  const native = (await root.evaluate((node) => node.tagName)) === 'DETAILS'
  const open = native
    ? (await root.getAttribute('open')) !== null
    : (await root.getAttribute('data-open')) === 'true'
  if (!open) await toggle.click()
  if (native) await expect(root).toHaveAttribute('open', '')
  else await expect(toggle).toHaveAttribute('aria-expanded', 'true')
}

/** Consecutive activity steps have their own disclosure inside the turn process. */
export async function expandActivityGroups(turn: import('@playwright/test').Locator) {
  for (const group of await turn.getByTestId('turn-activity-toggle').all()) {
    if ((await group.isVisible()) && (await group.getAttribute('aria-expanded')) !== 'true') {
      await group.click()
      await expect(group).toHaveAttribute('aria-expanded', 'true')
    }
  }
}

export async function sidebar(page: Page) {
  const capability = page.getByRole('dialog').filter({
    has: page.locator('[data-testid^="home-page-plugins-"]'),
  })
  if (await capability.isVisible()) {
    await capability.getByRole('button', { name: /^(Close|关闭)$/, exact: true }).click()
    await expect(capability).toBeHidden()
  }
  if (!(await page.locator('#settings').isVisible())) await page.locator('#sidebar-toggle').click()
}

export async function homePage(page: Page, id: string, tab?: string) {
  if (await page.locator('#config').isVisible()) await dismissSettings(page)
  const dock = page.getByTestId('workbench-right-toggle')
  if ((await dock.isVisible()) && (await dock.getAttribute('aria-expanded')) === 'true')
    await dismissWorkbench(page)
  await sidebar(page)
  await page.getByTestId(`home-entry-${id}`).click()
  await expect(page.getByTestId(`home-page-${id}`)).toBeVisible()
  if (tab) {
    if (id === 'plugins')
      await page
        .getByRole('tab')
        .filter({ has: page.getByTestId(`plugins-tab-${tab}`) })
        .click()
    else
      await page
        .getByRole('tab')
        .filter({ hasText: tab === 'triggers' ? /Triggers|触发器/ : /Scheduled tasks|定时任务/ })
        .click()
  }
}

export async function advanced(page: Page) {
  if (!(await page.locator('#config').isVisible()))
    await settings(page, (await page.locator('html').getAttribute('lang')) ?? 'en')
  const back = page.getByTestId('settings-back')
  if (await back.isVisible()) await back.click()
  await page.getByTestId('settings-nav-general').click()
  const toggle = page.getByTestId('settings-advanced-switch')
  if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  if (await back.isVisible()) await back.click()
}

/** The visible owner after information architecture moves a settings destination. */
export function sectionSurface(page: Page, id: string) {
  const homes: Record<string, string> = {
    plugins: 'plugins',
    discover: 'plugins',
    skills: 'plugins',
    mcp: 'plugins',
    examples: 'agents',
    schedules: 'automation',
    triggers: 'automation',
    search: 'plugins-search',
    memory: 'plugins-memory',
    engines: 'plugins-subagents',
    'computer-use': 'plugins-computer-use',
    execution: 'plugins-execution',
  }
  if (homes[id]) return page.getByTestId(`home-page-${homes[id]}`)
  if (id === 'model') return page.locator('#config-accounts')
  if (id === 'general') return page.locator('#appearance-settings-pane')
  if (id === 'history') return page.getByTestId('session-search')
  if (id === 'archived') return page.locator('#sessions')
  if (id === 'jobs') return page.getByTestId('terminal-panel')
  const canonical = ['bundles', 'system-prompt', 'context'].includes(id)
    ? 'models'
    : id === 'providers'
      ? 'diagnostics'
      : id === 'credentials'
        ? 'security'
        : id
  return page.getByTestId(`settings-page-${canonical}`)
}

export async function section(page: Page, id: string) {
  if (await page.getByTestId('session-search').isVisible()) await page.keyboard.press('Escape')
  const dock = page.getByTestId('workbench-right-toggle')
  if (
    id !== 'jobs' &&
    !(await page.locator('#config').isVisible()) &&
    (await dock.isVisible()) &&
    (await dock.getAttribute('aria-expanded')) === 'true'
  )
    await dismissWorkbench(page)
  if (id === 'jobs' && new URL(page.url()).pathname !== '/admin/plugins') {
    await closeSettings(page, (await page.locator('html').getAttribute('lang')) ?? 'en')
    await workbenchTab(page, 'terminal')
    return
  }
  if (new URL(page.url()).pathname === '/admin/plugins') {
    const back = page.getByTestId('settings-back')
    if (await back.isVisible()) await back.click()
    const canonical = ['bundles', 'system-prompt', 'context'].includes(id)
      ? 'models'
      : id === 'providers'
        ? 'diagnostics'
        : id
    if (['models', 'diagnostics'].includes(canonical)) await expand(page.getByTestId('settings-advanced'))
    await page.getByTestId(`settings-nav-${canonical}`).click()
    if (['models', 'bundles', 'system-prompt', 'context'].includes(id))
      await expand(page.getByTestId(`settings-subsection-${id}`))
    if (id === 'providers') {
      await expand(page.getByTestId('plugin-diagnostics'))
      await expand(page.getByTestId('settings-subsection-provider-types'))
    }
    return
  }
  const moved: Record<string, [string, string?]> = {
    plugins: ['plugins'],
    discover: ['plugins', 'market'],
    examples: ['agents'],
    skills: ['plugins', 'skills'],
    mcp: ['plugins', 'mcp'],
    feedback: ['plugins', 'review'],
    review: ['plugins', 'review'],
    execution: ['plugins', 'plugins.execution'],
    search: ['plugins', 'plugins.search'],
    memory: ['plugins', 'plugins.memory'],
    engines: ['plugins', 'plugins.subagents'],
    'computer-use': ['plugins', 'plugins.computer-use'],
    schedules: ['automation', 'schedules'],
    triggers: ['automation', 'triggers'],
  }
  const target = moved[id]
  if (target) {
    const [entry, tab] = target
    await homePage(page, entry, tab?.startsWith('plugins.') ? undefined : tab)
    if (tab?.startsWith('plugins.')) {
      await page.getByTestId(`builtin-${tab.slice(8)}`).click()
      await expect(page.getByTestId(`home-page-plugins-${tab.slice(8)}`)).toBeVisible()
    }
    if (id === 'feedback')
      await page
        .getByTestId('review-view')
        .getByRole('radio', { name: /^(Feedback|反馈记录)$/ })
        .check()
    return
  }
  if (id === 'history' || id === 'archived') {
    if (await page.locator('#config').isVisible()) await dismissSettings(page)
    if (id === 'history') await page.keyboard.press('Meta+k')
    else {
      await sidebar(page)
      await page.locator('#session-filter').click()
      await page.getByTestId('session-filter-archived').click()
      await expect(page.locator('#session-filter')).toHaveAttribute('data-filter', 'archived')
    }
    return
  }
  if (!(await page.locator('#config').isVisible()))
    await settings(page, (await page.locator('html').getAttribute('lang')) ?? 'en')
  const back = page.getByTestId('settings-back')
  if (await back.isVisible()) await back.click()
  const canonical = ['bundles', 'system-prompt', 'context'].includes(id)
    ? 'models'
    : id === 'providers'
      ? 'diagnostics'
      : id === 'credentials'
        ? 'security'
        : id
  if (['models', 'diagnostics'].includes(canonical)) await advanced(page)
  await page.getByTestId(`settings-nav-${canonical}`).click()
  if (['models', 'bundles', 'system-prompt', 'context'].includes(id)) {
    const subsection = page.getByTestId(`settings-subsection-${id}`)
    await expand(subsection)
  }
  if (id === 'providers') {
    await expand(page.getByTestId('plugin-diagnostics'))
    await expand(page.getByTestId('settings-subsection-provider-types'))
  }
}

/** A narrow dock covers the header; close it through its own visible action. */
async function dismissWorkbench(page: Page) {
  const dock = page.locator('#workbench-right')
  if (await dock.isVisible()) {
    await dock.getByRole('button', { name: /^(Close this dock|关闭此停靠面板)$/ }).click()
    await expect(dock).toBeHidden()
  }
}

/** Open a dock panel through its tab or the real overflow menu when the strip folds it. */
/** The goal popover opens from the top bar's more menu; its own toggle sits hidden under it. */
export async function openGoal(page: Page) {
  await page.locator('#topbar-more').click()
  await page.getByTestId('topbar-more-goal').click()
}

export async function workbenchTab(page: Page, id: 'files' | 'terminal' | 'goal' | 'changed-files') {
  const toggle = page.getByTestId('workbench-right-toggle')
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  const tab = page.getByTestId(`workbench-tab-${id}`)
  await expect(tab).toBeAttached()
  await expect(page.locator('#workbench-right')).toBeVisible()
  await settled(page)
  // The dock commits on a frame; its ResizeObserver can fold a tab on the next layout.
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
  if (await tab.isVisible()) await tab.click()
  else {
    const zh = (await page.locator('html').getAttribute('lang')) === 'zh-CN'
    const titles = {
      files: ['Files', '文件'],
      terminal: ['Terminal', '终端'],
      goal: ['Goal', '目标'],
      'changed-files': ['Changes', '更改'],
    } as const
    await page
      .locator('#workbench-right .workbench-dock-heading')
      .getByRole('button', { name: zh ? '更多' : 'More', exact: true })
      .click()
    await page.getByRole('menuitem', { name: titles[id][zh ? 1 : 0], exact: true }).click()
  }
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}

async function dismissSettings(page: Page) {
  const close = page.locator('#config-close')
  if (!(await close.isVisible())) await page.getByTestId('settings-back').click()
  await close.click()
  await expect(page.locator('#config')).toBeHidden()
}

export async function closeSettings(page: Page, _locale = 'en') {
  if (await page.getByTestId('session-search').isVisible()) {
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('session-search')).toBeHidden()
  }
  if (await page.locator('#config').isVisible()) await dismissSettings(page)
  if (await page.locator('#home-page').isVisible()) {
    await sidebar(page)
    const id = new URL(page.url()).searchParams.get('session')
    if (id) {
      if ((await page.locator('#session-filter').getAttribute('data-filter')) === 'archived') {
        await page.locator('#session-filter').click()
        await page.getByTestId('session-filter-active').click()
      }
      await page.locator(`.session[data-session="${id}"]`).click()
    } else await page.locator('#new').click()
    await expect(page.locator('#home-page')).toBeHidden()
  }
}

export async function chooseWorkspace(page: Page, runtime: Pick<Runtime, 'workspace'>, locale = 'en') {
  const skip = page.getByTestId('first-run-skip')
  const workspace = page.getByRole('dialog', {
    name: locale === 'en' ? 'Choose a workspace' : '选择工作区',
    exact: true,
  })
  await expect.poll(async () => (await skip.isVisible()) || (await workspace.isVisible())).toBe(true)
  if (await skip.isVisible()) await skip.click()
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
  const permission = page.locator('#composer-permission')
  await expect(permission).toBeEnabled()
  await permission.click()
  const option = page.getByRole('option', { name: locale === 'en' ? /^Full access\b/ : /^完全访问/ })
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
  await expect(permission).toContainText(locale === 'en' ? 'Full access' : '完全访问')
  await expect(page.locator('#permission-picker-popover')).toBeHidden()
  await page
    .getByRole('textbox', { name: locale === 'en' ? 'Task content' : '任务内容', exact: true })
    .click()
  await expect(
    page.getByRole('option', { name: locale === 'en' ? /^Full access\b/ : /^完全访问/ }),
  ).toBeHidden()
  await expect(permission).toHaveAttribute('aria-expanded', 'false')
}

export async function send(page: Page, input: string) {
  const turns = page.getByTestId('conversation-turn')
  const before = await turns.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-turn-id')))
  const locale = await page.locator('html').getAttribute('lang')
  const composer = page.getByRole('textbox', {
    name: locale === 'zh-CN' ? '任务内容' : 'Task content',
    exact: true,
  })
  await expect(composer).toBeEnabled()
  await composer.fill(input)
  await composer.press('Enter')
  // Child receipts can add a system turn while the prompt is being submitted. Follow
  // the new user input, rather than treating the next turn count as its identity.
  const submitted = turns.filter({
    has: page.locator('.turn-user [data-node-kind="user"]').filter({ hasText: input.trim() }),
  })
  const ids = () =>
    submitted.evaluateAll(
      (nodes, previous) =>
        nodes.map((node) => node.getAttribute('data-turn-id')).filter((id) => id && !previous.includes(id)),
      before,
    )
  await expect.poll(ids).toHaveLength(1)
  const [id] = await ids()
  if (!id) throw new Error('New conversation turn is missing its identity')
  const submittedTurn = turns.and(page.locator(`[data-turn-id=${JSON.stringify(id)}]`))
  await expect(submittedTurn.locator('[data-node-kind="user"]')).toContainText(input.trim())
  return submittedTurn
}

export async function turn(page: Page, input: string) {
  const current = await send(page, input)
  await expect(current).toHaveAttribute('data-status', 'completed', { timeout: 25_000 })
  const locale = await page.locator('html').getAttribute('lang')
  await expect(
    page.getByRole('button', { name: locale === 'zh-CN' ? '取消当前轮' : 'Cancel turn', exact: true }),
  ).toHaveCount(0)
  return current
}
