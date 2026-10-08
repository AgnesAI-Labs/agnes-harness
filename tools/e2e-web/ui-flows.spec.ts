import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Page } from '@playwright/test'
import { startProviderFixture } from '../acceptance/provider-fixture.js'
import { expect, test } from './fixtures.js'
import { accessible, screen, translated } from './quality.js'
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
  const session = page.getByTestId('conversation-turn').last()
  const process = session.getByTestId('turn-process-toggle')
  if (await process.isVisible()) await process.click()
  await session.getByTestId('tool-detail-toggle').click()
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
  await screen(page, info, 'tool-row-en-light')
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
    await page.getByRole('option', { name: 'DeepSeek', exact: true }).click()
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

test('UI folder install reviews capabilities, enables a tool and disables it for new sessions', async ({
  page,
  runtime,
}, info) => {
  test.setTimeout(120_000)
  await open(page, runtime)
  await settings(page)
  await section(page, 'plugins')
  await page.getByRole('button', { name: 'Install from source', exact: true }).click()
  const source = page.getByRole('dialog', { name: 'Inspect a plugin from a source', exact: true })
  await source.getByRole('combobox', { name: 'Source type', exact: true }).selectOption('file')
  await source
    .getByRole('textbox', { name: 'Source reference', exact: true })
    .fill(`file:${resolve('examples/packages/hot-tool-plugin')}`)
  await source.getByRole('button', { name: 'Inspect contents', exact: true }).click()
  const review = page.getByRole('dialog', { name: 'Confirm the action', exact: true })
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
  await review.getByRole('button', { name: 'Confirm enable', exact: true }).click()
  await expect(review).toBeHidden()
  const toggle = page.getByRole('switch', {
    name: 'Request to disable @agnes-examples/hot-tool-plugin',
    exact: true,
  })
  await expect(toggle).toBeChecked()
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
    .getByRole('dialog', { name: 'Confirm the action', exact: true })
    .getByRole('button', { name: 'Confirm disable', exact: true })
    .click()
  await expect(
    page.getByRole('switch', { name: 'Request to enable @agnes-examples/hot-tool-plugin', exact: true }),
  ).not.toBeChecked()
  await closeSettings(page)
  await fresh(page)
  await turn(page, 'A new session after disabling the plugin')
  const newer = await current(page, runtime)
  expect((await newer.tools()).tools.some((tool) => tool.name === 'demo_text_stats')).toBe(false)
  await page.goto(new URL(`/?session=${encodeURIComponent(old.id)}`, runtime.url).href)
  await turn(page, 'call demo_text_stats {"text":"old session remains bound"}')
  expect((await toolResult(old, 'demo_text_stats'))?.structured).toMatchObject({ words: 4 })
})

test('UI local rescan preserves old/new code through a daemon restart', async ({ page, runtime }, info) => {
  test.setTimeout(120_000)
  await open(page, runtime)
  const rescan = async (version: number) => {
    await runtime.localTool(version)
    await settings(page)
    await section(page, 'plugins')
    await page.getByTestId('plugin-diagnostics-toggle').click()
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
    await turn(page, 'call e2e_version {"text":"restored"}')
    const restored = await current(page, runtime)
    expect((await toolResult(restored, 'e2e_version'))?.structured).toMatchObject({ version })
    await expect(await detail(page, 'e2e_version')).toContainText(`"version": ${version}`)
  }
  await quality(page, info, 'restarted-generations')
})

test('UI FDE bundle selection runs and restores its durable deliverable', async ({ page, runtime }, info) => {
  test.setTimeout(120_000)
  const client = await runtime.connect()
  await install(client, 'examples/fde/knowledge-qa')
  await open(page, runtime)
  await page.getByTestId('composer-agent').click()
  await page.getByTestId('new-session-bundles').click()
  await page.getByRole('option', { name: /knowledge-qa/ }).click()
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
