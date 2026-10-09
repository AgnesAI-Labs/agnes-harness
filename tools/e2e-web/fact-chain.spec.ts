import { expect, test } from './fixtures.js'
import { accessible, screen, translated } from './quality.js'
import { chooseWorkspace, fresh, preferences } from './ui.js'

for (const locale of ['en', 'zh-CN'])
  for (const theme of ['light', 'dark'])
    test(`execution evidence uses real requests, receipts and artifact refs ${locale}/${theme}`, async ({
      page,
      runtime,
    }, info) => {
      test.setTimeout(150_000)
      await preferences(page, locale, theme)
      await page.goto(runtime.url)
      await chooseWorkspace(page, runtime, locale)
      await fresh(page, locale)
      async function send(input: string) {
        const turns = page.getByTestId('conversation-turn')
        const before = await turns.count()
        const composer = page.getByRole('textbox', {
          name: locale === 'en' ? 'Task content' : '任务内容',
          exact: true,
        })
        await composer.fill(input)
        await composer.press('Enter')
        await expect(turns).toHaveCount(before + 1, { timeout: 25_000 })
        await expect(turns.last()).toHaveAttribute('data-status', 'completed', { timeout: 25_000 })
      }
      await send('call read {"path":"report.md"}')
      await page.getByTestId('conversation-turn').last().getByTestId('turn-process-toggle').click()
      await page.getByTestId('tool-detail-toggle').click()
      await expect(page.getByTestId('tool-detail-text')).toContainText('Synthetic delivery')
      await screen(page, info, `tool-row-${locale}-${theme}`)
      await page.getByTestId('tool-detail-toggle').click()
      const entry = page.getByTestId('tool-fact-chain').last()
      await entry.click()
      const facts = page.getByTestId('fact-chain')
      await expect(facts.locator('[data-fact-kind="receipt"]')).toContainText(
        locale === 'en' ? 'Result received' : '收到结果',
      )
      await expect(facts).toContainText(locale === 'en' ? 'External completion: unknown' : '外部是否已完成')
      await expect(facts.locator('details')).not.toHaveAttribute('open')
      await expect(facts.locator('ol')).not.toContainText(/[a-f0-9]{64}/)
      await translated(page)
      await accessible(page, info, `fact-tool-${locale}-${theme}`)
      await screen(page, info, `fact-tool-${locale}-${theme}`)
      await page.getByTestId('workbench-tab-facts').press('Escape')
      await expect(entry).toBeFocused()
      await expect(facts).toBeHidden()

      await page.locator('#view-trace').click()
      await page.locator('#trace-timeline-mode').selectOption('sequence')
      await page.locator('.trace-type-filter').selectOption('assistant')
      await page.locator('.trace-row').last().click()
      await page.getByTestId('trace-fact-chain').click()
      await expect(facts.locator('[data-fact-kind="request"]')).toBeVisible()
      await expect(facts.locator('[data-fact-kind="attempt"]').first()).toBeVisible()
      await page.getByTestId('request-trace-pane').selectOption('tools')
      await expect(page.getByTestId('request-trace-content')).toBeVisible()
      await accessible(page, info, `fact-request-${locale}-${theme}`)
      await screen(page, info, `fact-request-${locale}-${theme}`, [
        page.locator('.trace-stats .trace-stat').first(),
        page.getByTestId('request-trace').locator('time'),
      ])
      await page.locator('#view-chat').click()
      await page.getByTestId('workbench-tab-facts').press('Escape')

      await send('call present {"files":[{"path":"report.md","name":"report.md"}]}')
      await page.getByTestId('deliverable-fact-chain').last().click()
      await expect(facts.locator('[data-fact-kind="artifact"]')).toContainText(
        locale === 'en' ? 'Provided by the linked call' : '由关联调用提供',
      )
      await expect(facts.locator('[data-fact-kind="invocation"]')).toBeVisible()
      await translated(page)
      await accessible(page, info, `fact-artifact-${locale}-${theme}`)
      // Opening the dock reflows the conversation; frame the final turn independently of scroll anchoring.
      await page.getByRole('region', { name: /^(Conversation|对话)$/, exact: true }).evaluate((viewport) => {
        viewport.style.scrollBehavior = 'auto'
        viewport.scrollTop = viewport.scrollHeight
      })
      await page.mouse.move(0, 0)
      await screen(page, info, `fact-artifact-${locale}-${theme}`)
      await facts.locator('[data-fact-kind="invocation"]').getByRole('button').click()
      await facts.getByRole('button', { name: locale === 'en' ? 'Back' : '返回', exact: true }).click()
      await expect(facts.locator('[data-fact-kind="artifact"]')).toBeVisible()
      await page.setViewportSize({ width: 390, height: 740 })
      await expect(page.getByTestId('workbench-tab-facts')).toBeInViewport()
      await page.getByTestId('workbench-tab-facts').press('Escape')
      await expect(page.getByTestId('deliverable-fact-chain').last()).toBeFocused()
    })

for (const locale of ['en', 'zh-CN'])
  test(`preset UI action records appear in execution evidence and trace (${locale})`, async ({
    page,
    runtime,
  }) => {
    await preferences(page, locale, 'light')
    await page.goto(runtime.url)
    await chooseWorkspace(page, runtime, locale)
    await fresh(page, locale)
    const surface = {
      id: 'evidence-review',
      revision: 1,
      title: 'Review report',
      placement: { inline: true, workbench: true },
      components: [
        { id: 'status', kind: 'text', dataKey: 'status' },
        { id: 'buttons', kind: 'button-group', actionIds: ['read-report'] },
      ],
      data: { status: 'Read synthetic evidence before continuing.' },
      actions: [
        {
          id: 'read-report',
          label: 'Read report',
          tool: 'read',
          argsTemplate: { path: { literal: 'report.md' } },
          paramsSchema: {
            type: 'object',
            required: ['path'],
            properties: { path: { type: 'string' } },
            additionalProperties: false,
          },
        },
      ],
    }
    const composer = page.getByRole('textbox', {
      name: locale === 'en' ? 'Task content' : '任务内容',
      exact: true,
    })
    for (const prompt of [
      'call tool_search {"query":"ui_render"}',
      'call tool_describe {"name":"ui_render"}',
    ]) {
      const turns = page.getByTestId('conversation-turn')
      const before = await turns.count()
      await composer.fill(prompt)
      await composer.press('Enter')
      await expect(turns).toHaveCount(before + 1, { timeout: 25_000 })
      await expect(turns.last()).toHaveAttribute('data-status', 'completed', { timeout: 25_000 })
      await turns.last().getByTestId('turn-process-toggle').click()
      await expect(turns.last()).toContainText('ui_render')
    }
    await composer.fill('call ui_render ' + JSON.stringify({ surface }))
    await composer.press('Enter')
    const card = page.getByTestId('intelligent-ui-inline')
    await expect(card.getByTestId('ui-surface-evidence-review')).toHaveAttribute('data-revision', '1')
    await card.getByTestId('ui-action-read-report').click()
    await expect(card.locator('[data-status="succeeded"]')).toBeVisible()
    await page.getByTestId('conversation-turn').last().getByTestId('turn-process-toggle').click()
    await page.getByTestId('tool-fact-chain').last().click()
    const facts = page.getByTestId('fact-chain')
    await expect(
      facts
        .getByTestId('ui-fact-chain-node')
        .filter({ hasText: locale === 'en' ? 'Action succeeded' : '动作成功' }),
    ).toBeVisible()
    await expect(
      facts
        .getByTestId('ui-fact-chain-node')
        .filter({ hasText: locale === 'en' ? 'Revision 1' : '修订 1' })
        .first(),
    ).toBeVisible()
    await page.locator('#view-trace').click()
    await expect(
      page
        .locator('.trace-row')
        .filter({ hasText: locale === 'en' ? 'Action succeeded' : '动作成功' })
        .first(),
    ).toBeVisible()
  })
