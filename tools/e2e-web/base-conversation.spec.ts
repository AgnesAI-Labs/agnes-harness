import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { isolatedRuntime } from './runtime.js'
import { command, install, prompt, toolResult } from './sdk.js'
import { expandActivityGroups, preferences } from './ui.js'

// Playwright's SW-block init script reads navigator.serviceWorker in opaque sandbox frames.
// These synthetic local pages register no worker; keep the renderer's sandbox unchanged.
test.use({ serviceWorkers: 'allow' })

const report = process.env.AGH_CONVERSATION_REPORT
async function capture(page: Page, name: string) {
  if (!report) return
  await mkdir(report, { recursive: true })
  await page.screenshot({ path: join(report, `${name}.png`), animations: 'disabled' })
  await writeFile(join(report, `${name}.txt`), await page.locator('body').innerText())
}
async function panel(page: Page, id: string, title: string) {
  const toggle = page.getByTestId('workbench-right-toggle')
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  const tab = page.getByTestId(`workbench-tab-${id}`)
  if (await tab.isVisible()) await tab.click()
  else {
    await page
      .locator('#workbench-right .workbench-dock-heading')
      .getByRole('button', { name: /^(More|更多)$/ })
      .click()
    await page.getByRole('menuitem', { name: title, exact: true }).click()
  }
}

test('base conversation speaks human with a local scripted model and plain application', async ({
  page,
}, info) => {
  test.setTimeout(180_000)
  // realModel chooses the required home parent only; local-dev still selects the zero-cost demo.
  const runtime = await isolatedRuntime('root', { realModel: true })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    await runtime.start()
    const client = await runtime.connect()
    await writeFile(
      join(runtime.workspace, 'brief.md'),
      'Budget 800. Event 14:00-16:00. Check-in 14:00-14:15.\n',
    )
    // Deliberate synthetic diagnostics: one recognized environment line and one real script warning.
    await writeFile(
      join(runtime.workspace, 'count_words.py'),
      `import pathlib,sys
print(len(pathlib.Path(sys.argv[1]).read_text().split()))
sys.stderr.write("xcrun: error: couldn't create cache file '/tmp/xcrun_db-test' (errno=Operation not permitted)\\nscript warning: record incomplete\\n")
`,
    )
    await writeFile(
      join(runtime.workspace, 'report.html'),
      '<!doctype html><html><head><meta charset="utf-8"><style>body{font:20px system-ui;margin:48px}main{display:grid;grid-template-columns:1fr 1fr;gap:40px}section{padding:32px;border:1px solid #aaa}</style></head><body><h1>活动报告 / Event report</h1><main><section>14:00–16:00<br>Check-in 14:00–14:15</section><section>Budget 800<br>Ticket price unspecified</section></main></body></html>',
    )
    await install(client, 'tools/e2e-web/fixtures/base-conversation')
    const preview = await client.request('_agnes/v1/applications.preview', {
      profile: 'local-dev',
      packageId: 'plain-conversation-test',
    })
    const application = await client.request('_agnes/v1/applications.get', { profile: 'local-dev' })
    await client.request('_agnes/v1/applications.adopt', {
      ...(await command(client)),
      packageId: 'plain-conversation-test',
      expectedRevision: application.revision,
      consentDigest: preview.consentDigest,
    })
    for (const [locale, theme] of [
      ['zh-CN', 'light'],
      ['en', 'dark'],
    ] as const) {
      const zh = locale === 'zh-CN'
      if (!zh) {
        page = await page.context().newPage()
        page.on('pageerror', (error) => errors.push(error.message))
      }
      await preferences(page, locale, theme)
      const session = await client.session.new({
        sessionKey: randomUUID(),
        cwd: runtime.workspace,
        preset: 'standard',
      })
      await session.attach()
      await page.goto(`${runtime.url}/?session=${session.id}`)
      const running = session.prompt(
        `call shell ${JSON.stringify({ command: 'python3 count_words.py brief.md', description: zh ? '统计 brief.md 的字数，验证脚本结果' : 'Count words in brief.md to verify the script' })}`,
        { signal: AbortSignal.timeout(60_000) },
      )
      void running.catch(() => {})
      const approval = page.getByTestId('approval-card')
      await expect(approval).toBeVisible()
      await expect(approval.locator('.approval-summary-text')).not.toContainText('python3')
      await expect(approval.locator('.approval-summary-text')).toContainText(zh ? '运行命令' : 'Run command')
      await expect(
        page.getByTestId('conversation-turn').last().locator('[data-agnes-tool-card]'),
      ).toHaveCount(0)
      await expect(page.getByTestId('conversation-turn').last().getByTestId('approval-step')).toHaveCount(1)
      await expect(approval.locator('.agh-disclosure-chevron')).toBeVisible()
      await expect(approval.locator('.agh-disclosure-marker')).toHaveCount(0)
      await expect(approval.getByTestId('approval-preview')).toBeAttached()
      await expect(approval.getByTestId('approval-preview')).toBeHidden()
      await capture(page, `${locale}-${theme}-script-approval`)
      const details = approval.getByRole('button', {
        name: zh ? '技术详情' : 'Technical details',
        exact: true,
      })
      await details.click()
      await expect(approval.getByTestId('approval-preview')).toContainText('python3 count_words.py brief.md')
      await details.click()
      await approval
        .locator('[data-approval-action="durable:allowed-once"], [data-approval-action="live:allow_once"]')
        .click()
      expect((await running).reason).toBe('parked')
      const scriptTurn = page.getByTestId('conversation-turn').last()
      await expect(scriptTurn).toHaveAttribute('data-status', 'completed')
      await toolResult(session, 'shell')
      if ((await scriptTurn.getByTestId('turn-process-toggle').getAttribute('aria-expanded')) !== 'true')
        await scriptTurn.getByTestId('turn-process-toggle').click()
      await expandActivityGroups(scriptTurn)
      await expect(scriptTurn.getByTestId('tool-detail-toggle')).toHaveAttribute('aria-expanded', 'false')
      await expect(scriptTurn.getByTestId('tool-detail-text')).toBeHidden()
      await expect(scriptTurn.locator('.approval-summary')).toContainText(zh ? '运行命令' : 'Run command')
      await expect(scriptTurn.locator('.approval-summary').locator('..')).not.toHaveAttribute(
        'data-mono',
        'true',
      )
      await expect(
        scriptTurn.getByTestId('tool-detail-toggle').locator('.activity-target'),
      ).not.toHaveAttribute('data-mono', 'true')
      expect(
        await scriptTurn
          .getByTestId('tool-detail-toggle')
          .locator('.activity-target')
          .evaluate((element) => getComputedStyle(element).fontFamily),
      ).not.toMatch(/mono|Menlo|Consolas/i)
      await capture(page, `${locale}-${theme}-script-collapsed`)
      await scriptTurn.getByTestId('tool-detail-toggle').click()
      await expect(scriptTurn.getByTestId('tool-detail-text')).toContainText(
        'script warning: record incomplete',
      )
      await expect(scriptTurn.getByTestId('tool-command')).toHaveText('python3 count_words.py brief.md')
      await expect(scriptTurn.getByTestId('tool-stdout')).toHaveText('6')
      await expect(scriptTurn.getByTestId('tool-stderr')).toHaveText('script warning: record incomplete')
      await expect(scriptTurn.getByTestId('tool-raw-args')).toBeHidden()
      await expect(scriptTurn.locator('.tool-output .agh-tag')).toHaveText(zh ? '退出码 0' : 'Exit code 0')
      expect((await scriptTurn.locator('.tool-output .agh-tag').boundingBox())?.width).toBeLessThan(200)
      await expect(scriptTurn.locator('.tool-output .agh-disclosure-marker')).toHaveCount(0)
      await expect(
        scriptTurn.getByRole('button', {
          name: zh ? '环境提示（命令已成功）' : 'Environment warnings (command succeeded)',
        }),
      ).toBeVisible()
      const primaryCode = await scriptTurn.locator('.tool-output pre:visible').allTextContents()
      expect(primaryCode.filter((text) => text.includes('python3 count_words.py brief.md'))).toHaveLength(1)
      await capture(page, `${locale}-${theme}-script-result`)
      const rawArgs = scriptTurn.getByRole('button', { name: zh ? '原始参数' : 'Raw arguments', exact: true })
      await rawArgs.click()
      await expect(scriptTurn.getByTestId('tool-raw-args')).toContainText('python3 count_words.py brief.md')
      await rawArgs.click()
      await prompt(session, 'call present {"files":[{"path":"report.html","name":"Event report"}]}')
      await expect(page.getByTestId('turn-deliverables').last()).toBeVisible()
      await page
        .getByTestId('turn-deliverables')
        .last()
        .getByRole('button', { name: /Event report/ })
        .first()
        .click()
      const dock = page.locator('#workbench-right')
      expect((await dock.boundingBox())!.width).toBeGreaterThanOrEqual(500)
      await capture(page, `${locale}-${theme}-html-preview`)
      await page.getByRole('button', { name: zh ? '展开' : 'Expand', exact: true }).click()
      expect((await dock.boundingBox())!.width).toBeGreaterThan(700)
      await expect(dock.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts')
      await capture(page, `${locale}-${theme}-html-large`)
      await page.getByRole('button', { name: zh ? '收起' : 'Collapse', exact: true }).click()
      await page.getByTestId('workbench-right-toggle').click()
      const turn = page.getByTestId('conversation-turn').last()
      if ((await turn.getByTestId('turn-process-toggle').getAttribute('aria-expanded')) !== 'true')
        await turn.getByTestId('turn-process-toggle').click()
      await expandActivityGroups(turn)
      await turn.getByTestId('tool-detail-toggle').first().click()
      await turn.getByTestId('tool-fact-chain').first().click()
      await expect(page.locator('.trace-inspector [data-link="receipt"]')).toBeVisible()
      await expect(page.getByTestId('trace-gaps')).toBeHidden()
      // The fact chain opens the record's source pane in plain words, without the exactly-once disclaimer.
      await expect(page.getByTestId('trace-inspector-pane')).toHaveAttribute('data-pane', 'source')
      await expect(page.locator('.trace-inspector')).not.toContainText(/exactly once|恰好执行/)
      await expect(page.locator('.trace-inspector .agh-disclosure-marker')).toHaveCount(0)
      await capture(page, `${locale}-${theme}-trace`)
      await page.locator('#view-chat').click()
      const signing = session.prompt('call plain_review {}', { signal: AbortSignal.timeout(60_000) })
      void signing.catch(() => {})
      await expect(approval).toContainText(zh ? '签署审阅记录' : 'Sign reviewed record')
      await panel(page, 'application.signatures', zh ? '待签署' : 'Pending signatures')
      await expect(page.locator('#workbench-right [data-approval-action]')).toHaveCount(0)
      await expect(page.locator('#workbench-right')).toContainText(
        zh ? '等待在会话中确认' : 'Awaiting confirmation in conversation',
      )
      await capture(page, `${locale}-${theme}-signature`)
      await page
        .locator('#workbench-right')
        .getByRole('button', { name: zh ? '前往会话确认' : 'Go to confirmation' })
        .click()
      await expect(approval.locator('[data-approval-action="durable:allowed-once"]')).toBeFocused()
      await approval.locator('[data-approval-action="durable:allowed-once"]').click()
      expect((await signing).reason).toBe('completed')
      await expect(page.getByTestId('conversation-turn').last()).toHaveAttribute('data-status', 'completed')
      await panel(page, 'application.evidence', zh ? '证据与报告' : 'Evidence & reports')
      await expect(page.locator('#workbench-right .application-panel h3')).toHaveText(
        '审阅报告 / Review report',
      )
      await expect(page.locator('#workbench-right .application-panel')).toContainText(
        zh ? '可查看' : 'Available',
      )
      await expect(page.locator('#workbench-right code')).toBeHidden()
      await expect(page.locator('#workbench-right .application-panel .agh-disclosure-marker')).toHaveCount(0)
      await capture(page, `${locale}-${theme}-evidence`)
      await page
        .locator('#workbench-right .application-panel')
        .getByRole('button', { name: zh ? 'HTML 报告' : 'HTML report', exact: true })
        .click()
      await expect(page.getByTestId('file-preview')).toContainText('Ticket price unspecified')
      const timeline = await session.projectUI(undefined, { surface: 'web' })
      const models = timeline.nodes.flatMap((node) =>
        node.kind === 'cost' && node.model ? [node.model] : [],
      )
      expect(models.length).toBeGreaterThan(0)
      expect(models.every((model) => model === 'demo-model')).toBe(true)

      await writeFile(
        info.outputPath(`${locale}-runtime.json`),
        JSON.stringify({ home: runtime.home, url: runtime.url, sessionId: session.id, models, paidCalls: 0 }),
      )
    }
    expect(errors).toEqual([])
  } finally {
    await writeFile(info.outputPath('serve.log'), runtime.logs())
    await runtime.dispose()
  }
})
