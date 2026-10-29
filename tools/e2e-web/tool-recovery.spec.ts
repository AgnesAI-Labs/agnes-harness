import { startProviderFixture } from '../acceptance/provider-fixture.js'
import { expect, test } from './fixtures.js'
import { install } from './sdk.js'
import { preferences } from './ui.js'

test('invalid tool arguments stop after one correction and collapse into a text fallback', async ({
  page,
  runtime,
}) => {
  test.setTimeout(120_000)
  const client = await runtime.connect()
  const fixture = await startProviderFixture(
    '文字调查结论：观测已读取，仍需独立复验。',
    undefined,
    'deepseek-flash',
    undefined,
    true,
  )
  try {
    await client.config.save({
      providerId: 'deepseek',
      model: 'deepseek-flash',
      baseUrl: fixture.baseUrl,
      apiKey: fixture.apiKey,
      accountId: 'argument-recovery',
      label: 'Offline argument recovery',
      makeDefault: true,
      expectedRevision: (await client.config.get()).revision,
    })
    await install(client, 'tools/e2e-web/fixtures/tool-argument-recovery')
    const session = await client.session.new({
      cwd: runtime.workspace,
      preset: 'standard',
      bundles: [],
      sessionKey: crypto.randomUUID(),
    })
    await session.attach()
    await session.setModel({ slot: 'primary', route: 'account-argument-recovery', model: 'deepseek-flash' })
    fixture.queueTool({ name: 'recovery_probe', args: { observation: 'synthetic' } })
    fixture.queueTool({ name: 'ui_render', args: { locale: 'zh-CN', surface: {} } })
    fixture.queueTool({ name: 'ui_render', args: { surface: { revision: 0 } } })
    await preferences(page, 'zh-CN')
    await page.goto(`${runtime.url}/?session=${encodeURIComponent(session.id)}`)
    await page.getByRole('textbox', { name: '任务内容', exact: true }).fill('读取观测并展示调查结果。')
    await page.locator('#send').click()
    await expect(page.locator('.conversation-turn[data-status="completed"]')).toBeVisible({ timeout: 60_000 })
    const note = page.getByTestId('tool-argument-recovery')
    await expect(note).toHaveCount(1)
    await expect(note).toHaveAttribute('data-open', 'false')
    await expect(note.getByRole('button').first()).toContainText('界面组件生成失败，已改用文字回答')
    await expect(page.locator('.turn-final')).toContainText('文字调查结论')
    await expect(page.locator('.turn-final')).not.toContainText('TOOL_ARGS_INVALID')
    await expect(page.getByTestId('approval-card')).toHaveCount(0)
    const timeline = await session.projectUI(undefined, { surface: 'web' })
    const attempts = timeline.nodes.filter((n) => n.kind === 'tool' && n.name === 'ui_render')
    expect(attempts).toHaveLength(2)
    expect(attempts.every((n) => n.status === 'failed')).toBe(true)
    expect(timeline.nodes.filter((node) => node.kind === 'approval')).toEqual([])
    const requests = fixture.requests.filter((r) => r.tools.length)
    expect(requests.at(-1)?.tools).not.toContain('ui_render')
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain(
      'Continue with other available tools and answer in text/markdown',
    )
    await note.getByRole('button').first().click()
    await expect(note).toHaveAttribute('data-open', 'true')
    await expect(note).toContainText('ui_render')
  } finally {
    await fixture.close()
  }
})

for (const locale of ['zh-CN', 'en'] as const) {
  test(`content verification stops after one repair and preserves the answer (${locale})`, async ({
    page,
    runtime,
  }) => {
    test.setTimeout(120_000)
    const client = await runtime.connect()
    let drafts = 0
    const fixture = await startProviderFixture('', undefined, 'deepseek-flash', async function* () {
      yield ++drafts === 1
        ? 'Available evidence: the observation is preserved.'
        : 'Revised answer: an independent check is still needed.'
    })
    try {
      await client.config.save({
        providerId: 'deepseek',
        model: 'deepseek-flash',
        baseUrl: fixture.baseUrl,
        apiKey: fixture.apiKey,
        accountId: 'blocked-recovery',
        label: 'Offline completion check',
        makeDefault: true,
        expectedRevision: (await client.config.get()).revision,
      })
      await install(client, 'tools/e2e-web/fixtures/tool-argument-recovery')
      for (let i = 0; i < 3; i++)
        fixture.queueTool({ name: 'recovery_record', args: { observation: 'same synthetic progress' } })
      const session = await client.session.new({
        cwd: runtime.workspace,
        preset: 'standard',
        bundles: [],
        sessionKey: crypto.randomUUID(),
      })
      await session.attach()
      await session.setModel({ slot: 'primary', route: 'account-blocked-recovery', model: 'deepseek-flash' })
      await preferences(page, locale)
      await page.goto(`${runtime.url}/?session=${encodeURIComponent(session.id)}`)
      await page
        .getByRole('textbox', { name: locale === 'en' ? 'Task content' : '任务内容', exact: true })
        .fill('Summarize the available evidence.')
      await page.locator('#send').click()
      await expect(page.locator('.conversation-turn[data-status="failed"]')).toBeVisible({ timeout: 60_000 })
      const note = page.getByTestId('turn-verification')
      await expect(note).toHaveCount(1)
      await expect(note).toHaveAttribute('data-open', 'false')
      await expect(note).toHaveAttribute('data-variant', 'plain')
      await expect(note.locator('.agh-disclosure-chevron')).toHaveCount(1)
      await expect(note.locator('.agh-disclosure-marker')).toHaveCount(0)
      await expect(page.locator('#status')).toHaveAttribute('data-state', 'not-verified')
      await expect(page.locator('#status')).toHaveAttribute(
        'aria-label',
        locale === 'en' ? 'Not verified' : '未通过校验',
      )
      await expect(page.getByTestId('turn-timing')).toContainText(
        locale === 'en' ? 'Not verified' : '未通过校验',
      )
      await expect(page.getByTestId('turn-timing')).not.toContainText(locale === 'en' ? 'Failed' : '执行失败')
      const warning = await page.locator('#status').evaluate((element) => getComputedStyle(element).color)
      await expect(page.locator('.turn-status')).toHaveCSS('color', warning)
      await expect(page.getByTestId('turn-timing')).toHaveCSS('color', warning)

      await expect(note).toContainText(
        locale === 'en' ? 'automatic correction has stopped' : '回答仍未通过校验',
      )
      await expect(
        page.getByText('Available evidence: the observation is preserved.', { exact: true }),
      ).toBeVisible()
      await expect(page.locator('.turn-final')).toContainText(
        'Revised answer: an independent check is still needed.',
      )
      await expect(page.locator('.turn-error')).toHaveCount(0)
      await expect(page.getByTestId('approval-card')).toHaveCount(0)
      await expect(
        page.getByRole('region', { name: locale === 'en' ? 'Conversation' : '对话', exact: true }),
      ).not.toContainText(/repeated_write|OUTPUT_LIMIT|schema_invalid/)
      await expect(
        page.getByRole('textbox', { name: locale === 'en' ? 'Task content' : '任务内容', exact: true }),
      ).toBeEnabled()
      const timeline = await session.projectUI(undefined, { surface: 'web' })
      expect(timeline.turns.at(-1)).toMatchObject({ reason: 'blocked', verification: 'blocked' })
      expect(drafts).toBe(2)
      expect(fixture.requests.filter((request) => request.tools.length)).toHaveLength(5)
    } finally {
      await fixture.close()
    }
  })
}
