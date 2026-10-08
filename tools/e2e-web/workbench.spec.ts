import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
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

test('goal panel follows durable progress and shares authorized human controls', async ({
  page,
  runtime,
}, info) => {
  test.setTimeout(180_000)
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
  await page.getByTestId('workbench-tab-goal').click()
  const panel = page.getByTestId('goal-panel')
  await expect(panel).toContainText('Create a goal')
  await page.getByTestId('goal-toggle').click()
  await page.getByTestId('goal-objective').fill('Review the synthetic delivery')
  await page.getByTestId('goal-max-rounds').fill('1')
  await page.getByTestId('goal-save').click()
  await expect(panel.getByTestId('goal-panel-phase')).toHaveText('Blocked goal', { timeout: 30_000 })
  await expect(page.getByTestId('goal-toggle')).toHaveAttribute('aria-expanded', 'false')
  await expect(panel.getByTestId('goal-panel-objective')).toHaveText('Review the synthetic delivery')
  await expect(panel.getByTestId('goal-panel-progress')).toContainText('1 of 1')
  await expect(panel.getByTestId('goal-reason')).toContainText('maximum automatic rounds')
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
  await panel.getByTestId('goal-panel-resume').click()
  await expect(panel.getByTestId('goal-panel-phase')).toHaveText('Blocked goal', { timeout: 30_000 })
  expect((await snapshot())?.revision).toBeGreaterThan(initial?.revision ?? 0)
  await translated(page)
  await accessible(page, info, 'goal-panel')
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
          await page.getByTestId('workbench-tab-goal').click()
          await expect(panel.getByTestId('goal-panel-objective')).toHaveText('Review the synthetic delivery')
          await translated(page)
          await settled(page)
          await page.screenshot({ path: join(folder, `p3-${locale}-${theme}-${width}-after.png`) })
          await page.getByTestId('workbench-right-toggle').click()
          await page.screenshot({ path: join(folder, `p3-${locale}-${theme}-${width}-before.png`) })
          await page.getByTestId('workbench-right-toggle').click()
        }
    await page.evaluate(() => {
      localStorage.setItem('agnes-locale', 'en')
      localStorage.setItem('agnes-theme', 'light')
    })
    await page.reload()
    await page.getByTestId('workbench-tab-goal').click()
  }
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
  await expect(panel).toContainText('Create a goal')
  expect(await snapshot()).toBeUndefined()
})

test('changed files review follows confirmed agent effects and preserves current file authority', async ({
  page,
  runtime,
}, info) => {
  test.setTimeout(180_000)
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
  await page.getByTestId('workbench-tab-files').click()
  await page.getByTestId('files-panel').locator('[data-path="review.ts"]').click()
  await expect(page.getByTestId('file-preview')).toContainText('answer = 2')
  const preview = await session.workspaceRead('review.ts')
  await page.getByTestId('file-review').click()
  const panel = page.getByTestId('changes-panel')
  await expect(page.getByTestId('workbench-tab-changed-files')).toHaveAttribute('aria-selected', 'true')
  await expect(panel.getByTestId('changes-diff')).toContainText('+export const answer = 2')
  await expect(panel.getByTestId('changed-file')).toContainText('+1')
  await expect(panel.getByTestId('changed-file')).toContainText('−0')
  await translated(page)
  await accessible(page, info, 'changed-files-review')
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
          await page.getByTestId('workbench-tab-changed-files').click()
          await panel.getByTestId('changed-file').filter({ hasText: 'review.ts' }).click()
          await expect(panel.getByTestId('changes-diff')).toContainText('+export const answer = 2')
          await translated(page)
          await page.screenshot({ path: join(folder, `p4-${locale}-${theme}-${width}-after.png`) })
          await page.getByTestId('workbench-right-toggle').click()
          await page.screenshot({ path: join(folder, `p4-${locale}-${theme}-${width}-before.png`) })
          await page.getByTestId('workbench-right-toggle').click()
        }
    await page.evaluate(() => {
      localStorage.setItem('agnes-locale', 'en')
      localStorage.setItem('agnes-theme', 'light')
    })
    await page.reload()
    await page.getByTestId('workbench-tab-files').click()
    await page.getByTestId('files-panel').locator('[data-path="review.ts"]').click()
    await page.getByTestId('file-review').click()
    await expect(panel.getByTestId('changes-diff')).toContainText('+export const answer = 2')
  }
  // An external human change is never rolled into the agent's historical diff.
  await writeFile(join(runtime.workspace, 'review.ts'), 'export const answer = 99\n')
  await page.getByTestId('changes-refresh').click()
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
  await expect(composer).toHaveValue('"review.ts"')
  expect(await readFile(join(runtime.workspace, 'review.ts'), 'utf8')).toBe('export const answer = 99\n')
  await panel.locator('.workbench-change-evidence > summary').click()
  await panel.getByTestId('changes-provenance').last().click()
  await expect(page.getByRole('tab', { name: 'Trace', exact: true })).toHaveAttribute('aria-selected', 'true')
  const view = await session.projectUI(undefined, { surface: 'web' })
  const receipt = changed.selected?.effects.at(-1)
  const node = view.nodes.find((node) => node.kind === 'tool' && node.seq === receipt?.callSeq)
  if (!node) throw new Error('The review provenance must identify a durable tool node')
  await expect(page.locator('#trace-panel [aria-current=true]')).toHaveAttribute('data-trace-row-id', node.id)
  await expect(page.locator('.trace-inspector')).toContainText('edit')
  await page.getByRole('tab', { name: 'Conversation', exact: true }).click()
  await page.setViewportSize({ width: 375, height: 812 })
  await page.getByTestId('workbench-tab-changed-files').press('Escape')
  await expect(panel).toBeHidden()
  await expect(page.getByTestId('workbench-right-toggle')).toBeFocused()
  expect(await readFile(join(runtime.workspace, 'review.ts'), 'utf8')).toBe('export const answer = 99\n')
})
