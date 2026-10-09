import { createHmac } from 'node:crypto'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './fixtures.js'
import { readSessionEvents } from './ledger.js'
import { accessible, translated } from './quality.js'
import { chooseWorkspace, preferences, section, settings } from './ui.js'

test('signed business event creates a policy-bound root session', async ({
  page,
  runtime,
  request,
}, info) => {
  test.setTimeout(120000)
  const secret = ['synthetic', 'webhook', 'fixture'].join('-')
  await mkdir(join(runtime.home, 'secrets/webhooks'), { recursive: true, mode: 0o700 })
  await writeFile(join(runtime.home, 'secrets/webhooks/sample'), secret, { mode: 0o600 })
  const cwd = await realpath(runtime.workspace)
  const client = await runtime.connect()
  // local-dev is the existing offline scripted model: no external provider calls.
  await preferences(page, 'zh-CN', 'light')
  await page.goto(runtime.url)
  await chooseWorkspace(page, runtime, 'zh-CN')
  await settings(page, 'zh-CN')
  await section(page, 'triggers')
  await expect(page.getByTestId('triggers-panel')).toHaveAttribute('aria-busy', 'false')
  const body = JSON.stringify({
    action: 'opened',
    issue: { title: 'Synthetic signed issue', updated_at: new Date().toISOString() },
  })
  const headers = {
    'Content-Type': 'application/json',
    'x-github-delivery': 'synthetic-delivery',
    'x-github-event': 'issues',
    'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
  }
  expect((await request.post(`${runtime.url}/hooks/events`, { headers, data: body })).status()).toBe(404)
  await page.getByTestId('trigger-id').fill('business-issues')
  await page.getByTestId('trigger-secret-picker').selectOption('secret://webhooks/sample')
  await page.getByTestId('trigger-workspace').selectOption(cwd)
  await page.getByTestId('trigger-agent').fill('read-only')
  await page.getByTestId('trigger-save').click()
  await expect(page.getByTestId('trigger-row')).toContainText('business-issues')
  await page.getByTestId('triggers-enabled').click()
  await page.getByTestId('triggers-configure').click()
  await expect(page.getByTestId('triggers-panel')).toHaveAttribute('aria-busy', 'false')
  expect(
    (
      await request.post(`${runtime.url}/hooks/events`, {
        headers: { ...headers, 'x-hub-signature-256': 'sha256=bad' },
        data: body,
      })
    ).status(),
  ).toBe(401)
  const accepted = await request.post(`${runtime.url}/hooks/events`, { headers, data: body })
  expect(accepted.status(), await accepted.text()).toBe(202)
  const result = await accepted.json()
  expect(result.delivery.sessionId).toMatch(/^agnes:webhook:business-issues:/)
  expect((await request.post(`${runtime.url}/hooks/events`, { headers, data: body })).status()).toBe(409)
  await page.getByTestId('triggers-refresh').click()
  await expect(page.getByTestId('trigger-delivery')).toHaveCount(4)
  await translated(page)
  await accessible(page, info, 'triggers-settings')
  const session = await client.session.load(result.delivery.sessionId)
  await expect
    .poll(
      async () => {
        const ui = await session.projectUI()
        return JSON.stringify(ui)
      },
      { timeout: 30000 },
    )
    .toContain('Synthetic signed issue')
  const messages = (await readSessionEvents(session))
    .filter((row) => row.type === 'user/message')
    .slice(0, 100)
  expect(messages[0]).toMatchObject({
    origin: 'system',
    trust: 'untrusted',
    actor: {
      id: 'webhook:business-issues',
      org: 'webhook',
      attrs: { provider: 'github', ruleId: 'business-issues', deliveryId: 'synthetic-delivery' },
    },
  })
  await page.getByTestId('trigger-session').first().click()
  await expect(page).toHaveURL(new RegExp(`session=${encodeURIComponent(result.delivery.sessionId)}`))
  await expect(page.getByTestId('conversation-turn')).toHaveCount(1)
  await expect(page.getByTestId('conversation-turn')).toHaveAttribute('data-status', 'completed', {
    timeout: 30000,
  })
  await expect(page.getByTestId('conversation-turn')).toContainText('UNTRUSTED')
  const loaded = await client.call<{ modes?: { currentModeId: string } }>('session/load', {
    sessionId: result.delivery.sessionId,
    cwd,
    mcpServers: [],
  })
  expect(loaded.modes?.currentModeId).toBe('read-only')
})
