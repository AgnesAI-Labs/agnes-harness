import { access, mkdir, readFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, test } from './fixtures.js'
import { accessible, settled, translated } from './quality.js'
import { toolResult } from './sdk.js'
import { chooseWorkspace, fresh, turn } from './ui.js'

test('workspace dock previews and mentions a file that the agent reads', async ({ page, runtime }, info) => {
  test.setTimeout(120_000)
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
  await files.locator('[data-path="report.md"]').click()
  await expect(page.getByTestId('file-preview')).toContainText('Synthetic delivery')
  await page.getByTestId('file-mention').click()
  await expect(page.getByRole('textbox', { name: 'Task content', exact: true })).toHaveValue('"report.md"')
  await turn(page, 'call read {"path":"report.md"}')
  const client = await runtime.connect()
  const id = new URL(page.url()).searchParams.get('session')
  if (!id) throw new Error('The session URL must identify the workspace session')
  const session = await client.session.load(id, { cwd: runtime.workspace })
  expect(JSON.stringify(await toolResult(session, 'read'))).toContain('Synthetic delivery')
  await translated(page)
  await accessible(page, info, 'workspace-files')
  const folder = process.env.AGH_WORKBENCH_REPORT
  if (folder) {
    await mkdir(folder, { recursive: true })
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
          await expect(page.locator('.workbench-files-footer details')).toBeVisible()
          await expect(page.locator('.workbench-file-preview summary')).not.toContainText(/T\d{2}:/)
          await page.screenshot({ path: join(folder, `p1-${locale}-${theme}-${width}-after.png`) })
          await page.getByTestId('workbench-right-toggle').click()
          await page.screenshot({ path: join(folder, `p1-${locale}-${theme}-${width}-before.png`) })
          await page.getByTestId('workbench-right-toggle').click()
        }
  }
  await page.setViewportSize({ width: 375, height: 812 })
  await expect(files).toBeVisible()
  await page.getByTestId('workbench-tab-files').press('Escape')
  await expect(files).toBeHidden()
  await expect(page.getByTestId('workbench-right-toggle')).toBeFocused()
})

test('session terminal survives UI detachment, follows agent output and honors preset denials', async ({
  page,
  runtime,
}, info) => {
  test.setTimeout(240_000)
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
  await page.getByTestId('workbench-bottom-toggle').click()
  const panel = page.getByTestId('terminal-panel')
  const resize = page.locator('#workbench-bottom .workbench-resize')
  for (let i = 0; i < 8; i++) await resize.press('ArrowUp')
  await panel
    .getByRole('button', { name: /Attach.*Agent/ })
    .first()
    .click()
  await expect(panel.getByTestId('workbench-terminal-output')).toHaveValue(/AGENT_END/)
  await expect(panel.getByTestId('terminal-kill')).toHaveCount(0)
  await panel.getByTestId('terminal-tab-close').click()
  await panel.getByTestId('terminal-new').click()
  const output = panel.getByTestId('workbench-terminal-output')
  await expect(output).toBeVisible()
  const human = (await session.jobsRead()).jobs.find((job) => job.owner === 'human')
  if (!human) throw new Error('human terminal required')
  await output.pressSequentially("printf 'WB1_TERMINAL_OK\\n'")
  await output.press('Enter')
  await expect(output).toHaveValue(/WB1_TERMINAL_OK\r?\n/)
  await panel.getByTestId('terminal-new').click()
  await expect(panel.getByRole('tab')).toHaveCount(2)
  await panel.getByRole('tab').last().press('ArrowLeft')
  await expect(panel.getByRole('tab').first()).toBeFocused()
  await page.getByTestId('workbench-bottom-toggle').click()
  expect((await session.jobsRead(human.id)).job?.status).toBe('running')
  await session.detach()
  expect((await session.jobsRead(human.id)).job?.status).toBe('running')
  await page.reload()
  await page.getByTestId('workbench-bottom-toggle').click()
  await expect(panel.getByRole('tab')).toHaveCount(2)
  await panel.getByRole('tab').first().click()
  await expect(output).toHaveValue(/WB1_TERMINAL_OK/)
  await panel.getByTestId('terminal-interrupt').click()
  expect((await session.jobsRead(human.id)).job?.status).toBe('running')
  await output.pressSequentially("printf 'WB1_AFTER_INTERRUPT\\n'")
  await output.press('Enter')
  await expect(output).toHaveValue(/WB1_AFTER_INTERRUPT\r?\n/)
  await translated(page)
  await accessible(page, info, 'workbench-terminal')
  const folder = process.env.AGH_WORKBENCH_REPORT
  if (folder) {
    await mkdir(folder, { recursive: true })
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
          await expect(panel.getByRole('tab')).toHaveCount(2)
          await expect(output).toHaveValue(/WB1_AFTER_INTERRUPT/)
          await settled(page)
          await page.screenshot({ path: join(folder, `p2-${locale}-${theme}-${width}-after.png`) })
          await page.getByTestId('workbench-bottom-toggle').click()
          await page.screenshot({ path: join(folder, `p2-${locale}-${theme}-${width}-before.png`) })
          await page.getByTestId('workbench-bottom-toggle').click()
        }
    await page.evaluate(() => {
      localStorage.setItem('agnes-locale', 'en')
      localStorage.setItem('agnes-theme', 'light')
    })
    await page.reload()
    await expect(output).toHaveValue(/WB1_AFTER_INTERRUPT/)
  }
  const second = await client.session.new({
    cwd: runtime.workspace,
    preset: 'full-access',
    sessionKey: 'wb1-terminal-other',
  })
  await expect(second.jobsControl({ operation: 'kill', jobId: human.id })).rejects.toMatchObject({
    data: { code: 'CAPABILITY_DENIED' },
  })
  const originalUrl = page.url(),
    otherUrl = new URL(originalUrl)
  otherUrl.searchParams.set('session', second.id)
  await page.goto(otherUrl.toString())
  await expect(panel.getByRole('tab')).toHaveCount(0)
  expect((await session.jobsRead(human.id)).job?.status).toBe('running')
  await page.goto(originalUrl)
  await expect(panel.getByRole('tab')).toHaveCount(2)
  await expect(session.setPreset('read-only')).rejects.toMatchObject({
    data: { code: 'PRESET_SWITCH_REJECTED' },
  })
  const readOnly = await client.session.new({
    cwd: runtime.workspace,
    preset: 'read-only',
    sessionKey: 'wb1-terminal-read-only',
  })
  await expect(readOnly.jobsControl({ operation: 'open' })).rejects.toMatchObject({
    data: { code: 'CAPABILITY_DENIED' },
  })
  expect((await readOnly.jobsRead()).jobs).toHaveLength(0)
  expect((await session.jobsRead()).jobs.filter((job) => job.owner === 'human')).toHaveLength(2)
  const sandboxed = await client.session.new({
    cwd: runtime.workspace,
    preset: 'workspace-write',
    sessionKey: 'wb1-terminal-sandbox',
  })
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
    text: `printf DENIED > '${outside}'; printf ALLOWED > wb1-terminal-inside.txt; printf 'WB1_BOUNDARY_DONE\\n'\n`,
  })
  await expect
    .poll(async () => (await sandboxed.jobsRead(workspaceJobId)).job?.stdout, { timeout: 30_000 })
    .toMatch(/\r?\nWB1_BOUNDARY_DONE\r?\n/)
  expect(await readFile(join(runtime.workspace, 'wb1-terminal-inside.txt'), 'utf8')).toBe('ALLOWED')
  await expect(access(outside)).rejects.toMatchObject({ code: 'ENOENT' })
  await sandboxed.jobsControl({ operation: 'kill', jobId: workspace.output.id })
  await panel.getByTestId('terminal-tab-close').click()
  await expect
    .poll(async () => (await session.jobsRead(human.id)).job?.status, { timeout: 30_000 })
    .toBe('killed')
  await expect(panel.getByRole('tab')).toHaveCount(1)
  await panel.getByRole('tab').first().click()
  await panel.getByTestId('terminal-kill').click()
  await expect(panel.getByRole('status').filter({ hasText: 'Killed' })).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('workbench-tab-terminal').press('Escape')
  await expect(panel).toBeHidden()
  await expect(page.getByTestId('workbench-bottom-toggle')).toBeFocused()
})
