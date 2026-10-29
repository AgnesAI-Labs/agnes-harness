import { createHmac } from 'node:crypto'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WebhookRequest, WebhookResult } from '@agnes/protocol/gen/app-server'
import { expect, test } from './fixtures.js'
import { readSessionEvents } from './ledger.js'
import { accessible, translated } from './quality.js'
import { chooseWorkspace, homePage, preferences } from './ui.js'

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
  await homePage(page, 'automation')
  await expect(page.getByTestId('schedules-page')).toBeVisible()
  await expect(page.getByTestId('triggers-panel')).toHaveCount(0)
  // Trigger configuration is intentionally absent from the UI. Its existing same-origin BFF
  // still owns webhook administration; retain delivery and session acceptance through that API.
  const administer = (input: WebhookRequest): Promise<WebhookResult> =>
    page.evaluate(async (body) => {
      const response = await fetch('/api/triggers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      if (!response.ok) throw new Error(`Trigger administration failed: ${response.status}`)
      return response.json()
    }, JSON.stringify(input))
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
  const saved = await administer({
    action: 'upsert',
    rule: {
      id: 'business-issues',
      enabled: true,
      provider: 'github',
      auth: 'hmac',
      secretRef: 'secret://webhooks/sample',
      event: 'issues',
      filters: { '$.action': 'opened' },
      workspace: cwd,
      agent: 'standard',
      bundles: [],
      template: 'Review this issue: {{$.issue.title}}',
      timestampPath: '$.issue.updated_at',
      windowSeconds: 300,
      ratePerMinute: 10,
    },
  })
  expect(saved.snapshot?.rules).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: 'business-issues' })]),
  )
  if (!saved.snapshot) throw new Error('Missing trigger configuration snapshot')
  await administer({ action: 'configure', config: { ...saved.snapshot.config, enabled: true } })
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
  expect((await administer({ action: 'list' })).snapshot?.deliveries).toHaveLength(4)
  await translated(page)
  await accessible(page, info, 'automation')
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
  const events = await readSessionEvents(session)
  const messages = events.filter((row) => row.type === 'user/message').slice(0, 100)
  expect(messages[0]).toMatchObject({
    origin: 'system',
    trust: 'untrusted',
    actor: {
      id: 'webhook:business-issues',
      org: 'webhook',
      attrs: { provider: 'github', ruleId: 'business-issues', deliveryId: 'synthetic-delivery' },
    },
  })
  await page.goto(`${runtime.url}/?session=${encodeURIComponent(result.delivery.sessionId)}`)
  await expect(page).toHaveURL(new RegExp(`session=${encodeURIComponent(result.delivery.sessionId)}`))
  await expect(page.getByTestId('conversation-turn')).toHaveCount(1)
  await expect(page.getByTestId('conversation-turn')).toHaveAttribute('data-status', 'completed', {
    timeout: 30000,
  })
  await expect(page.getByTestId('conversation-turn')).toContainText('UNTRUSTED')
  const start = events.find((row) => row.type === 'session/start')
  expect(start?.data).toMatchObject({ preset: 'standard' })
  expect((await client.session.runtime(session.id)).policy?.permission).toMatchObject({
    policy: 'workspace-write',
  })
})
