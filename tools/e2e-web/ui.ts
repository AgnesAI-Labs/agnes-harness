import { realpath } from 'node:fs/promises'
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
      if (location.protocol !== 'http:' || window !== window.top) return
      localStorage.setItem('agnes-locale', locale)
      localStorage.setItem('agnes-theme', theme)
    },
    { locale, theme },
  )
}

async function settingsVisible(page: Page) {
  return (
    (await page.locator('#config[open]').isVisible()) ||
    (await page.locator('#config-form').isVisible()) ||
    (await page.getByTestId('settings-navigation').isVisible()) ||
    (await page.getByTestId('settings-back').isVisible()) ||
    (await page.locator('[data-testid="settings-subpage-header"]:visible').count()) > 0
  )
}

async function settingsRoot(page: Page) {
  // Nested SettingsDrill content is portaled outside the hidden root form.
  const subpage = page.locator('[data-testid="settings-subpage-header"]:visible')
  // A real open dialog can precede its lazy navigation or deep-linked drill content.
  await expect
    .poll(
      async () =>
        (await page.getByTestId('settings-navigation').isVisible()) ||
        (await page.getByTestId('settings-back').isVisible()) ||
        (await subpage.count()) > 0,
    )
    .toBe(true)
  if (await subpage.count()) {
    await subpage.getByRole('button').first().click()
    await expect(subpage).toHaveCount(0)
  }
  const back = page.getByTestId('settings-back')
  if (await back.isVisible()) await back.click()
  await expect(page.getByTestId('settings-navigation')).toBeVisible()
}

export async function settings(page: Page, locale = 'en') {
  if (!(await settingsVisible(page))) {
    await sidebar(page)
    await page.getByRole('button', { name: locale === 'en' ? 'Settings' : '设置', exact: true }).click()
  }
  await expect.poll(() => settingsVisible(page)).toBe(true)
  await settingsRoot(page)
}

/** Open a disclosure through its rendered control, including the React disclosure used by v3. */
export async function expand(root: import('@playwright/test').Locator) {
  await expect(root).toBeVisible()
  if (await root.evaluate((node) => node.matches('button[data-settings-drill]'))) {
    if ((await root.getAttribute('aria-expanded')) !== 'true') await root.click()
    await expect(root).toHaveAttribute('aria-expanded', 'true')
    return
  }
  const toggle = root
    .locator(
      ':scope > summary, :scope > .agh-disclosure-summary, :scope > button.agnes-settings-drill[aria-expanded]',
    )
    .first()
  const native = (await root.evaluate((node) => node.tagName)) === 'DETAILS'
  const open = native
    ? (await root.getAttribute('open')) !== null
    : (await root.getAttribute('data-open')) === 'true' ||
      (await toggle.getAttribute('aria-expanded')) === 'true'
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
  // A session URL can render before the navigation presentation has attached.
  const settings = page.locator('#settings')
  const toggle = page.locator('#sidebar-toggle')
  await expect.poll(async () => (await settings.isVisible()) || (await toggle.isVisible())).toBe(true)
  if (!(await settings.isVisible())) await toggle.click()
  await expect(settings).toBeVisible()
}

/** The view menu owns both the grouping and the archived filter; its items carry stable test ids. */
export async function chooseView(page: Page, filter: 'active' | 'all' | 'archived') {
  await sidebar(page)
  await page.locator('#session-view').click()
  await page.getByTestId(`session-view-filter-${filter}`).click()
  await expect(page.locator('#session-view')).toHaveAttribute('aria-expanded', 'false')
}

export async function homePage(page: Page, id: string, tab?: string) {
  if (await settingsVisible(page)) await dismissSettings(page)
  const dock = page.getByTestId('workbench-right-toggle')
  if ((await dock.isVisible()) && (await dock.getAttribute('aria-expanded')) === 'true')
    await dismissWorkbench(page)
  await sidebar(page)
  await page.getByTestId(`home-entry-${id}`).click()
  await expect(page.getByTestId(`home-page-${id}`)).toBeVisible()
  const back = page.getByTestId('push-back')
  for (let level = 0; level < 8 && (await back.isVisible()); level++) {
    const previous = page.url()
    await back.click()
    // Push navigation traverses history; await its route before choosing the next visible action.
    await expect
      .poll(async () => page.url() !== previous || !(await back.isVisible()) || (await settingsVisible(page)))
      .toBe(true)
    await settled(page)
    if (await settingsVisible(page)) await dismissSettings(page)
  }
  await expect(back).toBeHidden()
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
  if (!(await page.locator('#config-form').isVisible()))
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
    engines: 'plugins-subagents',
    'computer-use': 'plugins-computer-use',
  }
  if (homes[id]) return page.getByTestId(`home-page-${homes[id]}`)
  if (id === 'memory') return page.getByTestId('personalization-memory')
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
  if (id === 'memory') {
    if (!(await page.locator('#config-form').isVisible()))
      await settings(page, (await page.locator('html').getAttribute('lang')) ?? 'en')
    const back = page.getByTestId('settings-back')
    if (await back.isVisible()) await back.click()
    await page.getByTestId('settings-nav-general').click()
    await page.getByTestId('personalization-memory').scrollIntoViewIfNeeded()
    await expect(page.getByTestId('memory-panel')).toBeVisible()
    return
  }
  const dock = page.getByTestId('workbench-right-toggle')
  if (
    id !== 'jobs' &&
    !(await page.locator('#config-form').isVisible()) &&
    (await dock.isVisible()) &&
    (await dock.getAttribute('aria-expanded')) === 'true'
  )
    await dismissWorkbench(page)
  if (id === 'jobs' && new URL(page.url()).pathname !== '/admin/plugins') {
    await closeSettings(page, (await page.locator('html').getAttribute('lang')) ?? 'en')
    await workbenchTab(page, 'terminal')
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
    search: ['plugins', 'plugins.search'],
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
      const capability = tab.slice(8)
      const zh = (await page.locator('html').getAttribute('lang')) === 'zh-CN'
      const labels: Record<string, readonly [string, string]> = {
        search: ['Web search', '网页搜索'],
        subagents: ['Subagents', '子代理'],
        'computer-use': ['Computer use', '电脑操作'],
      }
      await page
        .getByTestId('plugin-capability-settings')
        .getByRole('button', { name: new RegExp(`^${labels[capability]![zh ? 1 : 0]}(?: ·|$)`) })
        .click()
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
    if (await settingsVisible(page)) await dismissSettings(page)
    if (id === 'history') await page.keyboard.press('Meta+k')
    else {
      if (!(await page.getByTestId('session-inventory').isVisible())) await chooseView(page, 'archived')
      await expect(page.getByTestId('session-inventory')).toBeVisible()
    }
    return
  }
  if (!(await page.locator('#config-form').isVisible()))
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
  await page.getByTestId(`settings-nav-${canonical === 'models' ? 'model' : canonical}`).click()
  if (canonical === 'models') await page.getByTestId('settings-nav-models-tab').click()
  if (id === 'models') await expect(page.locator('#settings-subsection-models')).toBeVisible()
  else if (id === 'bundles') {
    await expand(page.getByTestId('run-config-technical'))
    await expand(page.getByTestId('settings-drill-bundles'))
  } else if (id === 'system-prompt') await expand(page.getByTestId('settings-drill-system-prompt'))
  else if (id === 'context') await expect(page.locator('#settings-subsection-context')).toBeVisible()
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

/** The session composer command opens the Goal popover. */
export async function openGoal(page: Page) {
  await page.getByRole('textbox', { name: /^(Task content|任务内容)$/ }).fill('/goal')
  await page.getByRole('textbox', { name: /^(Task content|任务内容)$/ }).press('Enter')
  await expect(page.getByTestId('goal-objective')).toBeVisible()
}

/** Select the stable record-order view through the trace's actual menu. */
export async function traceSequence(page: Page) {
  await page.getByTestId('trace-toolbar-more').click()
  await page.getByTestId('trace-timeline-sequence').click()
  await page.getByTestId('trace-toolbar-more').click()
  await expect(page.getByTestId('trace-timeline-sequence')).toHaveText(/^✓ /)
  await page.keyboard.press('Escape')
}

/** Open a dock panel through its tab or the real overflow menu when the strip folds it. */
export async function workbenchTab(
  page: Page,
  id: 'files' | 'terminal' | 'goal' | 'changed-files' | 'browser',
) {
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
      browser: ['Browser', '浏览器'],
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
  await settingsRoot(page)
  await page.locator('#config-close').click()
  await expect.poll(() => settingsVisible(page)).toBe(false)
}

export async function closeSettings(page: Page, _locale = 'en') {
  if (await page.getByTestId('session-search').isVisible()) {
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('session-search')).toBeHidden()
  }
  if (await settingsVisible(page)) await dismissSettings(page)
  if (await page.locator('#home-page').isVisible()) {
    await sidebar(page)
    const id = new URL(page.url()).searchParams.get('session')
    if (id) {
      if (await page.getByTestId('session-inventory').isVisible()) {
        await chooseView(page, 'active')
        await expect(page.getByTestId('session-inventory')).toBeHidden()
      }
      await page.locator(`.session[data-session="${id}"]`).click()
    } else await page.locator('#new').click()
    await expect(page.locator('#home-page')).toBeHidden()
  }
}

export async function chooseWorkspace(page: Page, runtime: Pick<Runtime, 'workspace'>, locale = 'en') {
  const workspacePath = await realpath(runtime.workspace)
  const skip = page.getByTestId('first-run-skip')
  const workspace = page.getByRole('dialog', {
    name: locale === 'en' ? 'Choose a workspace' : '选择工作区',
    exact: true,
  })
  const picker = page.getByRole('region', {
    name: locale === 'en' ? 'Select workspace' : '选择工作区',
    exact: true,
  })
  const chip = page.locator('#composer-workspace')
  let choosingFromPicker = false
  // Diagnostics can finish after the workspace chip is ready and open the first-run overlay.
  await page.addLocatorHandler(
    skip,
    async () => {
      await skip.click()
      await expect(skip).toBeHidden()
      // Closing onboarding also closes popovers; resume an interrupted workspace choice.
      if (choosingFromPicker && !(await workspace.isVisible()) && !(await picker.isVisible()))
        await chip.click()
    },
    { times: 1 },
  )
  await expect
    .poll(async () => (await skip.isVisible()) || (await workspace.isVisible()) || (await chip.isVisible()))
    .toBe(true)
  // The chip opens the workspace switcher; adding a workspace opens the full dialog.
  if (!(await workspace.isVisible())) {
    await expect(chip).toBeEnabled()
    await chip.click()
    choosingFromPicker = true
    await expect(picker).toBeVisible()
    const existing = picker.getByTitle(workspacePath, { exact: true })
    if (await existing.count()) {
      await existing.click()
      choosingFromPicker = false
      await expect(picker).toBeHidden()
    } else {
      await picker
        .getByRole('button', { name: locale === 'en' ? 'New workspace…' : '新建工作区…', exact: true })
        .click()
      choosingFromPicker = false
      await expect(workspace).toBeVisible()
    }
  }
  if (await workspace.isVisible()) {
    await workspace.locator('#new-session-cwd').fill(workspacePath)
    await workspace
      .getByRole('button', {
        name: locale === 'en' ? 'Use' : '使用',
        exact: true,
      })
      .click()
  }
  await expect(workspace).toBeHidden()
  await expect(chip).toHaveAttribute('title', workspacePath)
  const names = page.locator('.workspace-heading .workspace-name')
  await expect(names.filter({ hasText: /^w$/ })).toHaveCount(1)
  expect((await names.allTextContents()).every((name) => name.trim().length > 0)).toBe(true)
  await page.removeLocatorHandler(skip)
}

export async function fresh(page: Page, locale = 'en') {
  await page
    .getByRole('button', { name: locale === 'en' ? 'New conversation' : '新对话', exact: true })
    .click()
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
  // This helper submits a new turn; busy input intentionally queues guidance instead.
  await expect(page.locator('#composer')).toHaveAttribute('data-busy', 'false')
  const turns = page.getByTestId('conversation-turn')
  const before = await turns.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-turn-id')))
  const locale = await page.locator('html').getAttribute('lang')
  const composer = page.getByRole('textbox', {
    name: locale === 'zh-CN' ? '任务内容' : 'Task content',
    exact: true,
  })
  await expect(composer).toBeEnabled()
  await composer.fill(input)
  await expect(page.locator('#send')).toBeEnabled()
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
/** Open the runtime in a new conversation of its workspace, past the guide of a home without accounts. */
export async function openWorkspace(page: Page, runtime: Runtime) {
  const config = await (await runtime.connect()).config.get()
  await preferences(page)
  await page.goto(runtime.url)
  // Fresh homes initialize diagnostics before showing setup; the underlying composer is already visible.
  if (config.accounts?.length === 0 || (config.accounts === undefined && !config.configured)) {
    const guide = page.getByTestId('first-run-guide')
    await expect(guide).toBeVisible()
    await page.getByTestId('first-run-skip').click()
    await expect(guide).toBeHidden()
  }
  await chooseWorkspace(page, runtime)
  await fresh(page)
}
