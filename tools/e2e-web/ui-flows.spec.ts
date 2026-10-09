import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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
    await expect(page.locator('#config-accounts')).toHaveAttribute('data-state', 'empty')
    await page.getByRole('button', { name: 'Add account', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Add account', exact: true })
    await dialog.getByRole('textbox', { name: 'Account name', exact: true }).fill('Offline UI account')
    await dialog.getByRole('combobox', { name: /^Provider:/ }).click()
    await info.attach('provider-picker.txt', { body: await dialog.ariaSnapshot(), contentType: 'text/plain' })
    await page.getByRole('option', { name: 'DeepSeek', exact: true }).click()
    await expect(dialog.getByRole('combobox', { name: 'Provider: DeepSeek', exact: true })).toBeVisible()
    await dialog.getByRole('textbox', { name: 'Base URL', exact: true }).fill(provider.baseUrl)
    await dialog.getByLabel('API Key', { exact: true }).fill(provider.apiKey)
    await dialog.getByTestId('account-network-details').locator('summary').click()
    await dialog.getByTestId('account-network-requestMs').fill('90000')
    await dialog.getByTestId('account-network-connectMs').fill('4000')
    await dialog.getByTestId('account-network-streamIdleMs').fill('15000')
    await dialog.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(dialog.getByRole('button', { name: 'Save account', exact: true })).toBeEnabled()
    await dialog.getByRole('button', { name: 'Save account', exact: true }).click()
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
  await toolResult(session, 'shell')
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
  test.setTimeout(180_000)
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
  // Completion opens a modal: its background controls are intentionally inaccessible.
  const enabledDetails = page.getByRole('dialog', { name: 'Plugin details', exact: true })
  await expect(enabledDetails).toContainText('Enable: Completed')
  await enabledDetails.getByRole('button', { name: /Close/ }).click()
  const toggle = page.getByRole('switch', {
    name: 'Request to disable @agnes-examples/hot-tool-plugin',
    exact: true,
  })
  await expect(toggle).toBeChecked()
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
  const disabledDetails = page.getByRole('dialog', { name: 'Plugin details', exact: true })
  await expect(disabledDetails).toContainText('Disable: Completed')
  await disabledDetails.getByRole('button', { name: /Close/ }).click()
  await expect(
    page.getByRole('switch', { name: 'Request to enable @agnes-examples/hot-tool-plugin', exact: true }),
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
    const summary = page.getByTestId('plugin-drain-summary')
    await expect(summary).toHaveCount(1)
    await expect(summary).toContainText(
      locale === 'en'
        ? /versions of \d+ plugins? are still used by 1 session/
        : /有 \d+ 个插件的旧版本仍被 1 个会话使用/,
    )
    await expect(summary).not.toContainText('@agnes/')
    const details = page.getByTestId('plugin-drain-details')
    await expect(details).not.toHaveAttribute('open')
    const chip = page.getByRole('note', {
      name: new RegExp(locale === 'en' ? '^Older version in use' : '^旧版本使用中'),
    })
    await chip.focus()
    await expect(
      page
        .locator('.agnes-ui-popover')
        .filter({ hasText: locale === 'en' ? 'Existing sessions still use' : '已有会话仍使用旧版本' }),
    ).toBeVisible()
    await page
      .getByRole('searchbox', { name: locale === 'en' ? 'Search plugins' : '搜索插件', exact: true })
      .focus()
    await page.mouse.move(0, 0)
    await quality(page, info, `plugin-old-version-${locale}-${theme}`)
    await screen(page, info, `plugin-old-version-${locale}-${theme}`)
    await details.locator('summary').click()
    await expect(details).toContainText('hot-tool-plugin')
    await expect(details).toContainText(locale === 'en' ? 'Plugin assistant' : '插件助手')
    expect(
      (await details.locator('code').allTextContents()).some((text) =>
        /^@agnes\/(ai|base|code) ·/.test(text),
      ),
    ).toBe(false)
    await details.locator('summary').click()
    await closeSettings(page, locale)
  }
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
    loop: { value: { id: 'fde.knowledge-qa', version: '3.0.0' } },
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
  const card = page.getByTestId('deliverable-card')
  await expect(card).toContainText('report.md')
  const download = page.waitForEvent('download')
  await card.getByTestId('deliverable-download').click()
  const file = await download
  expect(file.suggestedFilename()).toBe('report.md')
  const path = info.outputPath('report.md')
  await file.saveAs(path)
  expect(await readFile(path, 'utf8')).toContain('Source-backed answer')
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
    loop: { value: { id: 'fde.knowledge-qa', version: '3.0.0' } },
  })
  await turn(page, 'Who reviews refund requests?')
  expect(JSON.stringify(await toolResult(restored, 'present'))).toContain('report.md')
  expect(JSON.stringify(await restored.projectUI(undefined, { surface: 'web' }))).toContain('knowledge-qa')
  await expect(card.last()).toContainText('report.md')
  await quality(page, info, 'fde-deliverable')
})

test('agent candidate review binds exact tests and hashes, refuses edited approval, publishes only for new sessions', async ({
  page,
  runtime,
  expectedBrowserErrors,
}, info) => {
  test.setTimeout(300_000)
  const client = await runtime.connect()
  const old = await client.session.new({
    sessionKey: crypto.randomUUID(),
    cwd: runtime.workspace,
    preset: 'full-access',
  })
  await old.attach()
  await client.session.rename(old.id, 'Text statistics workshop')
  old.onPermissionRequest(async () => ({ verdict: 'allowed-once' }))
  const { prompt } = await import('./sdk.js')
  await prompt(old, 'call plugin_helper_guide {"kind":"tool"}')
  const guide = JSON.parse(
    (await toolResult(old, 'plugin_helper_guide'))!.content[0]!.type === 'text'
      ? ((await toolResult(old, 'plugin_helper_guide'))!.content[0] as { text: string }).text
      : '{}',
  ) as { files: { path: string; content: string }[] }
  await prompt(old, 'call plugin_helper_create ' + JSON.stringify({ files: guide.files }))
  const createdResult = (await toolResult(old, 'plugin_helper_create'))!.content[0] as { text: string }
  const draft = JSON.parse(createdResult.text) as import('@agnes/protocol').AuthoringCandidate
  expect(draft).toMatchObject({ state: 'draft', installer: 'agent', origin: { turn: 2 } })
  expect(
    (await client.packages.list({ profile: 'local-dev' })).packages.some((p) => p.id === draft.packageId),
  ).toBe(false)
  await prompt(
    old,
    'call plugin_helper_install ' + JSON.stringify({ action: 'test', proposalId: draft.candidateId }),
  )
  await prompt(
    old,
    'call plugin_helper_install ' + JSON.stringify({ action: 'commit', proposalId: draft.candidateId }),
  )
  const reviewed = await client.request('_agnes/v1/plugins.candidates.show', {
    profile: 'local-dev',
    candidateId: draft.candidateId,
  })
  expect(reviewed).toMatchObject({ state: 'review', tests: { state: 'passed', hash: draft.candidateHash } })
  await page.addInitScript(() => {
    if (location.protocol !== 'http:') return
    localStorage.setItem('agnes-locale', localStorage.getItem('e2e-authoring-locale') ?? 'en')
    localStorage.setItem('agnes-theme', localStorage.getItem('e2e-authoring-theme') ?? 'light')
  })
  await page.goto(runtime.url)
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
  await expect(page.locator('.workspace-heading .workspace-name').filter({ hasText: /^w$/ })).toHaveCount(1)
  expect((await client.workspace.list()).items.every((workspace) => workspace.name.trim().length > 0)).toBe(
    true,
  )
  if (!(await page.getByTestId('settings-navigation').isVisible())) await settings(page)
  await section(page, 'plugins')
  await page.getByTestId('candidate-open').filter({ hasText: draft.packageId }).click()
  await expect(page.getByTestId('candidate-state')).toHaveText('Awaiting review')
  await expect(page.getByTestId('candidate-tests')).toContainText('Tests passed 1/1')
  await expect(page.getByTestId('candidate-provenance')).toContainText(
    'Drafted by Agent · From “Text statistics workshop” (turn 2)',
  )
  await expect(page.getByTestId('candidate-capability-delta')).toContainText('New permissions: none')
  await expect(page.getByTestId('candidate-summary')).toContainText('No new permissions')
  await expect(page.getByTestId('candidate-hash')).toBeHidden()
  await expect(page.getByTestId('candidate-technical')).not.toHaveAttribute('open')
  await expect(page.getByTestId('candidate-approve')).toBeInViewport({ ratio: 1 })
  await expect(page.getByTestId('candidate-reject')).toBeInViewport({ ratio: 1 })
  const diff = page
    .getByTestId('candidate-file-diff')
    .filter({ has: page.getByText('index.mjs', { exact: true }) })
  await diff.locator('summary').click()
  await expect(diff).toContainText('my_text_stats')
  await expect(diff.getByText('New file', { exact: true })).toBeVisible()
  await expect(diff.locator('.candidate-diff-added').first()).toContainText('+')
  await translated(page)
  await accessible(page, info, 'candidate-review')
  // Review each changed screen across both languages and themes. Digest and session IDs are dynamic.
  for (const [locale, theme] of [
    ['en', 'light'],
    ['en', 'dark'],
    ['zh-CN', 'light'],
    ['zh-CN', 'dark'],
  ] as const) {
    await page.evaluate(
      ({ locale, theme }) => {
        localStorage.setItem('e2e-authoring-locale', locale)
        localStorage.setItem('e2e-authoring-theme', theme)
      },
      { locale, theme },
    )
    await page.goto(runtime.url)
    await expect(page.getByTestId('conversation-turn')).toHaveCount(4)
    await expect(
      page.getByRole('button', { name: locale === 'en' ? 'Settings' : '设置', exact: true }),
    ).toBeVisible()
    if (!(await page.getByTestId('settings-navigation').isVisible())) await settings(page, locale)
    await section(page, 'plugins')
    await page.getByTestId('candidate-open').filter({ hasText: draft.packageId }).click()
    await expect(page.getByTestId('candidate-approve')).toBeInViewport({ ratio: 1 })
    await expect(page.getByTestId('candidate-reject')).toBeInViewport({ ratio: 1 })
    await expect(page.getByTestId('candidate-hash')).toBeHidden()
    await translated(page)
    await accessible(page, info, `candidate-review-${locale}-${theme}`)
    await screen(page, info, `candidate-review-${locale}-${theme}`)
    await page.getByTestId('candidate-fact-chain').click()
    const facts = page.getByTestId('fact-chain')
    await expect(facts.locator('[data-fact-kind="authoring"]')).toContainText(draft.packageId)
    await expect(facts.locator('[data-fact-kind="authoring"]')).toContainText(
      locale === 'en' ? 'Tests passed: 1' : '测试通过 1 项',
    )
    await expect(facts.locator('details')).not.toHaveAttribute('open')
    await translated(page)
    await accessible(page, info, `fact-authoring-${locale}-${theme}`)
    // Frame the originating conversation consistently after navigation and text reflow.
    await page.getByRole('region', { name: /^(Conversation|对话)$/, exact: true }).evaluate((viewport) => {
      viewport.style.scrollBehavior = 'auto'
      viewport.scrollTop = 0
    })
    await page.mouse.move(0, 0)
    await screen(page, info, `fact-authoring-${locale}-${theme}`)
  }
  await page.evaluate(() => {
    localStorage.setItem('e2e-authoring-locale', 'en')
    localStorage.setItem('e2e-authoring-theme', 'light')
  })
  await page.goto(runtime.url)
  await expect(page.getByTestId('conversation-turn')).toHaveCount(4)
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
  if (!(await page.getByTestId('settings-navigation').isVisible())) await settings(page)
  await section(page, 'plugins')
  await page.getByTestId('candidate-open').filter({ hasText: draft.packageId }).click()
  await client.session.rename(old.id, 'A very long workshop title '.repeat(3).slice(0, 80))
  await page.goto(runtime.url)
  await expect(page.getByTestId('conversation-turn')).toHaveCount(4)
  if (!(await page.getByTestId('settings-navigation').isVisible())) await settings(page)
  await section(page, 'plugins')
  await page.getByTestId('candidate-open').filter({ hasText: draft.packageId }).click()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  for (const [width, height] of [
    [1440, 900],
    [1024, 900],
    [900, 900],
    [840, 900],
    [540, 900],
    [390, 900],
    [540, 600],
  ]) {
    await page.setViewportSize({ width: width!, height: height! })
    await expect(page.getByTestId('candidate-approve')).toBeInViewport({ ratio: 1 })
    await expect(page.getByTestId('candidate-reject')).toBeInViewport({ ratio: 1 })
    expect(
      await page.getByTestId('candidate-review').evaluate((panel) => panel.scrollWidth <= panel.clientWidth),
    ).toBe(true)
  }
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await client.session.rename(old.id, 'Text statistics workshop')
  await page.getByTestId('candidate-approve').click()
  const dialog = page.getByRole('dialog', { name: 'Approve and publish', exact: true })
  await expect(dialog.getByTestId('candidate-hash')).toBeHidden()
  await dialog.getByTestId('candidate-technical').locator('summary').focus()
  await dialog.getByTestId('candidate-technical').locator('summary').press('Enter')
  await expect(dialog.getByTestId('candidate-hash')).toHaveText(reviewed.candidateHash)
  // A model edit after the human opened the review must invalidate that dialog's captured hashes.
  const changed = guide.files.map((f) =>
    f.path === 'index.mjs' ? { ...f, content: f.content + '\n// Edited after review\n' } : f,
  )
  const { readFile, writeFile } = await import('node:fs/promises'),
    { join } = await import('node:path')
  const record = JSON.parse(
    await readFile(
      join(runtime.home, 'profiles/local-dev/.authoring-candidates', draft.candidateId, 'record.json'),
      'utf8',
    ),
  ) as { tree: string }
  await writeFile(join(record.tree, 'index.mjs'), changed.find((f) => f.path === 'index.mjs')!.content)
  expectedBrowserErrors.push(
    'console: Failed to load resource: the server responded with a status of 409 (Conflict)',
  )
  const staleResponse = page.waitForResponse((response) => response.url().endsWith('/candidates/approve'))
  await dialog.getByRole('button', { name: 'Approve and publish', exact: true }).click()
  expect((await staleResponse).status()).toBe(409)
  await expect(page.getByTestId('candidate-error')).toBeVisible()
  expect(
    (await client.packages.list({ profile: 'local-dev' })).packages.some((p) => p.id === draft.packageId),
  ).toBe(false)
  await page.getByTestId('candidate-back').click()
  await page.getByTestId('candidate-open').filter({ hasText: draft.packageId }).first().click()
  await expect(page.getByTestId('candidate-state')).toHaveText('Draft; review invalidated after edits')
  await expect(page.getByTestId('candidate-approve')).toBeDisabled()
  await page.getByTestId('candidate-test').click()
  await page
    .getByRole('dialog', { name: 'Run tests', exact: true })
    .getByRole('button', { name: 'Run tests', exact: true })
    .click()
  await expect(page.getByTestId('candidate-state')).toHaveText('Tests passed; awaiting submission')
  await page.getByTestId('candidate-submit').click()
  await expect(page.getByTestId('candidate-state')).toHaveText('Awaiting review')
  await page.getByTestId('candidate-approve').click()
  await page
    .getByRole('dialog', { name: 'Approve and publish', exact: true })
    .getByRole('button', { name: 'Approve and publish', exact: true })
    .click()
  await expect(page.getByTestId('candidate-state')).toHaveText('Published', {
    timeout: 25_000,
  })
  const provenance = await client.request('_agnes/v1/packages.provenance', {
    profile: 'local-dev',
    id: draft.packageId,
  })
  expect(provenance).toMatchObject({
    installer: 'agent',
    authoring: { candidateId: draft.candidateId, origin: draft.origin },
  })
  expect(provenance.authoring!.candidateHash).not.toBe(reviewed.candidateHash)
  expect((await old.tools()).tools.some((t) => t.name === 'my_text_stats')).toBe(false)
  const freshSession = await client.session.new({
    sessionKey: crypto.randomUUID(),
    cwd: runtime.workspace,
    preset: 'full-access',
  })
  await freshSession.attach()
  expect((await freshSession.tools()).tools.some((t) => t.name === 'my_text_stats')).toBe(true)
  await prompt(freshSession, 'call my_text_stats {"text":"hello world"}')
  expect((await toolResult(freshSession, 'my_text_stats'))!.structured).toEqual({ characters: 11, words: 2 })
  await prompt(old, 'call read {"path":"report.md"}')
  expect(JSON.stringify(await toolResult(old, 'read'))).toContain('Synthetic delivery')
  // Authored Markdown and adjacent scripts stay inert, and rejection never publishes a Skill.
  const skillBody =
    '---\nname: Reviewed method\ndescription: Synthetic reusable workflow.\n---\n\nUse the normal approved shell tool for scripts.\n'
  await prompt(
    old,
    'call skill_helper_create ' +
      JSON.stringify({
        name: 'reviewed-method',
        files: [
          { path: 'SKILL.md', content: skillBody },
          {
            path: 'scripts/check.mjs',
            content: "throw new Error('This script must never run during review')\n",
          },
        ],
      }),
  )
  const skill = JSON.parse(
    ((await toolResult(old, 'skill_helper_create'))!.content[0] as { text: string }).text,
  ) as import('@agnes/protocol').AuthoringCandidate
  expect(skill).toMatchObject({ state: 'draft', installer: 'agent' })
  await prompt(
    old,
    'call skill_helper_install ' + JSON.stringify({ action: 'test', proposalId: skill.candidateId }),
  )
  await prompt(
    old,
    'call skill_helper_install ' + JSON.stringify({ action: 'commit', proposalId: skill.candidateId }),
  )
  await page.getByTestId('candidate-refresh').click()
  await page.getByTestId('candidate-open').filter({ hasText: skill.packageId }).click()
  await expect(page.getByTestId('candidate-tests')).toContainText('Tests passed 1/1')
  await page
    .getByTestId('candidate-file-diff')
    .filter({ has: page.getByText('skills/reviewed-method/SKILL.md', { exact: true }) })
    .locator('summary')
    .click()
  const skillDiff = page
    .getByTestId('candidate-file-diff')
    .filter({ has: page.getByText('skills/reviewed-method/SKILL.md', { exact: true }) })
    .locator('.candidate-diff-added')
  await expect
    .poll(async () => (await skillDiff.allTextContents()).map((line) => line.slice(2, -1)).join('\n'))
    .toBe(skillBody)
  await page.getByTestId('candidate-reject').click()
  await page
    .getByRole('dialog', { name: 'Reject candidate', exact: true })
    .getByRole('button', { name: 'Reject candidate', exact: true })
    .click()
  await expect(page.getByTestId('candidate-state')).toHaveText('Rejected')
  await page.getByTestId('candidate-back').click()
  await expect(page.getByTestId('candidate-list').getByTestId('candidate-open')).toHaveCount(2)
  await expect(page.getByTestId('candidate-open').filter({ hasText: draft.packageId })).toContainText(
    'Published',
  )
  await expect(page.getByTestId('candidate-open').filter({ hasText: skill.packageId })).toContainText(
    'Rejected',
  )
  expect(
    (await client.packages.list({ profile: 'local-dev' })).packages.some((p) => p.id === skill.packageId),
  ).toBe(false)
  // A reviewed update supplies a genuine replacement diff, and the inbox shows all three review outcomes.
  const updateFiles = guide.files.map((file) =>
    file.path === 'index.mjs' ? { ...file, content: file.content + '\n// Reviewed update\n' } : file,
  )
  // Escape template text so the demo's natural-language authoring shortcut does not replace this explicit call.
  await prompt(
    old,
    'call plugin_helper_create ' +
      JSON.stringify({ files: updateFiles }).replace(/[Pp]/g, (letter) =>
        letter === 'P' ? '\\u0050' : '\\u0070',
      ),
  )
  const update = JSON.parse(
    ((await toolResult(old, 'plugin_helper_create'))!.content[0] as { text: string }).text,
  ) as import('@agnes/protocol').AuthoringCandidate
  expect(update.files.find((file) => file.path === 'index.mjs')?.after).toBe(
    updateFiles.find((file) => file.path === 'index.mjs')!.content,
  )
  await prompt(
    old,
    'call plugin_helper_install ' + JSON.stringify({ action: 'test', proposalId: update.candidateId }),
  )
  await prompt(
    old,
    'call plugin_helper_install ' + JSON.stringify({ action: 'commit', proposalId: update.candidateId }),
  )
  for (const [locale, theme] of [
    ['en', 'light'],
    ['en', 'dark'],
    ['zh-CN', 'light'],
    ['zh-CN', 'dark'],
  ] as const) {
    await page.evaluate(
      ({ locale, theme }) => {
        localStorage.setItem('e2e-authoring-locale', locale)
        localStorage.setItem('e2e-authoring-theme', theme)
      },
      { locale, theme },
    )
    await page.goto(runtime.url)
    await expect(page.getByTestId('conversation-turn')).toHaveCount(11)
    if (!(await page.getByTestId('settings-navigation').isVisible())) await settings(page, locale)
    await section(page, 'plugins')
    await expect(page.getByTestId('candidate-list').getByTestId('candidate-open')).toHaveCount(3)
    const rows = page.getByTestId('candidate-list').getByTestId('candidate-open')
    await expect(
      rows
        .filter({ hasText: draft.packageId })
        .filter({ hasText: locale === 'en' ? 'New plugin' : '新插件' }),
    ).toHaveCount(1)
    await expect(
      rows.filter({ hasText: draft.packageId }).filter({ hasText: locale === 'en' ? 'Update' : '更新' }),
    ).toHaveCount(1)
    await expect(rows.filter({ hasText: skill.packageId })).toContainText(
      locale === 'en' ? 'Skill · New skill' : '技能 · 新技能',
    )
    await expect(rows.getByTestId('candidate-origin-time')).toHaveCount(3)
    await expect(rows.first()).toContainText(locale === 'en' ? 'Plugin · Update' : '插件 · 更新')
    await expect(rows.getByTestId('candidate-list-facts').first()).toContainText('0.1.0')
    await expect(page.getByTestId('plugin-drain-summary')).toHaveCount(1)
    await expect(page.getByTestId('plugin-drain-summary')).not.toContainText('@agnes/')
    // Assert real timestamps above; normalize only elapsed text for stable screenshots.
    const times = rows.getByTestId('candidate-origin-time')
    const originals = await times.allTextContents()
    await times.evaluateAll(
      (nodes, text) =>
        nodes.forEach((node) => {
          node.textContent = text
        }),
      locale === 'en' ? 'Session turn: 2 min ago' : '来源轮次：2 分钟前',
    )
    await screen(page, info, `candidate-list-${locale}-${theme}`)
    await times.evaluateAll(
      (nodes, labels) =>
        nodes.forEach((node, index) => {
          node.textContent = labels[index] ?? ''
        }),
      originals,
    )
    await page
      .getByTestId('candidate-open')
      .filter({ hasText: update.packageId })
      .filter({ hasText: locale === 'en' ? 'Awaiting review' : '待审阅' })
      .click()
    const file = page
      .getByTestId('candidate-file-diff')
      .filter({ has: page.getByText('index.mjs', { exact: true }) })
    await file.locator('summary').click()
    const removed = file.locator('.candidate-diff-removed').filter({ hasText: '// Edited after review' })
    const added = file.locator('.candidate-diff-added').filter({ hasText: '// Reviewed update' })
    const diff = file.getByTestId('candidate-diff-lines')
    await diff.focus()
    await diff.press('ArrowDown')
    await expect.poll(() => diff.evaluate((pre) => pre.scrollTop)).toBeGreaterThan(0)
    await file.getByTestId('candidate-diff-lines').evaluate((pre) => {
      pre.scrollIntoView({ block: 'nearest' })
      pre.scrollTop = pre.scrollHeight
    })
    await expect(removed).toContainText('- // Edited after review')
    await expect(removed).toBeInViewport({ ratio: 1 })
    await expect(added).toContainText('+ // Reviewed update')
    await expect(added).toBeInViewport({ ratio: 1 })
    await expect(file.locator('summary')).toBeInViewport({ ratio: 1 })
    await expect(page.getByTestId('candidate-approve')).toBeInViewport({ ratio: 1 })
    await translated(page)
    await accessible(page, info, `candidate-diff-${locale}-${theme}`)
    await screen(page, info, `candidate-diff-${locale}-${theme}`)
  }
  await page.evaluate(() => {
    localStorage.setItem('e2e-authoring-locale', 'en')
    localStorage.setItem('e2e-authoring-theme', 'light')
  })
  await page.goto(runtime.url)
  await expect(page.getByTestId('conversation-turn')).toHaveCount(11)
  if (!(await page.getByTestId('settings-navigation').isVisible())) await settings(page)
  await section(page, 'plugins')
  await prompt(
    old,
    'call skill_helper_create ' +
      JSON.stringify({
        name: 'reviewed-published',
        files: [{ path: 'SKILL.md', content: skillBody }],
      }),
  )
  const publishSkill = JSON.parse(
    ((await toolResult(old, 'skill_helper_create'))!.content[0] as { text: string }).text,
  ) as import('@agnes/protocol').AuthoringCandidate
  await prompt(
    old,
    'call skill_helper_install ' + JSON.stringify({ action: 'test', proposalId: publishSkill.candidateId }),
  )
  await prompt(
    old,
    'call skill_helper_install ' + JSON.stringify({ action: 'commit', proposalId: publishSkill.candidateId }),
  )
  await page.getByTestId('candidate-refresh').click()
  await page.getByTestId('candidate-open').filter({ hasText: publishSkill.packageId }).click()
  await page.getByTestId('candidate-approve').click()
  await page
    .getByRole('dialog', { name: 'Approve and publish', exact: true })
    .getByRole('button', { name: 'Approve and publish', exact: true })
    .click()
  await expect(page.getByTestId('candidate-state')).toHaveText('Published', {
    timeout: 25_000,
  })
  const skillSession = await client.session.new({
    sessionKey: crypto.randomUUID(),
    cwd: runtime.workspace,
    preset: 'full-access',
  })
  await skillSession.attach()
  await prompt(skillSession, 'call skill_read {"name":"reviewed-published"}')
  expect(JSON.stringify(await toolResult(skillSession, 'skill_read'))).toContain(
    'Synthetic reusable workflow.',
  )
  await prompt(old, 'call skill_read {"name":"reviewed-published"}')
  expect(JSON.stringify(await toolResult(old, 'skill_read'))).toContain('Synthetic reusable workflow.')
  expect((await old.tools()).tools.some((t) => t.name === 'my_text_stats')).toBe(false)
  const list = JSON.parse(await runtime.cli(['plugins', 'candidates', 'list', '--json'])) as {
    candidates: { state: string }[]
  }
  expect(list.candidates.some((c) => c.state === 'published')).toBe(true)
  await info.attach('reviewed-publication.json', {
    body: JSON.stringify({ reviewed, provenance }),
    contentType: 'application/json',
  })
  // Installed provenance opens the retained published candidate, not the pending replacement.
  await page.getByRole('button', { name: `View details for ${draft.packageId}`, exact: true }).click()
  await page
    .getByRole('dialog', { name: 'Plugin details', exact: true })
    .getByTestId('plugin-fact-chain')
    .click()
  const publishedFacts = page.getByTestId('fact-chain').locator('[data-fact-kind="authoring"]')
  await expect(publishedFacts).toContainText(`${draft.packageId} 0.1.0 · Published`)
  await expect(publishedFacts).toContainText('Human review recorded')
  await expect(publishedFacts).toContainText('Tests passed: 1')
})
