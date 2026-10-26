import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AGH_DIR, type ArtifactReadResult } from '@agnes/protocol'
import type { Page } from '@playwright/test'
import { startProviderFixture } from '../acceptance/provider-fixture.js'
import { expect, test } from './fixtures.js'
import { accessible, screen, settled, translated } from './quality.js'
import type { Runtime } from './runtime.js'
import { install, prompt, toolResult } from './sdk.js'
import {
  chooseWorkspace,
  closeSettings,
  expand,
  expandActivityGroups,
  fresh,
  openGoal,
  pluginTab,
  preferences,
  section,
  selectValue,
  send,
  settings,
  sidebar,
  turn,
  workbenchTab,
} from './ui.js'

async function open(page: Page, runtime: Runtime) {
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
async function current(page: Page, runtime: Runtime) {
  const id = new URL(page.url()).searchParams.get('session')
  if (!id) throw new Error('UI must advertise the created session in its URL')
  const client = await runtime.connect()
  const session = await client.session.load(id, { cwd: runtime.workspace })
  await session.attach()
  return session
}
function surfaceCard(page: Page, title: string) {
  return page
    .getByRole('article', { name: title, exact: true })
    .and(page.locator('[data-placement="inline"]'))
}
async function workbenchSurface(page: Page, title: string) {
  if (title === 'Deliverables') {
    const tail = page.getByTestId('turn-deliverables').last()
    await expect(tail).toBeVisible()
    await tail.locator('.agh-list-row-title').first().click()
    const files = page.getByTestId('workbench-deliverables')
    await expect(files).toBeVisible()
    return files
  }
  const panel = page
    .getByTestId('intelligent-ui-panel')
    .locator('[data-testid^="ui-surface-"]')
    .filter({ hasText: title })
  if (!(await panel.isVisible())) {
    const inline =
      title === 'Deliverables' ? page.getByTestId('turn-deliverables').last() : surfaceCard(page, title)
    if (title === 'Deliverables') {
      await expect(inline).toBeVisible()
      await inline.getByTestId('deliverable-open').first().click()
      await expect(panel).toBeVisible()
      return panel
    }
    if (!(await inline.isVisible())) {
      await expect(inline).toBeAttached()
      const owner = inline.locator('xpath=ancestor::*[@data-testid="conversation-turn"][1]')
      await expand(owner.getByTestId('turn-process-toggle').locator('..'))
      const tool = inline
        .locator('xpath=ancestor::*[contains(@class,"timeline-node")][1]')
        .getByTestId('tool-detail-toggle')
      if ((await tool.count()) && (await tool.getAttribute('aria-expanded')) !== 'true') await tool.click()
    }
    if ((await inline.getAttribute('data-kind')) === 'deliverables')
      await inline.getByTestId('deliverable-open').first().click()
    else {
      if (!(await inline.getByTestId('ui-expand').count())) {
        await inline.locator('header .agh-menu-anchor button').click()
        await page.getByTestId('ui-expand').click()
      } else await inline.getByTestId('ui-expand').click()
    }
  }
  await expect(panel).toBeVisible()
  return panel
}
async function artifactText(page: Page, runtime: Runtime) {
  const session = await current(page, runtime)
  const presented = await toolResult(session, 'present')
  const artifact = presented?.artifactRefs?.[0]
  if (!artifact) throw new Error('Present must retain an artifact reference')
  const client = await runtime.connect()
  const result = await client.call<ArtifactReadResult>('_agnes/v1/artifact.read', {
    sessionId: session.id,
    laneId: 'main',
    artifact,
  })
  if (!result.ok) throw new Error('Authorized artifact read failed')
  return Buffer.from(result.base64, 'base64').toString('utf8')
}
async function quality(page: Page, info: Parameters<typeof accessible>[1], name: string) {
  await translated(page)
  await accessible(page, info, name)
}
async function detail(page: Page, tool: string, summary = tool) {
  await page.getByRole('textbox', { name: 'Task content', exact: true }).click()
  await settled(page)
  const session = page.getByTestId('conversation-turn').last()
  const process = session.getByTestId('turn-process-toggle')
  const card = session.locator(`[data-tool-name="${tool}"]`).last()
  const toggle = card.getByTestId('tool-detail-toggle')
  if (!(await process.evaluate((summary) => summary.parentElement?.getAttribute('data-open') === 'true')))
    await process.click()
  await expect
    .poll(() => process.evaluate((summary) => summary.parentElement?.getAttribute('data-open') === 'true'))
    .toBe(true)
  await expandActivityGroups(session)
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await expect(card).toContainText(summary)
  return card.getByTestId('tool-detail-text')
}

test('UI first run, Agent selection, demo read/cancel, account save and restart persistence', async ({
  page,
  runtime,
}, info) => {
  test.setTimeout(120_000)
  await open(page, runtime)
  await expect(page.getByTestId('composer-agent')).toBeEnabled()
  await expect(page.getByTestId('composer-agent')).toHaveAttribute('aria-label', 'More')
  await turn(page, 'call read {"path":"report.md"}')
  const demo = await current(page, runtime)
  expect(JSON.stringify(await toolResult(demo, 'read'))).toContain('Synthetic delivery')
  await expect(await detail(page, 'read', 'report.md')).toContainText('Synthetic delivery')
  // Cancellation must exercise an in-flight tool even when the OS command sandbox is unavailable.
  await install(await runtime.connect(), 'tools/e2e-web/fixtures/cancel-tool')
  await fresh(page)
  const cancelled = await send(page, 'call e2e_wait_for_cancel {}')
  await expect(cancelled).toHaveAttribute('data-status', 'running')
  await expect(cancelled.getByTestId('tool-detail-toggle')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel turn', exact: true }).click()
  await expect(cancelled).toHaveAttribute('data-status', 'cancelled')
  await turn(page, 'Recovered after explicit cancellation')
  await quality(page, info, 'demo-cancel')
  const client = await runtime.connect()
  const model = (await client.config.test({ providerId: 'deepseek' })).models[0]?.id
  if (!model) throw new Error('The installed provider catalog must supply a local fixture model')
  const provider = await startProviderFixture('UI_CREDENTIAL_PERSISTED', undefined, model)
  try {
    await settings(page)
    await page.getByTestId('settings-nav-model').click()
    await expect(page.locator('#config-accounts')).toHaveAttribute('data-state', 'empty')
    await page.locator('.config-accounts-welcome [data-provider="deepseek"]').click()
    const dialog = page.locator('.account-dialog-body[data-page="add"]')
    await expect(page.getByRole('region', { name: 'Connect DeepSeek', exact: true })).toBeVisible()
    await expect(dialog).toHaveAttribute('data-account-step', 'connection')
    await expect(dialog.locator('#config-provider-name')).toHaveText('DeepSeek')
    await expand(dialog.locator('#config-account-advanced'))
    await accessible(page, info, 'account-connection')
    await dialog.getByRole('textbox', { name: 'Account name', exact: true }).fill('Offline UI account')
    await dialog.getByRole('textbox', { name: 'Base URL', exact: true }).fill(provider.baseUrl)
    await dialog.locator('#config-api-key').fill(provider.apiKey)
    for (const [key, seconds] of [
      ['requestMs', '90'],
      ['connectMs', '4'],
      ['streamIdleMs', '15'],
    ]) {
      await selectValue(page, `account-network-${key}`, 'custom')
      await dialog.getByTestId(`account-network-${key}-custom`).fill(seconds!)
      await dialog.getByTestId(`account-network-${key}-custom`).blur()
    }
    await expect(dialog.locator('#config-state')).toContainText('Connected.')
    await accessible(page, info, 'account-connected')
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(page.locator('#config-accounts')).toHaveAttribute('data-state', 'ready')
    const saved = await client.config.get()
    expect(saved.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Offline UI account',
          credentialConfigured: true,
          networkTimeouts: { requestMs: 90000, connectMs: 4000, streamIdleMs: 15000 },
        }),
      ]),
    )
    expect(JSON.stringify(saved)).not.toContain(provider.apiKey)
    await closeSettings(page)
    await fresh(page)
    await turn(page, 'Use the account saved through the UI')
    await expect(page.getByTestId('conversation-turn').last()).toContainText('UI_CREDENTIAL_PERSISTED')
    const url = page.url()
    await page.goto('about:blank')
    await runtime.restart()
    expect(
      (await (await runtime.connect()).config.get()).accounts?.find(
        (row) => row.label === 'Offline UI account',
      )?.networkTimeouts,
    ).toEqual({ requestMs: 90000, connectMs: 4000, streamIdleMs: 15000 })
    await page.goto(url)
    await expect(page.getByTestId('conversation-turn')).toContainText('UI_CREDENTIAL_PERSISTED')
    await turn(page, 'Use the same stored credential after restart')
    await expect(page.getByTestId('conversation-turn').last()).toContainText('UI_CREDENTIAL_PERSISTED')
    await quality(page, info, 'account-restarted-session')
  } finally {
    await provider.close()
  }
})

test('UI MCP stdio and skills slash reach the real host', async ({ page, runtime }, info) => {
  test.setTimeout(120_000)
  await runtime.cli([
    'mcp',
    'add',
    'e2e',
    '--name',
    'E2E stdio',
    '--stdio',
    'node',
    '--arg',
    resolve('tools/e2e-web/fixtures/mcp.mjs'),
    '--sandbox-profile',
    'off-with-warning',
    '--yes',
  ])
  const revision = async () => {
    const stored = await runtime.cli(['mcp', 'get', 'e2e'])
    expect(stored).toContain('sandbox=off-with-warning')
    const value = /revision=([a-f0-9]{64})/.exec(stored)?.[1]
    if (!value) throw new Error('MCP must supply a reviewed revision')
    return value
  }
  await runtime.cli(['mcp', 'trust', 'e2e', '--expected-revision', await revision(), '--yes'])
  await runtime.cli(['mcp', 'enable', 'e2e', '--expected-revision', await revision(), '--yes'])
  const client = await runtime.connect()
  const model = (await client.config.test({ providerId: 'deepseek' })).models[0]?.id
  if (!model) throw new Error('The local provider catalog must contain a model')
  const provider = await startProviderFixture(
    'E2E_SKILL_RESPONSE',
    { name: 'tool_describe', args: { name: 'mcp__e2e__echo' } },
    model,
  )
  provider.queueTool({ name: 'mcp__e2e__echo', args: { text: 'UI_MCP_STDIO' } })
  try {
    const config = await client.config.get()
    await client.config.save({
      providerId: 'deepseek',
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model,
      accountId: 'skill-fixture',
      label: 'Synthetic skill fixture',
      expectedRevision: config.revision,
      makeDefault: true,
    })
    await open(page, runtime)
    await turn(page, 'Invoke the configured MCP stdio fixture')
    const session = await current(page, runtime)
    expect(JSON.stringify(await toolResult(session, 'tool_describe'))).toContain('mcp__e2e__echo')
    expect(provider.requests.some(({ tools }) => tools.includes('mcp__e2e__echo'))).toBe(true)
    expect((await toolResult(session, 'mcp__e2e__echo'))?.content).toEqual([
      { type: 'text', text: 'UI_MCP_STDIO' },
    ])
    await expect(await detail(page, 'mcp__e2e__echo')).toContainText('UI_MCP_STDIO')
    await settings(page)
    await section(page, 'mcp')
    await expect(page.getByRole('switch', { name: /E2E stdio/ })).toBeChecked()
    await quality(page, info, 'mcp-enabled')
    await section(page, 'skills')
    await page.getByRole('button', { name: 'Refresh skills', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Confirm action', exact: true })
      .getByRole('button', { name: 'Confirm', exact: true })
      .click()
    await expect(
      page.getByRole('button', { name: 'View details for e2e-playbook', exact: true }),
    ).toBeVisible()
    await quality(page, info, 'skills-discovered')
    await closeSettings(page)
    await turn(page, '/skill invoke e2e-playbook Verify the preloaded instructions')
    await expect(page.getByTestId('conversation-turn').last()).toContainText('E2E_SKILL_RESPONSE')
    expect(
      provider.requests.some(
        ({ messages, tools }) => tools.length > 0 && JSON.stringify(messages).includes('E2E_SKILL_LOADED'),
      ),
    ).toBe(true)
    await quality(page, info, 'skills-slash')
  } finally {
    await provider.close()
  }
})

test('UI ask, plan approval, deliverable, child and goal cards perform their actions', async ({
  page,
  runtime,
}, info) => {
  test.setTimeout(120_000)
  await open(page, runtime)
  await turn(
    page,
    'call ask_user_question {"questions":[{"id":"channel","question":"Choose a delivery channel","options":["Web","Email"],"allowFreeText":true}]}',
  )
  const question = page.getByTestId('question-card')
  await expect(question).toContainText('Choose a delivery channel')
  await question.getByRole('radio', { name: 'Web', exact: true }).check()
  await quality(page, info, 'ask-card')
  await question.getByTestId('question-submit').click()
  await expect(question).toBeHidden()
  await expect(page.getByTestId('question-answers')).toContainText('Web')
  await expect(page.getByTestId('conversation-turn').last()).toHaveAttribute('data-status', 'completed')
  const composer = page.getByRole('textbox', { name: 'Task content', exact: true })
  await composer.fill('/plan Inspect the workspace before writing')
  const planWrite = page.waitForResponse(
    (response) => response.url().endsWith('/api/plan-mode') && response.request().method() === 'POST',
  )
  await composer.press('Enter')
  expect((await planWrite).ok()).toBe(true)
  await expect
    .poll(
      async () =>
        JSON.parse(await readFile(resolve(runtime.workspace, AGH_DIR, 'plan-mode.json'), 'utf8')).active,
    )
    .toBe(true)
  const planned = await send(
    page,
    `call exit_plan_mode ${JSON.stringify({ plan: '# E2E approved plan\nRead report.md, then prepare the delivery.' })}`,
  )
  const approval = page.getByTestId('plan-approval-card')
  await expect(approval).toContainText('E2E approved plan')
  await quality(page, info, 'plan-approval')
  await approval.getByRole('button', { name: 'Allow once', exact: true }).click()
  await expect(planned).toHaveAttribute('data-status', 'completed')
  expect(
    JSON.parse(await readFile(resolve(runtime.workspace, AGH_DIR, 'plan-mode.json'), 'utf8')).active,
  ).toBe(false)
  await turn(
    page,
    `call present ${JSON.stringify({ files: [{ path: resolve(runtime.workspace, 'report.md') }] })}`,
  )
  const card = await workbenchSurface(page, 'Deliverables')
  await expect(card).toContainText('report.md')
  expect(await artifactText(page, runtime)).toContain('Synthetic delivery')
  await quality(page, info, 'deliverable-surface')
  await turn(page, 'call tool_describe {"name":"subagent_spawn"}')
  await turn(
    page,
    `call subagent_spawn ${JSON.stringify({ task: 'call read {"path":"report.md"}', isolation: 'shared' })}`,
  )
  const session = await current(page, runtime)
  const spawned = await toolResult(session, 'subagent_spawn')
  const receipt = spawned?.content.find((block) => block.type === 'text')
  const childKey = receipt?.type === 'text' ? /^started (\S+);/.exec(receipt.text)?.[1] : undefined
  if (!childKey) throw new Error('Child spawn must return a durable child key')
  await expect(page.getByTestId('child-agent-card')).toBeVisible()
  await turn(page, 'call tool_describe {"name":"subagent_collect"}')
  await turn(page, `call subagent_collect ${JSON.stringify({ childKey, wait: true })}`)
  expect(JSON.stringify(await toolResult(session, 'subagent_collect'))).toContain('Synthetic delivery')
  await quality(page, info, 'child-card')
  await openGoal(page)
  await page.getByTestId('goal-objective').fill('E2E finish the inspected delivery')
  await page.getByTestId('goal-max-rounds').fill('1')
  const goalPhase = async () => {
    const timeline = await session.projectUI(undefined, { surface: 'web' })
    const fill = timeline.slots?.find((fill) => fill.extId === 'agnes/goal' && fill.slot === 'status.line')
    return (fill?.payload as { goal?: { phase: string } } | undefined)?.goal?.phase
  }
  const goalForm = page.getByTestId('goal-card').locator('form')
  await settled(page)
  expect(await goalForm.evaluate((form) => form instanceof HTMLFormElement && form.checkValidity())).toBe(
    true,
  )
  await page.getByTestId('goal-save').click()
  await expect.poll(goalPhase).toBe('blocked')
  await page.keyboard.press('Escape')
  await workbenchTab(page, 'goal')
  await expect(page.getByTestId('goal-panel-phase')).toHaveAttribute('data-phase', 'blocked')
  await expect(page.getByTestId('goal-panel-objective')).toHaveText('E2E finish the inspected delivery')
  await openGoal(page)
  await expect(page.getByTestId('goal-complete')).toBeEnabled()
  await quality(page, info, 'goal-card')
  await page.getByTestId('goal-complete').click()
  await expect(page.getByTestId('goal-complete')).toHaveCount(0)
  await expect.poll(goalPhase).toBe('complete')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('goal-panel-phase')).toHaveAttribute('data-phase', 'complete')
})

test('UI background jobs and schedule cards persist observable results', async ({ page, runtime }, info) => {
  test.setTimeout(120_000)
  await open(page, runtime)
  await turn(page, 'call shell {"command":"printf E2E_JOB_OK","background":true}')
  const session = await current(page, runtime)
  await toolResult(session, 'shell')
  await turn(page, 'call tool_describe {"name":"job_list"}')
  await turn(page, 'call job_list {}')
  await expect(page.getByTestId('background-job-card').first()).toBeVisible()
  await quality(page, info, 'background-job-card')
  await turn(page, 'call tool_describe {"name":"schedule_create"}')
  await turn(
    page,
    'call schedule_create {"title":"E2E tool reminder","prompt":"Inspect delivery","target":"current_session","selector":{"every_seconds":86400}}',
  )
  await expect(await workbenchSurface(page, 'Reminders')).toContainText('E2E tool reminder')
  await quality(page, info, 'schedule-card')
  await settings(page)
  await section(page, 'jobs')
  const terminal = page.getByTestId('terminal-panel')
  await expect(terminal).toBeVisible()
  await terminal.getByTestId('terminal-tab').filter({ hasText: 'E2E_JOB_OK' }).click()
  const job = (await session.jobsRead()).jobs.find((row) => row.command.includes('E2E_JOB_OK'))
  if (!job) throw new Error('Completed agent job required')
  expect(job.status).toBe('completed')
  await expect(
    page.getByTestId('workbench-terminal-output').locator('.xterm-accessibility-tree'),
  ).toContainText(`Process exited (${job.code})`)
  await expect(
    page.getByTestId('workbench-terminal-output').locator('.xterm-accessibility-tree'),
  ).toContainText('E2E_JOB_OK')
  // The interactive PTY flow is covered in workbench.spec.ts, where terminals now live.
  await section(page, 'schedules')
  await expect(page.getByTestId('schedules-row')).toContainText('E2E tool reminder')
  await page.getByTestId('schedules-new').click()
  await page.getByTestId('schedules-title').fill('E2E UI reminder')
  await page.getByTestId('schedules-prompt').fill('Review the synthetic delivery')
  await page.getByTestId('schedules-kind-every').click()
  await page.getByTestId('schedules-when').fill('24')
  await selectValue(page, 'schedules-unit', 'hours')
  await page.getByTestId('schedules-create').click()
  const scheduled = page.getByTestId('schedules-row').filter({ hasText: 'E2E UI reminder' })
  await expect(scheduled).toBeVisible()
  await scheduled.getByTestId('schedules-actions').click()
  await page.getByTestId('schedules-archive').click()
  await page.getByTestId('schedules-archive-cancel').click()
  await expect(scheduled).toBeVisible()
  await scheduled.getByTestId('schedules-actions').click()
  await page.getByTestId('schedules-archive').click()
  await page.getByTestId('schedules-archive-confirm').click()
  await expect(scheduled).toHaveCount(0)
  await quality(page, info, 'schedules-after-archive')
})

test('UI folder install reviews capabilities, enables a tool and disables it for new sessions', async ({
  page,
  runtime,
}, info) => {
  test.setTimeout(180_000)
  await open(page, runtime)
  await settings(page)
  await section(page, 'plugins')
  await page.getByTestId('plugin-install-source').click()
  const source = page.getByRole('dialog', { name: 'Check a plugin source', exact: true })
  await info.attach('source-dialog.txt', { body: await source.ariaSnapshot(), contentType: 'text/plain' })
  await source.getByRole('combobox', { name: 'Source type', exact: true }).selectOption('file')
  await source
    .getByRole('textbox', { name: 'Source reference', exact: true })
    .fill(`file:${resolve('examples/packages/hot-tool-plugin')}`)
  await source.getByRole('button', { name: 'Check source', exact: true }).click()
  const review = page.getByTestId('install-review')
  await expect(review).toContainText('What it gets')
  await expect(review).toContainText('Text statistics tool')
  await expect(review).toContainText('sha256-')
  const client = await runtime.connect()
  expect(
    (await client.packages.list({ profile: 'local-dev' })).packages.some(
      (row) => row.id === '@agnes-examples/hot-tool-plugin',
    ),
  ).toBe(false)
  await quality(page, info, 'capability-review')
  await review.getByRole('button', { name: 'Install only', exact: true }).click()
  await expect(review).toBeHidden()
  const detailPage = page.locator('#plugin-detail')
  if (await detailPage.isVisible()) await page.getByTestId('push-back').click()
  await page
    .locator('.plugin-row[data-plugin-id="@agnes-examples/hot-tool-plugin"]')
    .getByRole('switch')
    .click()
  await page
    .getByRole('dialog', { name: 'Enable “Text statistics tool”', exact: true })
    .getByRole('button', { name: 'Trust and enable', exact: true })
    .click()
  await expect
    .poll(
      async () =>
        (await client.packages.list({ profile: 'local-dev' })).packages.find(
          (row) => row.id === '@agnes-examples/hot-tool-plugin',
        )?.actual,
    )
    .toBe('running')
  if (await detailPage.isVisible()) await page.getByTestId('push-back').click()
  const toggle = page
    .locator('.plugin-row[data-plugin-id="@agnes-examples/hot-tool-plugin"]')
    .getByRole('switch')
  await expect(toggle).toBeChecked()
  await page
    .getByRole('searchbox', { name: 'Search plugins', exact: true })
    .fill('@agnes-examples/hot-tool-plugin')
  const installedRow = page.locator('.plugin-row[data-plugin-id="@agnes-examples/hot-tool-plugin"]')
  await expect(installedRow).toHaveCount(1)
  await expect(installedRow.getByRole('heading')).toHaveText('Text statistics tool')
  await screen(page, info, 'plugin-cards-en-light')
  await closeSettings(page)
  await fresh(page)
  await turn(page, 'call demo_text_stats {"text":"hello world"}')
  const old = await current(page, runtime)
  expect((await toolResult(old, 'demo_text_stats'))?.structured).toEqual({ characters: 11, words: 2 })
  await expect(page.getByTestId('conversation-turn').last()).toContainText('demo_text_stats')
  await settings(page)
  await section(page, 'plugins')
  await toggle.click()
  await page
    .getByRole('dialog', { name: 'Disable “Text statistics tool”?', exact: true })
    .getByRole('button', { name: 'Disable', exact: true })
    .click()
  await expect
    .poll(
      async () =>
        (await client.packages.list({ profile: 'local-dev' })).packages.find(
          (row) => row.id === '@agnes-examples/hot-tool-plugin',
        )?.desired,
    )
    .toBe('installed-disabled')
  if (await detailPage.isVisible()) await page.getByTestId('push-back').click()
  await expect(
    page.locator('.plugin-row[data-plugin-id="@agnes-examples/hot-tool-plugin"]').getByRole('switch'),
  ).not.toBeChecked()
  await closeSettings(page)
  await fresh(page)
  await turn(page, 'A new session after disabling the plugin')
  const newer = await current(page, runtime)
  expect((await newer.tools()).tools.some((tool) => tool.name === 'demo_text_stats')).toBe(false)
  await page.goto(new URL(`/?session=${encodeURIComponent(old.id)}`, runtime.url).href)
  await expect(page.getByTestId('conversation-turn')).toContainText('hello world')
  await turn(page, 'call demo_text_stats {"text":"old session remains bound"}')
  const resumed = await current(page, runtime)
  expect(resumed.id).toBe(old.id)
  expect((await toolResult(resumed, 'demo_text_stats'))?.structured).toMatchObject({ words: 4 })
  // Inspect the real pinned old version in both languages/themes before creating another session.
  for (const [locale, theme] of [
    ['en', 'light'],
    ['en', 'dark'],
    ['zh-CN', 'light'],
    ['zh-CN', 'dark'],
  ] as const) {
    await preferences(page, locale, theme)
    await page.goto(new URL(`/?session=${encodeURIComponent(old.id)}`, runtime.url).href)
    await expect(page.getByTestId('conversation-turn')).toHaveCount(2)
    await settings(page, locale)
    await section(page, 'plugins')
    await page
      .getByRole('searchbox', { name: locale === 'en' ? 'Search plugins' : '搜索插件', exact: true })
      .fill('hot-tool-plugin')
    await expect(page.getByTestId('plugin-drain-summary')).toHaveCount(0)
    const row = page.locator('.plugin-row[data-plugin-id="@agnes-examples/hot-tool-plugin"]')
    const retained = (await client.packages.list({ profile: 'local-dev' })).packages.find(
      (item) => item.id === '@agnes-examples/hot-tool-plugin',
    )
    expect(retained?.primaryStatus?.state).toBe('historical-only')
    await expect(row.getByTestId('plugin-primary-status')).toHaveAttribute('data-state', 'historical-only')
    await expect(row.getByTestId('plugin-status-reason')).toHaveText(retained!.primaryStatus!.reason[locale])
    await page.mouse.move(0, 0)
    await quality(page, info, `plugin-old-version-${locale}-${theme}`)
    await screen(page, info, `plugin-old-version-${locale}-${theme}`)
    await page
      .locator('.plugin-row[data-plugin-id="@agnes-examples/hot-tool-plugin"] .plugin-details-button')
      .click()
    await pluginTab(page, 'versions').click()
    const technical = page.getByTestId('plugin-drain-details')
    await expect(technical).toHaveAttribute('data-open', 'false')
    const pinned = (await client.packages.generations({ profile: 'local-dev' })).generations.find(
      (generation) =>
        generation.state === 'draining' &&
        generation.packages.some((item) => item.id === '@agnes-examples/hot-tool-plugin'),
    )
    expect(pinned).toBeDefined()
    await expect(technical.locator('code')).toHaveText(`@agnes-examples/hot-tool-plugin · ${pinned!.id}`)
    const summary = page.getByTestId('plugin-drain-summary')
    await expect(summary).toHaveCount(1)
    await expect(summary).toContainText(
      locale === 'en' ? '1 open sessions retain their versions.' : '1 个已打开的会话继续保留各自版本。',
    )
    await expect(summary).not.toContainText('@agnes/')
    const details = page.getByTestId('plugin-drain-details')
    await expect(details).toHaveAttribute('data-open', 'false')
    await expand(details)
    await expect(details).toContainText('hot-tool-plugin')
    expect(
      (await details.locator('code').allTextContents()).some((text) =>
        /^@agnes\/(ai|base|code) ·/.test(text),
      ),
    ).toBe(false)
    await page.getByTestId('push-back').click()
    await page
      .getByRole('searchbox', { name: locale === 'en' ? 'Search plugins' : '搜索插件', exact: true })
      .fill('plugin-helper')
    await page.locator('.plugin-row[data-plugin-id="@agnes/plugin-helper"] .plugin-details-button').click()
    await pluginTab(page, 'versions').click()
    const helperSummary = page.getByTestId('plugin-drain-summary')
    await expect(helperSummary).toHaveCount(1)
    await expand(page.getByTestId('plugin-drain-details'))
    await expect(page.getByTestId('plugin-drain-details')).toContainText(
      locale === 'en' ? 'Plugin helper' : '插件助手',
    )
    await page.getByTestId('push-back').click()
    await closeSettings(page, locale)
  }
})

test('UI local rescan preserves old/new code through a daemon restart', async ({ page, runtime }, info) => {
  test.setTimeout(120_000)
  await open(page, runtime)
  const rescan = async (version: number) => {
    await runtime.localTool(version)
    await settings(page)
    await section(page, 'diagnostics')
    await expand(page.getByTestId('plugin-diagnostics'))
    await expand(page.getByTestId('runtime-local'))
    await expand(page.getByTestId('local-plugins'))
    await page.getByTestId('reload-local-plugins').click()
    await expect(page.getByTestId('reload-local-plugins')).toBeEnabled()
    await closeSettings(page)
  }
  await rescan(1)
  await fresh(page)
  await turn(page, 'call e2e_version {"text":"old"}')
  const old = await current(page, runtime)
  expect((await toolResult(old, 'e2e_version'))?.structured).toMatchObject({ version: 1 })
  await rescan(2)
  await fresh(page)
  await turn(page, 'call e2e_version {"text":"new"}')
  const newer = await current(page, runtime)
  expect((await toolResult(newer, 'e2e_version'))?.structured).toMatchObject({ version: 2 })
  expect(newer.id).not.toBe(old.id)
  // Rescan must preserve an already-bound session before recovery is involved.
  await page.goto(new URL(`/?session=${encodeURIComponent(old.id)}`, runtime.url).href)
  await expect(page.getByTestId('conversation-turn')).toHaveCount(1)
  await turn(page, 'call e2e_version {"text":"still old"}')
  expect((await toolResult(await current(page, runtime), 'e2e_version'))?.structured).toMatchObject({
    version: 1,
  })
  await page.goto('about:blank')
  await runtime.restart()
  for (const [session, version] of [
    [old, 1],
    [newer, 2],
  ] as const) {
    await page.goto(new URL(`/?session=${encodeURIComponent(session.id)}`, runtime.url).href)
    await expect(page.getByTestId('conversation-turn')).toHaveCount(version === 1 ? 2 : 1)
    await turn(page, 'call e2e_version {"text":"restored"}')
    const restored = await current(page, runtime)
    expect((await toolResult(restored, 'e2e_version'))?.structured).toMatchObject({ version })
    await expect(await detail(page, 'e2e_version')).toContainText(`"version":${version}`)
  }
  await info.attach('generations.json', {
    body: JSON.stringify(await (await runtime.connect()).packages.generations({ profile: 'local-dev' })),
    contentType: 'application/json',
  })
  await quality(page, info, 'restarted-generations')
})

test('UI FDE bundle selection runs and restores its durable deliverable', async ({ page, runtime }, info) => {
  test.setTimeout(120_000)
  const client = await runtime.connect()
  await install(client, 'examples/fde/knowledge-qa')
  await open(page, runtime)
  await page.getByTestId('composer-agent').click()
  await info.attach('agent-picker.txt', {
    body: await page.getByTestId('agent-options').ariaSnapshot(),
    contentType: 'text/plain',
  })
  await settled(page)
  await page.getByRole('checkbox', { name: /knowledge-qa/ }).check()
  await page.keyboard.press('Escape')
  await turn(page, 'What is the refund window and who reviews refund requests?')
  const session = await current(page, runtime)
  expect(await session.capabilities()).toMatchObject({
    bundles: ['@agnes-fde/knowledge-qa#knowledge-qa'],
    loop: { value: { id: 'fde.knowledge-qa', version: '5.0.0' } },
  })
  expect(JSON.stringify(await toolResult(session, 'present'))).toContain('report.md')
  expect(JSON.stringify(await toolResult(session, 'write'))).toContain('fde-output/knowledge-qa/')
  const output = await session.projectUI(undefined, { surface: 'web' })
  expect(JSON.stringify(output)).toContain('knowledge-qa')
  const write = output.nodes.findLast((node) => node.kind === 'tool' && node.name === 'write')
  if (write?.kind !== 'tool') throw new Error('FDE must write its deliverable')
  const args = (await session.readToolDetail(write.seq, write.resultSeq)).call.args
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.path !== 'string')
    throw new Error('FDE write must have a persisted output path')
  expect(await readFile(join(runtime.workspace, args.path), 'utf8')).toContain('Source-backed answer')
  await info.attach('fde-projection.json', { body: JSON.stringify(output), contentType: 'application/json' })
  const card = await workbenchSurface(page, 'Deliverables')
  await expect(card).toContainText('report.md')
  expect(await artifactText(page, runtime)).toContain('Source-backed answer')
  const url = page.url()
  await page.goto('about:blank')
  await runtime.restart()
  await page.goto(url)
  // A restarted daemon must finish replay before the durable-card contract is checked.
  await expect(page.getByTestId('conversation-turn')).toHaveAttribute('data-status', 'completed', {
    timeout: 25_000,
  })
  await expect(card).toContainText('report.md')
  const restored = await current(page, runtime)
  expect(await restored.capabilities()).toMatchObject({
    bundles: ['@agnes-fde/knowledge-qa#knowledge-qa'],
    loop: { value: { id: 'fde.knowledge-qa', version: '5.0.0' } },
  })
  await turn(page, 'Who reviews refund requests?')
  expect(JSON.stringify(await toolResult(restored, 'present'))).toContain('report.md')
  expect(JSON.stringify(await restored.projectUI(undefined, { surface: 'web' }))).toContain('knowledge-qa')
  await expect(card.last()).toContainText('report.md')
  await quality(page, info, 'fde-deliverable')
})

for (const locale of ['en', 'zh-CN'] as const) {
  test(`Playwright MCP preset prefill and cancelled confirmation (${locale})`, async ({ page, runtime }) => {
    await preferences(page, locale)
    await page.goto(runtime.url)
    await chooseWorkspace(page, runtime, locale)
    await fresh(page, locale)
    await settings(page, locale)
    await section(page, 'mcp')
    await page.getByTestId('mcp-create').click()
    await expect(page.locator('#mcp-methods')).toBeVisible()
    await page.locator('#mcp-method-local').click()
    await expect(page.locator('#mcp-command')).toBeVisible()
    await expect(page.locator('#mcp-command')).toBeFocused()
    await page.locator('#mcp-cancel').click()
    await expect(page.getByTestId('mcp-create')).toBeFocused()
    await page.getByTestId('mcp-add-preset').click()
    await expect(page.locator('#mcp-dialog')).toBeVisible()
    await expect(page.locator('#mcp-id')).toHaveValue('playwright')
    await expect(page.locator('#mcp-executable')).toHaveValue('npx')
    await expect(page.locator('#mcp-args')).toHaveValue(
      '--yes\n@playwright/mcp@0.0.83\n--headless\n--isolated',
    )
    await expect(page.locator('#mcp-preset-description')).toContainText(
      locale === 'en' ? 'Headless' : '默认无头运行',
    )
    const client = await runtime.connect()
    expect(
      (await client.mcp.servers.list({ profile: 'local-dev' })).items.some(
        (item) => item.serverId === 'playwright',
      ),
    ).toBe(false)
    await page.locator('#mcp-form button[type=submit]').click()
    await expect(page.locator('#admin-confirm')).toBeVisible()
    await page.locator('#admin-confirm-cancel').click()
    expect(
      (await client.mcp.servers.list({ profile: 'local-dev' })).items.some(
        (item) => item.serverId === 'playwright',
      ),
    ).toBe(false)
    await page.locator('#mcp-cancel').click()
  })
}

test('Checking a source with no plugin manifest explains that it is not a plugin', async ({
  page,
  runtime,
}) => {
  test.setTimeout(120_000)
  // A Skill repository: SKILL.md and no package.json.
  const folder = join(runtime.workspace, 'not-a-plugin')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'SKILL.md'), '---\nname: sticker\ndescription: x\n---\nbody\n')
  await preferences(page, 'en')
  await page.goto(runtime.url)
  await chooseWorkspace(page, runtime, 'en')
  await fresh(page, 'en')
  await settings(page, 'en')
  await section(page, 'plugins')
  await page.getByTestId('plugin-install-source').click()
  const source = page.getByRole('dialog', { name: 'Check a plugin source', exact: true })
  await source.getByRole('combobox', { name: 'Source type', exact: true }).selectOption('file')
  await source.getByRole('textbox', { name: 'Source reference', exact: true }).fill(`file:${folder}`)
  await source.getByRole('button', { name: 'Check source', exact: true }).click()
  await expect(page.locator('#source-error')).toContainText('A Skill (SKILL.md) is not a plugin')
  await expect(page.getByText('The plugin operation could not complete.')).toHaveCount(0)
})

test('Settings jobs session picker lists the same sessions as the sidebar', async ({ page, runtime }) => {
  test.setTimeout(180_000)
  await open(page, runtime)
  const ids: string[] = []
  for (const text of ['say one', 'say two', 'say three']) {
    await turn(page, text)
    ids.push(new URL(page.url()).searchParams.get('session') ?? '')
    if (text !== 'say three') await fresh(page)
  }
  const client = await runtime.connect()
  await client.session.archive(ids[0]!, true)
  await page.reload()
  await sidebar(page)
  const rows = await page.locator('.session-row').allTextContents()
  await settings(page)
  await page.getByTestId('settings-nav-background-jobs').click()
  await page.getByRole('button', { name: /^Session:/ }).click()
  const picker = page.getByTestId('jobs-session')
  await picker.click()
  const options = await page.locator('.ant-select-item-option').allTextContents()
  // Same sessions, same names: the archived one is not offered, untitled ones read as in the sidebar.
  expect(options).toHaveLength(rows.length)
  for (const row of rows) expect(options.some((option) => option.startsWith(row.trim()))).toBe(true)
})

test('Answer tables keep first and last column text off the frame edge', async ({ page, runtime }) => {
  test.setTimeout(120_000)
  const columns = [
    '任务ID',
    '任务名称',
    '负责人',
    '优先级',
    '开始时间',
    '结束时间',
    '状态',
    '预算(元)',
    '实际支出(元)',
    '备注',
  ]
  const rows = columns.map((name, index) => `| ${String.fromCharCode(65 + index)} | ${name} | 说明 ${name} |`)
  const reply = [
    '## 测试数据表.xlsx 分析',
    '',
    '这是一份项目任务管理表，共 15 条任务记录，字段共 10 列。',
    '',
    '### 表格结构',
    '',
    '| 列 | 字段名 | 说明 |',
    '|---|---|---|',
    ...rows,
    '',
    '### 数据预览',
    '',
    `| ${columns.join(' | ')} |`,
    `|${columns.map(() => '---').join('|')}|`,
    ...Array.from(
      { length: 5 },
      (_, i) =>
        `| T00${i + 1} | 需求调研与方案评审第${i + 1}阶段 | 张三 | P${i % 3} | 2026-07-0${i + 1} | 2026-07-1${i} | 进行中 | 50000 | 32000 | 无 |`,
    ),
    '',
    '### 总结',
    '',
    '收尾段落。',
  ].join('\n')
  const client = await runtime.connect()
  const model = (await client.config.test({ providerId: 'deepseek' })).models[0]?.id
  if (!model) throw new Error('The local provider catalog must contain a model')
  const provider = await startProviderFixture(reply, undefined, model)
  try {
    const config = await client.config.get()
    await client.config.save({
      providerId: 'deepseek',
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model,
      accountId: 'table-fixture',
      label: 'Synthetic table fixture',
      expectedRevision: config.revision,
      makeDefault: true,
    })
    await open(page, runtime)
    await turn(page, '分析这个数据表')
    const table = page.locator('.markdown table').last()
    await table.scrollIntoViewIfNeeded()
    await expect(table).toBeVisible()
    // The bordered .table-scroll frame owns the edge, so first and last columns keep their own padding.
    const edge = await table.evaluate((el) => {
      const wrap = el.closest('.table-scroll') as HTMLElement
      const frame = wrap.getBoundingClientRect()
      const first = el.querySelector('tbody tr td:first-child') as HTMLElement
      const last = el.querySelector('tbody tr td:last-child') as HTMLElement
      const gap = (cell: HTMLElement, side: 'left' | 'right') => {
        const range = document.createRange()
        range.selectNodeContents(cell)
        const text = range.getBoundingClientRect()
        return side === 'left' ? text.left - frame.left : frame.right - text.right
      }
      return { left: gap(first, 'left'), right: gap(last, 'right') }
    })
    expect(edge.left).toBeGreaterThanOrEqual(8)
    expect(edge.right).toBeGreaterThanOrEqual(8)
    await expect(table.locator('tbody tr')).toHaveCount(5)
  } finally {
    await provider.close()
  }
})
