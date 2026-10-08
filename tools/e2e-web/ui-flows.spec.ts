import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { AGH_DIR } from '@agnes/protocol'
import type { Page } from '@playwright/test'
import { startProviderFixture } from '../acceptance/provider-fixture.js'
import { expect, test } from './fixtures.js'
import { accessible, screen, settled, translated } from './quality.js'
import type { Runtime } from './runtime.js'
import { install, toolResult } from './sdk.js'
import { chooseWorkspace, closeSettings, fresh, preferences, section, send, settings, turn } from './ui.js'

async function open(page: Page, runtime: Runtime) {
  await preferences(page)
  await page.goto(runtime.url)
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
async function quality(page: Page, info: Parameters<typeof accessible>[1], name: string) {
  await translated(page)
  await accessible(page, info, name)
}
async function detail(page: Page, tool: string) {
  await page.getByRole('textbox', { name: 'Task content', exact: true }).click()
  await settled(page)
  const session = page.getByTestId('conversation-turn').last()
  const process = session.getByTestId('turn-process-toggle')
  const toggle = session.getByTestId('tool-detail-toggle')
  if (!(await process.evaluate((summary) => summary.parentElement?.hasAttribute('open'))))
    await process.click()
  await expect
    .poll(() => process.evaluate((summary) => summary.parentElement?.hasAttribute('open')))
    .toBe(true)
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await expect(session.getByTestId('tool-detail-text')).toContainText(tool)
  return session.getByTestId('tool-detail-text')
}

test('UI first run, Agent selection, demo read/cancel, account save and restart persistence', async ({
  page,
  runtime,
}, info) => {
  test.setTimeout(120_000)
  await open(page, runtime)
  await expect(page.getByTestId('composer-agent')).toContainText('Agent')
  await turn(page, 'call read {"path":"report.md"}')
  const demo = await current(page, runtime)
  expect(JSON.stringify(await toolResult(demo, 'read'))).toContain('Synthetic delivery')
  await expect(await detail(page, 'report.md')).toContainText('Synthetic delivery')
  const cancelled = await send(page, 'call shell {"command":"sleep 30","timeoutToBackground":false}')
  await expect(cancelled.getByTestId('tool-detail-toggle')).toBeVisible()
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(cancelled).toHaveAttribute('data-status', 'cancelled')
  await turn(page, 'Recovered after explicit cancellation')
  await quality(page, info, 'demo-cancel')
  const client = await runtime.connect()
  const model = (await client.config.test({ providerId: 'deepseek' })).models[0]?.id
  if (!model) throw new Error('The installed provider catalog must supply a local fixture model')
  const provider = await startProviderFixture('UI_CREDENTIAL_PERSISTED', undefined, model)
  try {
    await settings(page)
    await page.getByRole('button', { name: 'Add account', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Add account', exact: true })
    await dialog.getByRole('textbox', { name: 'Account name', exact: true }).fill('Offline UI account')
    await dialog.getByRole('combobox', { name: /^Provider:/ }).click()
    await info.attach('provider-picker.txt', { body: await dialog.ariaSnapshot(), contentType: 'text/plain' })
    await page.getByRole('option', { name: 'DeepSeek', exact: true }).click()
    await expect(dialog.getByRole('combobox', { name: 'Provider: DeepSeek', exact: true })).toBeVisible()
    await dialog.getByRole('textbox', { name: 'Base URL', exact: true }).fill(provider.baseUrl)
    await dialog.getByLabel('API Key', { exact: true }).fill(provider.apiKey)
    await dialog.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(dialog.getByRole('button', { name: 'Save account', exact: true })).toBeEnabled()
    await dialog.getByRole('button', { name: 'Save account', exact: true }).click()
    await expect(dialog).toBeHidden()
    const saved = await client.config.get()
    expect(saved.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Offline UI account', credentialConfigured: true }),
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
    '--yes',
  ])
  const revision = async () => {
    const value = /revision=([a-f0-9]{64})/.exec(await runtime.cli(['mcp', 'get', 'e2e']))?.[1]
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
    { name: 'mcp__e2e__echo', args: { text: 'UI_MCP_STDIO' } },
    model,
  )
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
    expect((await toolResult(session, 'mcp__e2e__echo'))?.content).toEqual([
      { type: 'text', text: 'UI_MCP_STDIO' },
    ])
    await expect(await detail(page, 'mcp__e2e__echo')).toContainText('UI_MCP_STDIO')
    await settings(page)
    await section(page, 'mcp')
    await expect(page.getByRole('switch', { name: /E2E stdio/ })).toBeChecked()
    await quality(page, info, 'mcp-enabled')
    await section(page, 'skills')
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
  await expect(question.getByTestId('question-submit')).toBeDisabled()
  await question.getByRole('radio', { name: 'Web', exact: true }).check()
  await quality(page, info, 'ask-card')
  await question.getByTestId('question-submit').click()
  await expect(question.getByTestId('question-submit')).toHaveText('Answered')
  await expect(question.getByRole('radio', { name: 'Web', exact: true })).toBeDisabled()
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
  const card = page.getByTestId('deliverable-card')
  const downloading = page.waitForEvent('download')
  await card.getByTestId('deliverable-download').click()
  const download = await downloading
  const path = await download.path()
  if (!path) throw new Error('Authorized deliverable must produce a downloaded file')
  expect(await readFile(path, 'utf8')).toContain('Synthetic delivery')
  await quality(page, info, 'deliverable-card')
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
  await turn(page, `call subagent_collect ${JSON.stringify({ childKey, wait: true })}`)
  expect(JSON.stringify(await toolResult(session, 'subagent_collect'))).toContain('Synthetic delivery')
  await quality(page, info, 'child-card')
  await page.getByTestId('goal-toggle').click()
  await page.getByTestId('goal-objective').fill('E2E finish the inspected delivery')
  await page.getByTestId('goal-max-rounds').fill('1')
  await page.getByTestId('goal-save').click()
  await expect(page.getByTestId('goal-toggle')).toContainText('Blocked goal')
  await page.getByTestId('goal-toggle').click()
  await expect(page.getByTestId('goal-complete')).toBeEnabled()
  await quality(page, info, 'goal-card')
  await page.getByTestId('goal-complete').click()
  await expect(page.getByTestId('goal-toggle')).toContainText('Complete')
  await expect(page.getByTestId('goal-complete')).toHaveCount(0)
})

test('UI background jobs, interactive terminal and schedule cards persist observable results', async ({
  page,
  runtime,
}, info) => {
  test.setTimeout(120_000)
  await open(page, runtime)
  await turn(page, 'call shell {"command":"printf E2E_JOB_OK","background":true}')
  const session = await current(page, runtime)
  await turn(page, 'call job_list {}')
  await expect(page.getByTestId('background-job-card').first()).toBeVisible()
  await quality(page, info, 'background-job-card')
  await turn(
    page,
    'call schedule_create {"title":"E2E tool reminder","prompt":"Inspect delivery","selector":{"every_seconds":86400}}',
  )
  await expect(page.getByTestId('reminder-card')).toContainText('E2E tool reminder')
  await quality(page, info, 'schedule-card')
  await settings(page)
  await section(page, 'jobs')
  await page.getByTestId('jobs-session').fill(session.id)
  await page.getByTestId('jobs-refresh').click()
  await expect(page.getByTestId('session-jobs-table')).toContainText('Completed')
  await page.getByRole('button', { name: 'Output', exact: true }).first().click()
  await expect(page.getByTestId('job-output')).toContainText('E2E_JOB_OK')
  await section(page, 'terminal')
  await page.getByTestId('jobs-session').fill(session.id)
  await page.getByTestId('terminal-shell').selectOption('bash')
  await page.getByTestId('terminal-open').click()
  await expect(page.getByTestId('terminal-close')).toBeEnabled()
  const output = page.getByTestId('terminal-output')
  await output.pressSequentially("printf '%s\\n' E2E_TERMINAL_OK")
  await output.press('Enter')
  await expect(output).toHaveValue(/\nE2E_TERMINAL_OK\r?\n/)
  await quality(page, info, 'interactive-terminal')
  await page.getByTestId('terminal-close').click()
  await expect(page.getByTestId('terminal-open')).toBeEnabled()
  await section(page, 'schedules')
  await expect(page.getByTestId('schedules-row')).toContainText('E2E tool reminder')
  await page.getByTestId('schedules-title').fill('E2E UI reminder')
  await page.getByTestId('schedules-prompt').fill('Review the synthetic delivery')
  await page.getByTestId('schedules-kind').selectOption('every_seconds')
  await page.getByTestId('schedules-when').fill('86400')
  await page.getByTestId('schedules-create').click()
  const scheduled = page.getByTestId('schedules-row').filter({ hasText: 'E2E UI reminder' })
  await expect(scheduled).toBeVisible()
  await scheduled.getByTestId('schedules-archive').click()
  await page.getByTestId('schedules-archive-cancel').click()
  await expect(scheduled).toBeVisible()
  await scheduled.getByTestId('schedules-archive').click()
  await page.getByTestId('schedules-archive-confirm').click()
  await expect(scheduled).toHaveCount(0)
  await quality(page, info, 'schedules-after-archive')
})

test('UI folder install reviews capabilities, enables a tool and disables it for new sessions', async ({
  page,
  runtime,
}, info) => {
  test.setTimeout(120_000)
  await open(page, runtime)
  await settings(page)
  await section(page, 'plugins')
  await page.getByRole('button', { name: 'Install from source', exact: true }).click()
  const source = page.getByRole('dialog', { name: 'Check a plugin source', exact: true })
  await info.attach('source-dialog.txt', { body: await source.ariaSnapshot(), contentType: 'text/plain' })
  await source.getByRole('combobox', { name: 'Source type', exact: true }).selectOption('file')
  await source
    .getByRole('textbox', { name: 'Source reference', exact: true })
    .fill(`file:${resolve('examples/packages/hot-tool-plugin')}`)
  await source.getByRole('button', { name: 'Check source', exact: true }).click()
  const review = page.getByRole('dialog', { name: /^Install preview/ })
  await expect(review.getByRole('heading', { name: 'Requested capabilities', exact: true })).toBeVisible()
  await expect(review).toContainText('@agnes-examples/hot-tool-plugin')
  await expect(review).toContainText('sha256-')
  const client = await runtime.connect()
  expect(
    (await client.packages.list({ profile: 'local-dev' })).packages.some(
      (row) => row.id === '@agnes-examples/hot-tool-plugin',
    ),
  ).toBe(false)
  await quality(page, info, 'capability-review')
  await review.getByRole('button', { name: 'Confirm installation', exact: true }).click()
  await expect(review).toBeHidden()
  await page
    .getByRole('dialog', { name: 'Plugin details', exact: true })
    .getByRole('button', { name: /Close/ })
    .click()
  await page
    .getByRole('switch', { name: 'Request to enable @agnes-examples/hot-tool-plugin', exact: true })
    .click()
  await page
    .getByRole('dialog', { name: 'Enable @agnes-examples/hot-tool-plugin', exact: true })
    .getByRole('button', { name: 'Confirm enable', exact: true })
    .click()
  const toggle = page.getByRole('switch', {
    name: 'Request to disable @agnes-examples/hot-tool-plugin',
    exact: true,
  })
  await expect(toggle).toBeChecked()
  const enabledDetails = page.getByRole('dialog', { name: 'Plugin details', exact: true })
  if (await enabledDetails.isVisible()) await enabledDetails.getByRole('button', { name: /Close/ }).click()
  await page
    .getByRole('searchbox', { name: 'Search plugins', exact: true })
    .fill('@agnes-examples/hot-tool-plugin')
  await expect(page.getByRole('heading', { name: /hot-tool-plugin/ })).toHaveCount(1)
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
    .getByRole('dialog', { name: 'Request disable for @agnes-examples/hot-tool-plugin', exact: true })
    .getByRole('button', { name: 'Request disable', exact: true })
    .click()
  await expect(
    page.getByRole('switch', { name: 'Request to enable @agnes-examples/hot-tool-plugin', exact: true }),
  ).not.toBeChecked()
  const disabledDetails = page.getByRole('dialog', { name: 'Plugin details', exact: true })
  if (await disabledDetails.isVisible()) await disabledDetails.getByRole('button', { name: /Close/ }).click()
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
})

test('UI local rescan preserves old/new code through a daemon restart', async ({ page, runtime }, info) => {
  test.setTimeout(120_000)
  await open(page, runtime)
  const rescan = async (version: number) => {
    await runtime.localTool(version)
    await settings(page)
    await section(page, 'plugins')
    if (!(await page.getByTestId('local-plugins-toggle').isVisible()))
      await page.getByTestId('plugin-diagnostics-toggle').click()
    if (!(await page.getByTestId('reload-local-plugins').isVisible()))
      await page.getByTestId('local-plugins-toggle').click()
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
  await page.goto('about:blank')
  await runtime.restart()
  for (const [session, version] of [
    [old, 1],
    [newer, 2],
  ] as const) {
    await page.goto(new URL(`/?session=${encodeURIComponent(session.id)}`, runtime.url).href)
    await expect(page.getByTestId('conversation-turn')).toHaveCount(1)
    await turn(page, 'call e2e_version {"text":"restored"}')
    const restored = await current(page, runtime)
    expect((await toolResult(restored, 'e2e_version'))?.structured).toMatchObject({ version })
    await expect(await detail(page, 'e2e_version')).toContainText(`"version":${version}`)
  }
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
    loop: { value: { id: 'fde.knowledge-qa' } },
  })
  const card = page.getByTestId('deliverable-card')
  await expect(card).toContainText('report.md')
  const download = page.waitForEvent('download')
  await card.getByTestId('deliverable-download').click()
  const file = await download
  expect(file.suggestedFilename()).toBe('report.md')
  const path = await file.path()
  if (!path) throw new Error('The authorized deliverable must download to a real file')
  expect(await readFile(path, 'utf8')).toContain('Source-backed answer')
  const url = page.url()
  await page.goto('about:blank')
  await runtime.restart()
  await page.goto(url)
  await expect(card).toContainText('report.md')
  await turn(page, 'Who reviews refund requests?')
  await expect(card.last()).toContainText('report.md')
  await quality(page, info, 'fde-deliverable')
})
