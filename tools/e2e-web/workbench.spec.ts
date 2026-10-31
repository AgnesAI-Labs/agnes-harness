import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { WORKSPACE_SECRET_DIRS } from '@agnes/protocol'
import type { Page, TestInfo } from '@playwright/test'
import { expect, test } from './fixtures.js'
import { accessible, screen, settled, translated } from './quality.js'
import { toolResult } from './sdk.js'
import { sandboxedSession } from './test/sandbox.js'
import { chooseWorkspace, fresh, openGoal, turn, workbenchTab } from './ui.js'

// Every gate validates the locale/theme/viewport matrix; the private report is an optional copy.
async function workbenchScreen(page: Page, info: TestInfo, name: string, folder?: string) {
  for (const label of await page.locator('.workspace-name').allTextContents())
    expect(label.trim(), 'Every registered workspace identifies its folder').not.toBe('')
  // Screenshots are evidence only; a behaviour-only run skips them and keeps every assertion here.
  if (process.env.AGH_WEB_BEHAVIOUR_ONLY === '1') return
  await screen(page, info, `workbench-${name}`)
  if (folder) await copyFile(info.outputPath(`workbench-${name}.png`), join(folder, `${name}.png`))
}

test('workspace dock previews and mentions a file that the agent reads', async ({ page, runtime }, info) => {
  test.setTimeout(120_000)
  for (const args of [
    ['init', '--quiet'],
    ['add', '--', 'report.md'],
  ])
    await new Promise<void>((done, reject) => {
      execFile(
        'git',
        args,
        {
          cwd: runtime.workspace,
          timeout: 10_000,
          maxBuffer: 4096,
          env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        },
        (error) => (error ? reject(error) : done()),
      )
    })
  await page.addInitScript(() => {
    if (location.protocol !== 'http:') return
    if (!localStorage.getItem('agnes-locale')) localStorage.setItem('agnes-locale', 'en')
    if (!localStorage.getItem('agnes-theme')) localStorage.setItem('agnes-theme', 'light')
  })
  await page.goto(runtime.url)
  await chooseWorkspace(page, runtime)
  await fresh(page)
  const composer = page.getByRole('textbox', { name: 'Task content', exact: true })
  await composer.fill('Create a session for workspace review')
  await composer.press('Enter')
  await expect(page).toHaveURL(/session=/, { timeout: 40_000 })
  await expect(page.getByTestId('conversation-turn').last()).toHaveAttribute('data-status', 'completed', {
    timeout: 30_000,
  })
  await page.getByTestId('workbench-right-toggle').click()
  const files = page.getByTestId('files-panel')
  for (const expanded of [false, true]) {
    if (expanded) await page.getByRole('button', { name: 'Expand', exact: true }).click()
    await expect(page.getByTestId('files-choose')).toHaveCount(0)
    await expect(files.locator('.workbench-file-preview')).toHaveCount(0)
    await expect(page.getByTestId('files-divider')).toHaveCount(0)
    await expect(async () => {
      const panel = await files.boundingBox()
      const tree = await page.getByTestId('files-tree').boundingBox()
      expect(panel).not.toBeNull()
      expect(tree?.height).toBeCloseTo(panel?.height ?? 0, 0)
      expect(tree?.width).toBeCloseTo(panel?.width ?? 0, 0)
    }).toPass()
  }
  await page.getByRole('button', { name: 'Collapse', exact: true }).click()
  await files.locator('[data-path="report.md"]').click()
  await expect(page.getByTestId('file-preview')).toContainText('Synthetic delivery')
  await expect(page.getByTestId('file-tab')).toHaveCount(1)
  await expect(page.getByTestId('file-tab-select')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('file-mention').click()
  await expect(page.getByRole('textbox', { name: 'Task content', exact: true })).toHaveValue('@report.md  ')
  await turn(page, 'call read {"path":"report.md"}')
  const client = await runtime.connect()
  const id = new URL(page.url()).searchParams.get('session')
  if (!id) throw new Error('The session URL must identify the workspace session')
  const session = await client.session.load(id, { cwd: runtime.workspace })
  const listing = await session.workspaceList()
  expect(listing.gitStatus).toBe('available')
  expect(listing.entries.find((entry) => entry.name === 'report.md')?.git).toBe('added')
  expect(listing.entries.some((entry) => entry.name === '.git')).toBe(false)
  await expect(session.workspaceRead('.git/config')).rejects.toMatchObject({
    code: -32011,
    data: { code: 'WORKSPACE_PATH_DENIED' },
  })
  await expect(files.locator('[data-path="report.md"] .workbench-git-mark')).toHaveText('Added')
  await expect(page.getByTestId('workbench-bottom-toggle')).toHaveCount(0)
  // The current top bar is 44px including its divider.
  expect(await page.locator('.topbar-row').evaluate((node) => node.getBoundingClientRect().height)).toBe(44)
  expect(
    await page.getByTestId('workbench-right-toggle').evaluate((node) => !!node.closest('.topbar-row')),
  ).toBe(true)
  await expect(page.locator('#composer-workspace')).toBeHidden()
  await page.getByTestId('workbench-tab-files').focus()
  await page.keyboard.press('F6')
  expect(await page.locator('#composer').evaluate((node) => node.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Shift+F6')
  expect(
    await page.locator('#workbench-right').evaluate((node) => node.contains(document.activeElement)),
  ).toBe(true)
  // Complete the cycle in both directions, including wraparound to the originating region.
  for (const key of ['F6', 'Shift+F6']) {
    await page.getByTestId('workbench-tab-files').focus()
    const regions =
      key === 'F6'
        ? ['#composer', '.sidebar', '.conversation-shell', '#workbench-right']
        : ['.conversation-shell', '.sidebar', '#composer', '#workbench-right']
    for (const region of regions) {
      await page.keyboard.press(key)
      expect(await page.locator(region).evaluate((node) => node.contains(document.activeElement))).toBe(true)
    }
  }
  await page.getByRole('button', { name: 'Expand', exact: true }).click()
  expect(
    await page
      .locator('.workbench-split')
      .evaluate((node) => (node as HTMLElement).style.getPropertyValue('--workbench-width')),
  ).toBe('60vw')
  await page.getByRole('button', { name: 'Collapse', exact: true }).click()
  expect(JSON.stringify(await toolResult(session, 'read'))).toContain('Synthetic delivery')
  await translated(page)
  await accessible(page, info, 'workspace-files')
  const folder = process.env.AGH_WORKBENCH_REPORT
  if (folder) await mkdir(folder, { recursive: true })
  for (const locale of ['en', 'zh-CN'])
    for (const theme of ['light', 'dark'])
      for (const width of [1440, 1280]) {
        await page.setViewportSize({ width, height: 900 })
        await page.evaluate(
          ({ locale, theme }) => {
            localStorage.setItem('agnes-locale', locale)
            localStorage.setItem('agnes-theme', theme)
          },
          { locale, theme },
        )
        await page.reload()
        await expect(page.getByTestId('files-panel')).toBeVisible()
        await page.getByTestId('workspace-file').filter({ hasText: 'report.md' }).click()
        await expect(page.getByTestId('file-preview')).toContainText('Synthetic delivery')
        await settled(page)
        const geometry = await page.evaluate(() => {
          const rect = (selector: string) => {
            const element = document.querySelector(selector)
            if (!element) throw new Error(`Missing layout surface: ${selector}`)
            return element.getBoundingClientRect().toJSON() as {
              left: number
              right: number
              height: number
            }
          }
          return {
            dock: rect('#workbench-right'),
            composer: rect('#composer'),
            conversation: rect('#conversation-shell'),
            tree: rect('.workbench-tree-scroll'),
            preview: rect('.workbench-file-preview'),
            entry: rect('[data-path="report.md"]'),
            name: rect('[data-path="report.md"] .workbench-file-name'),
          }
        })
        expect(geometry.composer.right).toBeLessThanOrEqual(geometry.dock.left)
        expect(geometry.conversation.right).toBeLessThanOrEqual(geometry.dock.left)
        expect(geometry.name.left - geometry.entry.left).toBeLessThan(50)
        expect(geometry.preview.height).toBeGreaterThan(geometry.tree.height)
        await expect(page.locator('.workbench-dock-heading button[aria-busy]')).toBeVisible()
        await expect(files.locator('.workbench-files-footer button, .workbench-files-footer a')).toHaveCount(
          0,
        )
        await page.getByTestId('files-more').click()
        await expect(page.getByTestId('files-rules')).toHaveAttribute('role', 'menuitem')
        await page.getByTestId('files-rules').click()
        await expect(page.getByTestId('files-rules-text')).toContainText('.aghignore')
        await page.getByTestId('files-more').click()
        await page.getByTestId('files-rules').click()
        await expect(page.getByTestId('files-rules-text')).toHaveCount(0)
        await expect(page.getByTestId('file-meta')).not.toContainText(/T\d{2}:/)
        await workbenchScreen(page, info, `p1-${locale}-${theme}-${width}-after`, folder)
        await page.getByTestId('workbench-right-toggle').click()
        await workbenchScreen(page, info, `p1-${locale}-${theme}-${width}-before`, folder)
        await page.getByTestId('workbench-right-toggle').click()
      }
  await page.setViewportSize({ width: 375, height: 812 })
  await expect(files).toBeVisible()
  await page.getByTestId('workbench-tab-files').press('Escape')
  await expect(files).toBeHidden()
  await expect(page.getByTestId('workbench-right-toggle')).toBeFocused()
})

test('file tabs open, switch, survive a reload and close to their neighbour', async ({ page, runtime }) => {
  test.setTimeout(180_000)
  // The extra files are written directly: the transcript of the screenshot test above stays unchanged.
  await writeFile(join(runtime.workspace, 'notes.md'), 'Second tab\n')
  for (const name of ['alpha.md', 'beta.md', 'gamma.md'])
    await writeFile(join(runtime.workspace, name), `Content of ${name}\n`)
  await page.addInitScript(() => {
    if (location.protocol !== 'http:') return
    if (!localStorage.getItem('agnes-locale')) localStorage.setItem('agnes-locale', 'en')
    if (!localStorage.getItem('agnes-theme')) localStorage.setItem('agnes-theme', 'light')
  })
  await page.goto(runtime.url)
  await chooseWorkspace(page, runtime)
  await fresh(page)
  const composer = page.getByRole('textbox', { name: 'Task content', exact: true })
  await composer.fill('Create a session for file tabs')
  await composer.press('Enter')
  await expect(page).toHaveURL(/session=/, { timeout: 40_000 })
  await expect(page.getByTestId('conversation-turn').last()).toHaveAttribute('data-status', 'completed', {
    timeout: 30_000,
  })
  await page.getByTestId('workbench-right-toggle').click()
  await workbenchTab(page, 'files')
  const files = page.getByTestId('files-panel')
  // The tree row and the tab both carry data-path, so the row is named by its own test id.
  const row = (path: string) => files.locator(`[data-testid="workspace-file"][data-path="${path}"]`)
  await row('report.md').click()
  await expect(page.getByTestId('file-preview')).toContainText('Synthetic delivery')
  await row('notes.md').click()
  await expect(page.getByTestId('file-tab')).toHaveCount(2)
  await expect(page.getByTestId('file-preview')).toContainText('Second tab')
  // The tree highlight follows the active tab, not the last click.
  await expect(row('notes.md')).toHaveAttribute('aria-pressed', 'true')
  await expect(row('report.md')).toHaveAttribute('aria-pressed', 'false')
  await files
    .locator('[data-testid="file-tab"][data-path="report.md"] [data-testid="file-tab-select"]')
    .click()
  await expect(page.getByTestId('file-preview')).toContainText('Synthetic delivery')
  // The open list is per session and survives a reload; the file content is not stored.
  await page.reload()
  await expect(page.getByTestId('file-tab')).toHaveCount(2)
  await expect(page.getByTestId('file-preview')).toContainText('Synthetic delivery')
  // Closing the active tab activates its right neighbour.
  await files
    .locator('[data-testid="file-tab"][data-path="report.md"] [data-testid="file-tab-close"]')
    .click()
  await expect(page.getByTestId('file-tab')).toHaveCount(1)
  await expect(page.getByTestId('file-preview')).toContainText('Second tab')
  await files.locator('[data-testid="file-tab"][data-path="notes.md"] [data-testid="file-tab-close"]').click()
  await expect(page.getByTestId('file-tab')).toHaveCount(0)
  await expect(page.getByTestId('file-pane')).toHaveCount(0)
  // At phone width the strip scrolls inside the dock; the page itself never scrolls sideways.
  await page.setViewportSize({ width: 390, height: 812 })
  for (const name of ['report.md', 'notes.md', 'alpha.md', 'beta.md', 'gamma.md']) await row(name).click()
  await expect(page.getByTestId('file-tab')).toHaveCount(5)
  const strip = page.getByTestId('file-tabs')
  const layout = await strip.evaluate((node) => {
    const active = node.querySelector<HTMLElement>('[data-testid="file-tab"][data-active="true"]')
    const box = node.getBoundingClientRect()
    const tab = active?.getBoundingClientRect()
    return {
      scrollable: node.scrollWidth > node.clientWidth,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      activeVisible: !!tab && tab.left >= box.left - 1 && tab.right <= box.right + 1,
    }
  })
  expect(layout.scrollable).toBe(true)
  expect(layout.pageOverflow).toBeLessThanOrEqual(1)
  expect(layout.activeVisible).toBe(true)
})

test('session terminal survives UI detachment, follows agent output and honors preset denials', async ({
  page,
  runtime,
}, info) => {
  test.setTimeout(240_000)
  // Real protected mount targets make the OS refusal observable. Bubblewrap cannot
  // create a missing deny mount below a read-only parent; keep that refusal intact.
  const protectedFiles = [
    join(dirname(runtime.home), '.ssh', 'wb1-synthetic-key'),
    join(runtime.home, 'data', 'wb1-synthetic-protected'),
    join(runtime.workspace, '.git', 'wb1-synthetic-metadata'),
    ...WORKSPACE_SECRET_DIRS.map((path) => join(runtime.workspace, path, 'wb1-synthetic-secret')),
  ]
  await page.addInitScript(() => {
    if (location.protocol !== 'http:') return
    if (!localStorage.getItem('agnes-locale')) localStorage.setItem('agnes-locale', 'en')
    if (!localStorage.getItem('agnes-theme')) localStorage.setItem('agnes-theme', 'light')
  })
  await page.goto(runtime.url)
  await chooseWorkspace(page, runtime)
  await fresh(page)
  const composer = page.getByRole('textbox', { name: 'Task content', exact: true })
  await composer.fill('Create a session for terminal review')
  await composer.press('Enter')
  await expect(page).toHaveURL(/session=/, { timeout: 40_000 })
  await expect(page.getByTestId('conversation-turn').last()).toHaveAttribute('data-status', 'completed', {
    timeout: 30_000,
  })
  await turn(page, 'call shell {"command":"printf AGENT_BEGIN; sleep 3; printf AGENT_END","background":true}')
  const client = await runtime.connect(),
    id = new URL(page.url()).searchParams.get('session')
  if (!id) throw new Error('session required')
  const session = await client.session.load(id, { cwd: runtime.workspace })
  const agent = (await session.jobsRead()).jobs.find((job) => job.owner === 'agent')
  if (!agent) throw new Error('agent job required')
  await expect(session.jobsControl({ operation: 'kill', jobId: agent.id })).rejects.toMatchObject({
    data: { code: 'CAPABILITY_DENIED' },
  })
  await page.getByTestId('workbench-right-toggle').click()
  const panel = page.getByTestId('terminal-panel')
  await workbenchTab(page, 'terminal')
  await expect(page.getByTestId('workbench-tab-terminal')).toBeFocused()
  const resize = page.locator('#workbench-right .workbench-resize')
  const initial = Number(await resize.getAttribute('aria-valuenow'))
  const minimum = Number(await resize.getAttribute('aria-valuemin'))
  const maximum = Number(await resize.getAttribute('aria-valuemax'))
  // The initial dock follows the viewport; leave room to exercise growing it with the keyboard.
  for (let i = 0; i < 8; i++) await resize.press('ArrowRight')
  const shrunk = Math.max(minimum, initial - 8 * 16)
  await expect(resize).toHaveAttribute('aria-valuenow', String(shrunk))
  for (let i = 0; i < 8; i++) {
    await resize.press('ArrowLeft')
    await expect(resize).toHaveAttribute('aria-valuenow', String(Math.min(maximum, shrunk + (i + 1) * 16)))
  }
  // Agent jobs are attached automatically; selecting its tab follows the real output.
  await panel.getByTestId('terminal-tab').filter({ hasText: agent.command }).click()
  await expect.poll(async () => (await session.jobsRead(agent.id)).job?.stdout).toContain('AGENT_END')
  await expect(
    panel.getByTestId('workbench-terminal-output').locator('.xterm-accessibility-tree'),
  ).toContainText('AGENT_END')
  await expect(panel.getByTestId('terminal-kill')).toHaveCount(0)
  await panel.getByRole('button', { name: 'Stop following', exact: true }).click()
  // The dock starts no shell for the person until they ask for one.
  await expect(panel.getByTestId('terminal-tab')).toHaveCount(0)
  await panel.getByTestId('terminal-new').click()
  await expect(panel.getByTestId('terminal-tab')).toHaveCount(1)
  await panel.getByTestId('terminal-tab').first().click()
  const output = panel.getByTestId('workbench-terminal-output')
  const terminalText = output.locator('.xterm-accessibility-tree')
  const terminalInput = output.locator('textarea')
  await expect(output).toBeVisible()
  const human = (await session.jobsRead()).jobs.find((job) => job.owner === 'human')
  if (!human) throw new Error('human terminal required')
  await expect(terminalInput).toBeEditable()
  await terminalInput.pressSequentially("printf 'E2E_TERMINAL_OK\\n'")
  await terminalInput.press('Enter')
  // The output must start its own line; the echoed command never does. Readline (bash >= 5.1)
  // leaves bracketed-paste mode with `ESC[?2004l` + CR before the command runs, so after VT
  // stripping a line can begin at CR as well as at LF.
  await expect
    .poll(async () => stripVTControlCharacters((await session.jobsRead(human.id)).job?.stdout ?? ''))
    .toMatch(/[\r\n]E2E_TERMINAL_OK\r?\n/)
  await expect(terminalText).toContainText('E2E_TERMINAL_OK')
  await terminalInput.pressSequentially("PS1='wb1$ '; printf '\\033[2J\\033[H'; printf 'WB1_TERMINAL_OK\\n'")
  await terminalInput.press('Enter')
  await expect
    .poll(async () => stripVTControlCharacters((await session.jobsRead(human.id)).job?.stdout ?? ''))
    .toMatch(/[\r\n]WB1_TERMINAL_OK\r?\n/)
  await expect(terminalText).toContainText('WB1_TERMINAL_OK')
  await panel.getByTestId('terminal-new').click()
  await expect(panel.getByTestId('terminal-tab')).toHaveCount(2)
  await panel.getByTestId('terminal-tab').last().press('ArrowLeft')
  await expect(panel.getByTestId('terminal-tab').first()).toBeFocused()
  await page.getByTestId('workbench-right-toggle').click()
  expect((await session.jobsRead(human.id)).job?.status).toBe('running')
  await session.detach()
  expect((await session.jobsRead(human.id)).job?.status).toBe('running')
  await page.reload()
  await page.getByTestId('workbench-right-toggle').click()
  await expect(panel.getByTestId('terminal-tab')).toHaveCount(2)
  await panel.getByTestId('terminal-tab').first().click()
  await expect(terminalText).toContainText('WB1_TERMINAL_OK')
  await panel
    .getByTestId('terminal-tab')
    .and(page.locator('[aria-pressed="true"]'))
    .click({ button: 'right' })
  await page.getByTestId('terminal-interrupt').click()
  expect((await session.jobsRead(human.id)).job?.status).toBe('running')
  // Another client's read can precede the UI's control receipt; keyboard actions do not wait for enabled.
  await expect(terminalInput).toBeEditable()
  await terminalInput.pressSequentially("printf 'WB1_AFTER_INTERRUPT\\n'")
  await terminalInput.press('Enter')
  await expect
    .poll(async () => stripVTControlCharacters((await session.jobsRead(human.id)).job?.stdout ?? ''))
    .toMatch(/[\r\n]WB1_AFTER_INTERRUPT\r?\n/)
  await expect(terminalText).toContainText('WB1_AFTER_INTERRUPT')
  await translated(page)
  await accessible(page, info, 'workbench-terminal')
  const folder = process.env.AGH_WORKBENCH_REPORT
  if (folder) await mkdir(folder, { recursive: true })
  for (const locale of ['en', 'zh-CN'])
    for (const theme of ['light', 'dark'])
      for (const width of [1440, 1280]) {
        await page.setViewportSize({ width, height: 900 })
        await page.evaluate(
          ({ locale, theme }) => {
            localStorage.setItem('agnes-locale', locale)
            localStorage.setItem('agnes-theme', theme)
          },
          { locale, theme },
        )
        await page.reload()
        await expect(panel.getByTestId('terminal-tab')).toHaveCount(2)
        await expect(terminalText).toContainText('WB1_AFTER_INTERRUPT')
        await settled(page)
        await workbenchScreen(page, info, `p2-${locale}-${theme}-${width}-after`, folder)
        await page.getByTestId('workbench-right-toggle').click()
        await workbenchScreen(page, info, `p2-${locale}-${theme}-${width}-before`, folder)
        await page.getByTestId('workbench-right-toggle').click()
      }
  await page.evaluate(() => {
    localStorage.setItem('agnes-locale', 'en')
    localStorage.setItem('agnes-theme', 'light')
  })
  await page.reload()
  await expect(terminalText).toContainText('WB1_AFTER_INTERRUPT')
  const second = await client.session.new({
    cwd: runtime.workspace,
    preset: 'standard',
    permission: 'full-access',
    sessionKey: 'wb1-terminal-other',
  })
  await expect(second.jobsControl({ operation: 'kill', jobId: human.id })).rejects.toMatchObject({
    data: { code: 'CAPABILITY_DENIED' },
  })
  const originalUrl = page.url(),
    otherUrl = new URL(originalUrl)
  otherUrl.searchParams.set('session', second.id)
  await page.goto(otherUrl.toString())
  await expect(panel.getByTestId('terminal-tab')).toHaveCount(0)
  expect((await session.jobsRead(human.id)).job?.status).toBe('running')
  await page.goto(originalUrl)
  await expect(panel.getByTestId('terminal-tab')).toHaveCount(2)
  await expect(session.setPreset('read-only')).rejects.toMatchObject({
    code: -32008,
    data: { code: 'E_PRESET_UNSUPPORTED' },
  })
  for (const path of protectedFiles) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, 'WB1_PROTECTED_SYNTHETIC\n')
  }
  await mkdir(join(runtime.home, 'data/secrets'), { recursive: true })
  await mkdir(join(runtime.home, 'data/tmp'), { recursive: true })
  const readOnly = await sandboxedSession(client, runtime, 'read-only', info)
  if (readOnly) {
    await expect(readOnly.jobsControl({ operation: 'open' })).rejects.toMatchObject({
      data: { code: 'CAPABILITY_DENIED' },
    })
    expect((await readOnly.jobsRead()).jobs).toHaveLength(0)
  }
  expect((await session.jobsRead()).jobs.filter((job) => job.owner === 'human')).toHaveLength(2)
  const sandboxed = await sandboxedSession(client, runtime, 'workspace-write', info)
  if (sandboxed) {
    const workspace = await sandboxed.jobsControl({ operation: 'open' })
    expect(workspace.output).toMatchObject({
      owner: 'human',
      ownerSessionId: sandboxed.id,
      cwd: await realpath(runtime.workspace),
      status: 'running',
    })
    if (!('id' in workspace.output)) throw new Error('workspace terminal required')
    const workspaceJobId = workspace.output.id
    const outside = join(dirname(await realpath(runtime.workspace)), 'terminal-outside-denied.txt')
    await sandboxed.jobsControl({
      operation: 'send',
      jobId: workspace.output.id,
      text: `printf DENIED > '${outside}'; ${protectedFiles.map((path) => `cat '${path}'; printf CHANGED > '${path}'`).join('; ')}; printf ALLOWED > wb1-terminal-inside.txt; printf 'WB1_BOUNDARY_DONE\\n'\n`,
    })
    await expect
      .poll(async () => (await sandboxed.jobsRead(workspaceJobId)).job?.stdout, { timeout: 30_000 })
      .toMatch(/\r?\nWB1_BOUNDARY_DONE\r?\n/)
    expect(await readFile(join(runtime.workspace, 'wb1-terminal-inside.txt'), 'utf8')).toBe('ALLOWED')
    await expect(access(outside)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await sandboxed.jobsRead(workspaceJobId)).job?.stdout).not.toContain('WB1_PROTECTED_SYNTHETIC')
    for (const path of protectedFiles) expect(await readFile(path, 'utf8')).toBe('WB1_PROTECTED_SYNTHETIC\n')
    await sandboxed.jobsControl({ operation: 'kill', jobId: workspace.output.id })
  }
  await panel.getByTestId('terminal-tab-close').first().click()
  await page
    .getByRole('dialog', { name: 'Kill process', exact: true })
    .getByRole('button', { name: 'Kill process', exact: true })
    .click()
  await expect
    .poll(async () => (await session.jobsRead(human.id)).job?.status, { timeout: 30_000 })
    .toBe('killed')
  await expect(panel.getByTestId('terminal-tab')).toHaveCount(1)
  await panel.getByTestId('terminal-tab').first().click()
  await panel
    .getByTestId('terminal-tab')
    .and(page.locator('[aria-pressed="true"]'))
    .click({ button: 'right' })
  const remaining = (await session.jobsRead()).jobs.find(
    (job) => job.owner === 'human' && job.status === 'running',
  )
  if (!remaining) throw new Error('Remaining live terminal required')
  await page.getByTestId('terminal-kill').click()
  await page
    .getByRole('dialog', { name: 'Kill process', exact: true })
    .getByRole('button', { name: 'Kill process', exact: true })
    .click()
  await expect
    .poll(async () => (await session.jobsRead(remaining.id)).job?.status, { timeout: 30_000 })
    .toBe('killed')
  const exited = (await session.jobsRead(remaining.id)).job
  await expect(terminalText).toContainText(`Process exited (${exited?.code})`)
  await page.getByTestId('workbench-tab-terminal').press('Escape')
  await expect(panel).toBeHidden()
  await expect(page.getByTestId('workbench-right-toggle')).toBeFocused()
})

test('goal panel follows durable progress and shares authorized human controls', async ({
  page,
  runtime,
}, info) => {
  test.setTimeout(300_000)
  await page.addInitScript(() => {
    if (location.protocol !== 'http:') return
    if (!localStorage.getItem('agnes-locale')) localStorage.setItem('agnes-locale', 'en')
    if (!localStorage.getItem('agnes-theme')) localStorage.setItem('agnes-theme', 'light')
  })
  await page.goto(runtime.url)
  await chooseWorkspace(page, runtime)
  await fresh(page)
  const composer = page.getByRole('textbox', { name: 'Task content', exact: true })
  await composer.fill('Create a session for goal review')
  await composer.press('Enter')
  await expect(page).toHaveURL(/session=/, { timeout: 40_000 })
  await expect(page.getByTestId('conversation-turn').last()).toHaveAttribute('data-status', 'completed', {
    timeout: 30_000,
  })
  await page.getByTestId('workbench-right-toggle').click()
  await expect(page.getByTestId('workbench-tab-goal')).toHaveCount(0)
  await openGoal(page)
  await page.getByTestId('goal-objective').fill('Review the synthetic delivery')
  await page.getByTestId('goal-max-rounds').fill('1')
  await page.getByTestId('goal-save').click()
  await workbenchTab(page, 'goal')
  const panel = page.getByTestId('goal-panel')
  await expect(panel.getByTestId('goal-panel-phase')).toHaveText('Blocked goal', { timeout: 30_000 })
  await expect(page.getByTestId('goal-toggle')).toHaveAttribute('aria-expanded', 'false')
  await expect(panel.getByTestId('goal-panel-objective')).toHaveText('Review the synthetic delivery')
  await expect(panel.getByTestId('goal-panel-progress')).toContainText('1 of 1')
  await expect(panel.getByTestId('goal-reason')).toContainText('maximum automatic rounds')
  await expect(page.getByRole('button', { name: 'Cancel turn', exact: true })).toHaveCount(0)
  const client = await runtime.connect(),
    id = new URL(page.url()).searchParams.get('session')
  if (!id) throw new Error('session required')
  const session = await client.session.load(id, { cwd: runtime.workspace })
  const snapshot = async () => {
    const timeline = await session.projectUI(undefined, { surface: 'web' })
    const fill = timeline.slots?.find((fill) => fill.extId === 'agnes/goal' && fill.slot === 'status.line')
    return (fill?.payload as { goal?: { id: string; phase: string; revision: number; rounds: number } })?.goal
  }
  const initial = await snapshot()
  expect(initial).toMatchObject({ phase: 'blocked', rounds: 1 })
  await composer.fill('/goal pause')
  await composer.press('Enter')
  await expect(panel.getByTestId('goal-panel-phase')).toHaveText('Paused goal')
  await expect(page.getByRole('button', { name: 'Cancel turn', exact: true })).toHaveCount(0)
  await panel.getByTestId('goal-panel-resume').click()
  await expect(panel.getByTestId('goal-panel-phase')).toHaveText('Blocked goal', { timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Cancel turn', exact: true })).toHaveCount(0)
  expect((await snapshot())?.revision).toBeGreaterThan(initial?.revision ?? 0)
  await translated(page)
  await accessible(page, info, 'goal-panel')
  const folder = process.env.AGH_WORKBENCH_REPORT
  if (folder) await mkdir(folder, { recursive: true })
  for (const locale of ['en', 'zh-CN'])
    for (const theme of ['light', 'dark'])
      for (const width of [1440, 1280]) {
        await page.setViewportSize({ width, height: 900 })
        await page.evaluate(
          ({ locale, theme }) => {
            localStorage.setItem('agnes-locale', locale)
            localStorage.setItem('agnes-theme', theme)
          },
          { locale, theme },
        )
        await page.reload()
        await workbenchTab(page, 'goal')
        await expect(panel.getByTestId('goal-panel-objective')).toHaveText('Review the synthetic delivery')
        await translated(page)
        await settled(page)
        await workbenchScreen(page, info, `p3-${locale}-${theme}-${width}-after`, folder)
        await page.getByTestId('workbench-right-toggle').click()
        await workbenchScreen(page, info, `p3-${locale}-${theme}-${width}-before`, folder)
        await page.getByTestId('workbench-right-toggle').click()
      }
  await page.evaluate(() => {
    localStorage.setItem('agnes-locale', 'en')
    localStorage.setItem('agnes-theme', 'light')
  })
  await page.reload()
  await workbenchTab(page, 'goal')
  await panel.getByTestId('goal-panel-complete').click()
  await expect(panel.getByTestId('goal-panel-phase')).toHaveText('Completed goal')
  expect(await snapshot()).toMatchObject({ id: initial?.id, phase: 'complete' })
  await expect(panel.getByTestId('goal-panel-complete')).toHaveCount(0)
  await page.setViewportSize({ width: 375, height: 812 })
  await page.getByTestId('workbench-tab-goal').press('Escape')
  await expect(panel).toBeHidden()
  await expect(page.getByTestId('workbench-right-toggle')).toBeFocused()
  expect(await snapshot()).toMatchObject({ phase: 'complete' })
  await page.getByTestId('workbench-right-toggle').click()
  await panel.getByTestId('goal-panel-clear').click()
  await expect(page.getByTestId('workbench-tab-goal')).toHaveCount(0)
  await expect(panel).toHaveCount(0)
  expect(await snapshot()).toBeUndefined()
})

test('changed files review follows confirmed agent effects and preserves current file authority', async ({
  page,
  runtime,
}, info) => {
  test.setTimeout(300_000)
  await page.addInitScript(() => {
    if (location.protocol !== 'http:') return
    if (!localStorage.getItem('agnes-locale')) localStorage.setItem('agnes-locale', 'en')
    if (!localStorage.getItem('agnes-theme')) localStorage.setItem('agnes-theme', 'light')
  })
  await page.goto(runtime.url)
  await chooseWorkspace(page, runtime)
  await fresh(page)
  const composer = page.getByRole('textbox', { name: 'Task content', exact: true })
  await composer.fill('Create a session for confirmed file review')
  await composer.press('Enter')
  await expect(page).toHaveURL(/session=/, { timeout: 40_000 })
  await expect(page.getByTestId('conversation-turn').last()).toHaveAttribute('data-status', 'completed', {
    timeout: 30_000,
  })
  await turn(page, 'call write {"path":"review.ts","content":"export const answer = 1\\n"}')
  const client = await runtime.connect(),
    id = new URL(page.url()).searchParams.get('session')
  if (!id) throw new Error('session required')
  const session = await client.session.load(id, { cwd: runtime.workspace })
  await toolResult(session, 'write')
  await turn(page, 'call edit {"path":"review.ts","edits":[{"oldText":"answer = 1","newText":"answer = 2"}]}')
  await toolResult(session, 'edit')
  const changed = await session.workspaceChanges({ path: 'review.ts' })
  expect(changed.unrecorded).toBe(false)
  expect(changed.selected).toMatchObject({
    kind: 'added',
    added: 1,
    removed: 0,
    freshness: 'current',
    basis: 'session',
  })
  expect(changed.selected?.effects).toHaveLength(2)
  expect(changed.selected?.diff).toContain('+export const answer = 2\n')
  const latest = await session.workspaceChanges({ scope: 'turn', path: 'review.ts' })
  expect(latest.selected).toMatchObject({ kind: 'modified', added: 1, removed: 1, basis: 'turn' })
  expect(latest.selected?.diff).toContain('-export const answer = 1\n')
  await page.getByTestId('workbench-right-toggle').click()
  await workbenchTab(page, 'files')
  await page
    .getByTestId('files-panel')
    .getByTestId('workspace-file')
    .and(page.locator('[data-path="review.ts"]'))
    .click()
  await expect(page.getByTestId('file-preview')).toContainText('answer = 2')
  const preview = await session.workspaceRead('review.ts')
  await page.getByTestId('file-review').click()
  const panel = page.getByTestId('changes-panel')
  await expect(page.getByTestId('workbench-tab-changed-files')).toHaveAttribute('aria-selected', 'true')
  await expect(panel.getByTestId('changes-diff')).toContainText('+export const answer = 2')
  await expect(panel.getByTestId('changed-file')).toContainText('+1')
  await expect(panel.getByTestId('changed-file')).toContainText('−0')
  await expect(panel.getByTestId('changed-file').locator('.workbench-changes-path')).toHaveText('review.ts')
  await expect(panel.locator('.workbench-change-name')).toHaveText('review.ts')
  // The editor diff names the file in its header and renders numbered code rows.
  expect(changed.selected?.diff).toContain('--- a/review.ts\n+++ b/review.ts\n')
  await expect(
    panel.getByTestId('changes-diff').locator('[data-kind=add] .workbench-diff-text'),
  ).toContainText('export const answer = 2')
  await translated(page)
  await accessible(page, info, 'changed-files-review')
  const folder = process.env.AGH_WORKBENCH_REPORT
  if (folder) await mkdir(folder, { recursive: true })
  for (const locale of ['en', 'zh-CN'])
    for (const theme of ['light', 'dark'])
      for (const width of [1440, 1280]) {
        await page.setViewportSize({ width, height: 900 })
        await page.evaluate(
          ({ locale, theme }) => {
            localStorage.setItem('agnes-locale', locale)
            localStorage.setItem('agnes-theme', theme)
          },
          { locale, theme },
        )
        await page.reload()
        await workbenchTab(page, 'changed-files')
        await panel.getByTestId('changed-file').filter({ hasText: 'review.ts' }).click()
        await expect(panel.getByTestId('changes-diff')).toContainText('+export const answer = 2')
        await translated(page)
        await workbenchScreen(page, info, `p4-${locale}-${theme}-${width}-after`, folder)
        await page.getByTestId('workbench-right-toggle').click()
        await workbenchScreen(page, info, `p4-${locale}-${theme}-${width}-before`, folder)
        await page.getByTestId('workbench-right-toggle').click()
      }
  await page.evaluate(() => {
    localStorage.setItem('agnes-locale', 'en')
    localStorage.setItem('agnes-theme', 'light')
  })
  await page.reload()
  await workbenchTab(page, 'files')
  await page
    .getByTestId('files-panel')
    .getByTestId('workspace-file')
    .and(page.locator('[data-path="review.ts"]'))
    .click()
  await page.getByTestId('file-review').click()
  await expect(panel.getByTestId('changes-diff')).toContainText('+export const answer = 2')
  // An external human change is never rolled into the agent's historical diff.
  await writeFile(join(runtime.workspace, 'review.ts'), 'export const answer = 99\n')
  // Polling refresh observes external edits without a manual refresh action.
  await expect(panel).toContainText('changed after the recorded agent edit')
  await expect(panel).toContainText('changed since the preview was read')
  const newer = await session.workspaceChanges({ path: 'review.ts', expectedRevision: preview.revision })
  expect(newer.selected).toMatchObject({
    freshness: 'changed',
    viewerChanged: true,
    afterRevision: preview.revision,
  })
  expect(newer.selected?.diff).toContain('+export const answer = 2\n')
  expect(newer.selected?.diff).not.toContain('answer = 99')
  await panel.getByTestId('changes-mention').click()
  await expect(composer).toHaveValue('@review.ts  ')
  await expect(page.getByTestId('composer-file-mention')).toContainText('review.ts')
  expect(await readFile(join(runtime.workspace, 'review.ts'), 'utf8')).toBe('export const answer = 99\n')
  await panel.locator('.workbench-change-evidence > :is(summary, .agh-disclosure-summary)').click()
  await panel.getByTestId('changes-effect').last().click()
  await expect(page.locator('#view-trace')).toHaveAttribute('aria-selected', 'true')
  const receipt = changed.selected?.effects.at(-1)
  if (!receipt?.laneId) throw new Error('The review provenance must identify its actual ledger lane')
  const facts = await session.factChain({ kind: 'tool', toolUseId: receipt.toolUseId }, receipt.laneId)
  expect(facts.nodes).toContainEqual(
    expect.objectContaining({ kind: 'invocation', toolUseId: receipt.toolUseId }),
  )
  await expect(page.locator('.trace-row[aria-current="true"]')).toContainText('Edit review.ts')
  await expect(page.locator('.trace-inspector')).toHaveAttribute('data-kind', 'tool')
  await expect(page.locator('.trace-inspector [data-link="receipt"]')).toBeVisible()
  await page.locator('#view-chat').click()
  await workbenchTab(page, 'changed-files')
  await page.setViewportSize({ width: 375, height: 812 })
  await page.getByTestId('workbench-tab-changed-files').press('Escape')
  await expect(panel).toBeHidden()
  await expect(page.getByTestId('workbench-right-toggle')).toBeFocused()
  expect(await readFile(join(runtime.workspace, 'review.ts'), 'utf8')).toBe('export const answer = 99\n')
})

test.describe('server sidebar pagination', () => {
  test.describe.configure({ timeout: 300_000 })
  test('sidebar pages five sessions from the real daemon and retains an off-page selected session', async ({
    page,
    runtime,
  }) => {
    test.setTimeout(300_000)
    const client = await runtime.connect()
    const ids: string[] = []
    for (let index = 0; index < 11; index++) {
      const session = await client.session.new({
        sessionKey: randomUUID(),
        cwd: runtime.workspace,
        preset: 'standard',
        permission: 'full-access',
      })
      ids.push(session.id)
      await client.session.rename(session.id, `Paging task ${index}`)
    }
    const groups = await client.session.groups()
    const group = groups.items.find((item) => item.total === 11)
    expect(group?.ready).toBe(true)
    if (!group) throw new Error('missing session group')
    const first = await client.session.list({ sidebar: { groupId: group.groupId }, limit: 5 })
    expect(first.items).toHaveLength(5)
    const selected = ids.find((id) => !first.items.some((row) => row.sessionId === id))!
    await page.goto(`${runtime.url}/?session=${selected}`)
    await expect(page.locator('.session-row')).toHaveCount(5)
    await expect(page.locator(`[data-session-action-id="${selected}"]`)).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: 'Task content', exact: true })).toBeEnabled()
    const more = page.getByTestId('workspace-sessions-toggle')
    await more.click()
    await expect(page.locator('.session-row')).toHaveCount(10)
    await more.click()
    await expect(page.locator('.session-row')).toHaveCount(11)
    await more.click()
    await expect(page.locator('.session-row')).toHaveCount(5)
    // The project heading folds its sessions; the Workspaces section heading above it is not the target.
    const project = page.locator('.workspace-group .workspace-heading')
    await expect(project).toHaveAttribute('aria-expanded', 'true')
    await project.click()
    await expect(page.locator('.session-row')).toHaveCount(0)
    await project.click()
    await expect(page.locator('.session-row')).toHaveCount(5)
    expect(new URL(page.url()).searchParams.get('session')).toBe(selected)
  })
})
