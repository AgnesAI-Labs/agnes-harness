import { resolve } from 'node:path'
import { startProviderFixture } from '../acceptance/provider-fixture.js'
import { expect, test } from './fixtures.js'
import { prompt, toolResult } from './sdk.js'
import {
  chooseWorkspace,
  closeSettings,
  expand,
  fresh,
  homePage,
  preferences,
  section,
  selectValue,
  send,
  settings,
  turn,
} from './ui.js'

async function open(page: import('@playwright/test').Page, runtime: import('./runtime.js').Runtime) {
  await preferences(page)
  await page.goto(runtime.url)
  await chooseWorkspace(page, runtime)
}

test('v3 account dialog automatically tests a scripted provider before saving', async ({ page, runtime }) => {
  await open(page, runtime)
  const client = await runtime.connect()
  const model = (await client.config.test({ providerId: 'deepseek' })).models[0]?.id
  if (!model) throw new Error('Fixture requires the offline catalog model')
  const provider = await startProviderFixture('REG5_AUTO_TEST_ACCOUNT', undefined, model)
  try {
    await settings(page)
    await page.getByRole('button', { name: 'Add account', exact: true }).click()
    const dialog = page.locator('#account-dialog')
    await dialog.locator('[data-provider="deepseek"]').click()
    await expand(dialog.locator('#config-account-advanced'))
    await dialog.locator('#config-account-name').fill('REG5 offline provider')
    await dialog.locator('#config-base-url').fill(provider.baseUrl)
    await dialog.locator('#config-api-key').fill(provider.apiKey)
    await expect(dialog.locator('#config-state')).toContainText(/Connection successful|Connected/)
    await expect(dialog.locator('#config-model-fields')).toBeVisible()
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog).toBeHidden()
    expect((await client.config.get()).accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'REG5 offline provider', credentialConfigured: true }),
      ]),
    )
    await closeSettings(page)
    await fresh(page)
    await turn(page, 'Use automatically tested account')
    await expect(page.getByTestId('conversation-turn')).toContainText('REG5_AUTO_TEST_ACCOUNT')
  } finally {
    await provider.close()
  }
})

test('v3 plugin tabs and built-in context save survive navigation and reload', async ({ page, runtime }) => {
  await open(page, runtime)
  for (const tab of ['plugins', 'skills', 'mcp', 'review', 'market']) {
    await homePage(page, 'plugins', tab)
    await expect(
      page.getByRole('tab').filter({ has: page.getByTestId(`plugins-tab-${tab}`) }),
    ).toHaveAttribute('aria-selected', 'true')
  }
  // The custom instructions are on the General page of settings.
  await settings(page)
  await section(page, 'general')
  await page.getByTestId('system-prompt-personaPrefix').fill('REG5 persisted opening instruction')
  await page.getByTestId('system-prompt-save').click()
  await expect(page.getByTestId('system-prompt-saved')).toBeVisible()
  await page.reload()
  await settings(page)
  await section(page, 'general')
  await expect(page.getByTestId('system-prompt-personaPrefix')).toHaveValue(
    'REG5 persisted opening instruction',
  )
})

test('v3 local package install and enable requires consent and disable/uninstall persists', async ({
  page,
  runtime,
}) => {
  test.setTimeout(120_000)
  await open(page, runtime)
  await homePage(page, 'plugins')
  await page.getByTestId('plugin-install-source').click()
  const source = page.getByRole('dialog', { name: 'Check a plugin source', exact: true })
  await source.getByRole('combobox', { name: 'Source type', exact: true }).selectOption('file')
  await source
    .getByRole('textbox', { name: 'Source reference', exact: true })
    .fill(`file:${resolve('examples/packages/hot-tool-plugin')}`)
  await source.getByRole('button', { name: 'Check source', exact: true }).click()
  const consent = page.locator('#plugin-confirm')
  await expect(consent).toBeVisible()
  const client = await runtime.connect()
  const installed = async () =>
    (await client.packages.list({ profile: 'local-dev' })).packages.find(
      (row) => row.id === '@agnes-examples/hot-tool-plugin',
    )
  expect(await installed()).toBeUndefined()
  await expect(consent).toContainText('What it gets')
  await consent.getByRole('button', { name: 'Install and enable', exact: true }).click()
  await expect.poll(async () => (await installed())?.desired).toBe('enabled')
  const detail = page.locator('#plugin-detail')
  if (await detail.isVisible()) await page.getByTestId('push-back').click()
  const row = page.locator('.plugin-row[data-plugin-id="@agnes-examples/hot-tool-plugin"]')
  await row.getByRole('switch').click()
  await consent.getByRole('button', { name: 'Disable', exact: true }).click()
  await expect.poll(async () => (await installed())?.desired).toBe('installed-disabled')
  if (await detail.isVisible()) await page.getByTestId('push-back').click()
  await row.locator('.plugin-details-button').click()
  await page
    .getByRole('tab')
    .filter({ has: page.getByTestId('plugin-versions-tab') })
    .click()
  await detail.getByRole('button', { name: 'Uninstall plugin', exact: true }).click()
  await consent.getByRole('button', { name: 'Uninstall', exact: true }).click()
  await expect.poll(installed).toBeUndefined()
  await page.reload()
  await expect(row).toHaveCount(0)
})

test('v3 MCP two-step local wizard saves a stdio fixture only after consent', async ({ page, runtime }) => {
  await open(page, runtime)
  await fresh(page)
  await turn(page, 'Prepare the Demo MCP wizard session')
  await homePage(page, 'plugins', 'mcp')
  await page.getByTestId('mcp-create').click()
  const dialog = page.locator('#mcp-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('#mcp-step')).toContainText(/1/)
  await expect(dialog.locator('#mcp-command')).toBeHidden()
  await dialog.locator('#mcp-method-local').click()
  await expect(dialog.locator('#mcp-step')).toContainText(/2/)
  await dialog.locator('#mcp-command').fill(`node ${resolve('tools/e2e-web/fixtures/mcp.mjs')}`)
  await expand(dialog.locator('#mcp-advanced'))
  await dialog.locator('#mcp-name').fill('REG5 stdio')
  await dialog.locator('#mcp-id').fill('reg5-stdio')
  await selectValue(page, 'mcp-sandbox', 'off-with-warning')
  await dialog.locator('#mcp-form button[type=submit]').click()
  await expect(page.locator('#admin-confirm')).toBeVisible()
  const client = await runtime.connect()
  const servers = async () => (await client.mcp.servers.list({ profile: 'local-dev' })).items
  expect((await servers()).some((row) => row.serverId === 'reg5-stdio')).toBe(false)
  await page.locator('#admin-confirm-action').click()
  await expect(dialog).toBeHidden()
  await expect
    .poll(async () => (await servers()).find((row) => row.serverId === 'reg5-stdio')?.displayName)
    .toBe('REG5 stdio')
  await page.getByRole('switch', { name: 'Enable REG5 stdio', exact: true }).click()
  await page.locator('#admin-confirm-action').click()
  await expect
    .poll(async () => (await servers()).find((row) => row.serverId === 'reg5-stdio')?.desired)
    .toBe('enabled')
  await page.reload()
  await expect(page.locator('.plugins-page-resources')).toContainText('REG5 stdio')
  await expect(page.getByRole('switch', { name: 'Disable REG5 stdio', exact: true })).toBeChecked()
  const probe = await client.session.new({
    sessionKey: crypto.randomUUID(),
    cwd: runtime.workspace,
    preset: 'full-access',
  })
  await probe.attach()
  const tool = (await probe.tools()).tools.find(
    (item) => item.name.includes('reg5') && item.name.endsWith('__echo'),
  )
  if (!tool) throw new Error('The wizard-installed stdio server must expose its echo tool')
  await closeSettings(page)
  await fresh(page)
  await turn(page, `call ${tool.name} {"text":"REG5_WIZARD_ECHO"}`)
  const id = new URL(page.url()).searchParams.get('session')
  if (!id) throw new Error('MCP invocation must create its browser session')
  const session = await client.session.load(id, { cwd: runtime.workspace })
  await session.attach()
  expect((await toolResult(session, tool.name))?.content).toEqual([
    { type: 'text', text: 'REG5_WIZARD_ECHO' },
  ])
})

test('v3 business Agent one-click start installs its bundle and creates a Demo session', async ({
  page,
  runtime,
}) => {
  test.setTimeout(120_000)
  await open(page, runtime)
  await homePage(page, 'agents')
  await fresh(page)
  await turn(page, 'Prepare the offline Demo workspace')
  await fresh(page)
  await homePage(page, 'agents')
  const card = page.locator('[data-testid^="business-agent-"][data-package="@agnes-fde/knowledge-qa"]')
  await expect(card).toBeVisible()
  const packageId = await card.getAttribute('data-package')
  if (!packageId) throw new Error('Business Agent card requires a package')
  await card.getByRole('button').click()
  const confirm = page.getByTestId('agent-start-confirm')
  await expect(confirm).toBeVisible()
  await confirm.click()
  await expect(page.locator('#home-page')).toBeHidden({ timeout: 25_000 })
  await expect(page.locator('#prompt')).toHaveValue(/refund/)
  const requestedBundles = new URL(page.url()).searchParams.getAll('bundle')
  expect(requestedBundles.length).toBeGreaterThan(0)
  const workspace = page.getByRole('dialog', { name: 'Choose a workspace', exact: true })
  if (!(await workspace.isVisible())) await page.locator('#composer-workspace').click()
  await workspace
    .locator('.workspace-option')
    .filter({ has: page.locator('.workspace-option-name').filter({ hasText: /^w$/ }) })
    .click()
  await expect(workspace).toBeHidden()
  await expect(page.getByRole('textbox', { name: 'Task content', exact: true })).toBeEnabled()
  await page
    .getByRole('textbox', { name: 'Task content', exact: true })
    .fill('What is the refund window and who reviews refund requests?')
  await page.getByRole('textbox', { name: 'Task content', exact: true }).press('Enter')
  await expect(page.getByTestId('conversation-turn')).toHaveAttribute('data-status', 'completed', {
    timeout: 25_000,
  })
  const client = await runtime.connect()
  const id = new URL(page.url()).searchParams.get('session')
  if (!id) throw new Error('One-click start must create a session')
  const session = await client.session.load(id, { cwd: runtime.workspace })
  await session.attach()
  const runtimeInfo = await client.session.runtime(id)
  expect(runtimeInfo.preset?.bundles).toEqual(requestedBundles)
  expect(runtimeInfo.loop).toMatchObject({ id: 'fde.knowledge-qa' })
})

test('v3 automation creates and removes a scheduled task for the selected Demo session', async ({
  page,
  runtime,
}) => {
  await open(page, runtime)
  await fresh(page)
  await turn(page, 'REG5_SCHEDULE_SESSION')
  const id = new URL(page.url()).searchParams.get('session')
  await homePage(page, 'automation')
  await page.getByTestId('schedules-new').click()
  await page.getByTestId('schedules-target-session').click()
  await page.getByTestId('schedules-title').fill('REG5 future task')
  await page.getByTestId('schedules-prompt').fill('REG5 synthetic scheduled prompt')
  await page.getByTestId('schedules-kind-once').click()
  const future = await page.evaluate(() =>
    new Date(Date.now() + 86_400_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16),
  )
  await page.getByTestId('schedules-when').fill(future)
  await page.getByTestId('schedules-create').click()
  const row = page.getByTestId('schedules-row').filter({ hasText: 'REG5 future task' })
  await expect(row).toBeVisible()
  const client = await runtime.connect()
  const schedules = async () =>
    client.call<import('@agnes/protocol').SchedulesListResult>('_agnes/v1/schedules.list', {
      scope: 'session',
      sessionKey: id,
    })
  expect((await schedules()).schedules).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ title: 'REG5 future task', target: { kind: 'session', sessionKey: id } }),
    ]),
  )
  await row.getByTestId('schedules-actions').click()
  await page.getByTestId('schedules-archive').click()
  await page.getByTestId('schedules-archive-confirm').click()
  await expect(row).toHaveCount(0)
  await page.reload()
  await expect(row).toHaveCount(0)
})

test('v3 runtime dialog lists and revokes a session approval grant', async ({ page, runtime }) => {
  await open(page, runtime)
  await page.locator('#new').click()
  const current = await send(page, 'call shell {"command":"printf REG5_SESSION_GRANT"}')
  await page.getByRole('button', { name: 'Allow all shell calls in this session', exact: true }).click()
  await expect(current).toHaveAttribute('data-status', 'completed')
  const id = new URL(page.url()).searchParams.get('session')
  if (!id) throw new Error('Approval grant needs a session')
  const client = await runtime.connect()
  const session = await client.session.load(id, { cwd: runtime.workspace })
  await session.attach()
  expect(JSON.stringify(await toolResult(session, 'shell'))).toContain('REG5_SESSION_GRANT')
  await page.locator(`.session[data-session="${id}"]`).hover()
  await page.locator(`[data-session-action-id="${id}"]`).click()
  await page.getByRole('menuitem', { name: 'Runtime info', exact: true }).click()
  await expect(page.getByTestId('session-runtime-grants')).toBeVisible()
  const grant = page.getByTestId('session-runtime-grant')
  await expect(grant).toContainText('shell')
  await grant.getByTestId('session-runtime-grant-revoke').click()
  await expect(grant).toHaveCount(0)
  expect((await client.approval.sessionGrants(id)).grants).toEqual([])
})

test('v3 pending review inbox opens a real Demo-authored draft and preserves its files', async ({
  page,
  runtime,
}) => {
  await open(page, runtime)
  const client = await runtime.connect()
  const session = await client.session.new({
    sessionKey: crypto.randomUUID(),
    cwd: runtime.workspace,
    preset: 'full-access',
  })
  await session.attach()
  session.onPermissionRequest(async () => ({ verdict: 'allowed-once' }))
  const content =
    '---\nname: REG5 reviewed method\ndescription: Offline review fixture\n---\n\nRead the approved report.\n'
  await prompt(
    session,
    'call skill_helper_create ' +
      JSON.stringify({ name: 'reg5-reviewed-method', files: [{ path: 'SKILL.md', content }] }),
  )
  const created = (await toolResult(session, 'skill_helper_create'))?.content[0]
  if (created?.type !== 'text') throw new Error('Draft creation must return its candidate')
  const candidate = JSON.parse(created.text) as import('@agnes/protocol').AuthoringCandidate
  await prompt(
    session,
    'call skill_helper_install ' + JSON.stringify({ action: 'test', proposalId: candidate.candidateId }),
  )
  await prompt(
    session,
    'call skill_helper_install ' + JSON.stringify({ action: 'commit', proposalId: candidate.candidateId }),
  )
  await homePage(page, 'plugins', 'review')
  const row = page.getByTestId('candidate-list').locator(`li[data-candidate-id="${candidate.candidateId}"]`)
  await expect(row).toContainText('Awaiting review')
  await row.getByTestId('candidate-open').click()
  const review = page.getByTestId('candidate-review')
  await expect(review).toBeVisible()
  const file = review.getByTestId('candidate-file-diff').filter({ hasText: 'SKILL.md' })
  await expand(file)
  await expect(file).toContainText('Read the approved report.')
  expect(
    (await client.packages.list({ profile: 'local-dev' })).packages.some(
      (pkg) => pkg.id === candidate.packageId,
    ),
  ).toBe(false)
})
