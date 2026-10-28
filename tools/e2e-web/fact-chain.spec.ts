import { readFile } from 'node:fs/promises'
import { startProviderFixture } from '../acceptance/provider-fixture.js'
import { expect, test } from './fixtures.js'
import { accessible, screen, translated } from './quality.js'
import { chooseWorkspace, expand, expandActivityGroups, fresh, preferences, traceSequence } from './ui.js'

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
      await expect(
        page.getByTestId('conversation-turn').last().getByTestId('feedback-down').last(),
      ).toBeEnabled()
      await page.getByTestId('conversation-turn').last().getByTestId('turn-process-toggle').click()
      await page.getByTestId('tool-detail-toggle').click()
      await expect(page.getByTestId('tool-detail-text')).toContainText('Synthetic delivery')
      // ui-gate's main-screens case owns tool-row pixels; its sidebar inventory differs from this flow.
      await expect(page.getByTestId('tool-detail-toggle')).toHaveAttribute('aria-expanded', 'true')
      const entry = page.getByTestId('tool-fact-chain').last()
      await entry.click()
      const facts = page.locator('.trace-inspector')
      await expect(facts).toHaveAttribute('data-kind', 'tool')
      await expect(facts.locator('[data-link="receipt"]')).toContainText(
        locale === 'en' ? 'Completed' : '已完成',
      )
      await expect(facts.getByTestId('trace-inspector-pane')).toHaveAttribute('data-pane', 'source')
      await expect(facts.getByTestId('trace-provenance')).not.toContainText(/[a-f0-9]{64}/)
      await translated(page)
      await accessible(page, info, `fact-tool-${locale}-${theme}`)
      await traceSequence(page)
      await screen(page, info, `fact-tool-${locale}-${theme}`)
      await page.locator('#view-chat').click()
      await expect(entry).toBeVisible()
      await expect(facts).toBeHidden()

      await page.locator('#view-trace').click()
      await traceSequence(page)
      await page.locator('.trace-chip[data-kind="assistant"]').click()
      await page.locator('.trace-row').last().click()
      await page.locator('.trace-tab[data-pane="source"]').click()
      await expect(facts.locator('[data-link="model"]')).toContainText('demo-model')
      await expect(facts.locator('[data-link="attempt"]')).toBeVisible()
      await page.locator('.trace-tab[data-pane="request"]').click()
      await expand(page.getByTestId('request-trace-section-tools'))
      await expect(page.getByTestId('request-trace-content')).toContainText('read')
      await accessible(page, info, `fact-request-${locale}-${theme}`)
      await page.locator('.trace-inspector-body').evaluate((body) => {
        body.scrollTop = 0
      })
      await screen(page, info, `fact-request-${locale}-${theme}`, [
        page.locator('.trace-stats .trace-stat'),
        page.locator('.trace-inspector-meta'),
      ])
      await page.locator('#view-chat').click()

      await send('call present {"files":[{"path":"report.md","name":"report.md"}]}')
      const artifactTurn = page.getByTestId('conversation-turn').last()
      await expand(artifactTurn.getByTestId('turn-process-toggle').locator('..'))
      await expandActivityGroups(artifactTurn)
      // The card reads "Present deliverables" in each locale; its recorded tool name is the stable hook.
      const tool = artifactTurn
        .locator('article.timeline-node.tool')
        .filter({ has: page.locator('[data-tool-name="present"]') })
      await tool.getByTestId('tool-detail-toggle').click()
      await tool.getByTestId('tool-fact-chain').click()
      await expect(facts).toHaveAttribute('data-kind', 'tool')
      await expect(facts.getByTestId('trace-artifact')).toBeHidden()
      await facts
        .getByRole('button', {
          name: locale === 'en' ? 'Full provenance and technical details' : '完整来源与技术详情',
          exact: true,
        })
        .click()
      await expect(facts.getByTestId('trace-artifact')).toContainText('text/')
      await expect(facts.locator('[data-link="receipt"]')).toBeVisible()
      const download = page.waitForEvent('download')
      await facts.getByTestId('artifact-download').click()
      const file = await download
      const path = await file.path()
      if (!path) throw new Error('The linked artifact must be downloadable')
      expect(await readFile(path, 'utf8')).toContain('Synthetic delivery')
      await translated(page)
      await accessible(page, info, `fact-artifact-${locale}-${theme}`)
      await screen(page, info, `fact-artifact-${locale}-${theme}`, [page.locator('.trace-inspector-meta')])
      await page.setViewportSize({ width: 390, height: 740 })
      await expect(facts).toBeInViewport()
      const selectedId = await page
        .locator('.trace-row[aria-current="true"]')
        .getAttribute('data-trace-row-id')
      await facts.locator('.trace-inspector-close').press('Escape')
      await expect(facts).toBeHidden()
      await expect(page.locator(`.trace-row[data-trace-row-id="${selectedId}"]`)).toBeFocused()
    })

for (const locale of ['en', 'zh-CN'])
  test(`preset UI action records appear in execution evidence and trace (${locale})`, async ({
    page,
    runtime,
  }) => {
    test.setTimeout(120_000)
    const client = await runtime.connect()
    const model = (await client.config.test({ providerId: 'deepseek' })).models[0]?.id
    if (!model) throw new Error('Missing reviewed fixture model')
    // The teaching demo deliberately refuses complex schemas; send scripted calls through
    // the real provider adapter, Core validation and normal tool authorization instead.
    const fixture = await startProviderFixture('Synthetic UI evidence.', undefined, model)
    try {
      const config = await client.config.get()
      await client.config.save({
        providerId: 'deepseek',
        baseUrl: fixture.baseUrl,
        apiKey: fixture.apiKey,
        model,
        accountId: 'evidence-fixture',
        label: 'Local scripted evidence model',
        expectedRevision: config.revision,
        makeDefault: true,
      })
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
      for (const tool of [
        { name: 'tool_search', args: { query: 'ui_render' } },
        { name: 'tool_describe', args: { name: 'ui_render' } },
      ]) {
        fixture.queueTool(tool)
        const prompt = 'call ' + tool.name + ' ' + JSON.stringify(tool.args)
        const turns = page.getByTestId('conversation-turn')
        const before = await turns.count()
        await composer.fill(prompt)
        await composer.press('Enter')
        await expect(turns).toHaveCount(before + 1, { timeout: 25_000 })
        await expect(turns.last()).toHaveAttribute('data-status', 'completed', { timeout: 25_000 })
        await turns.last().getByTestId('turn-process-toggle').click()
        await expect(turns.last()).toContainText('ui_render')
      }
      fixture.queueTool({ name: 'ui_render', args: { surface } })
      const publishedTurns = page.getByTestId('conversation-turn')
      const beforePublish = await publishedTurns.count()
      await composer.fill('call ui_render ' + JSON.stringify({ surface }))
      await composer.press('Enter')
      await expect(publishedTurns).toHaveCount(beforePublish + 1)
      const publishedTurn = publishedTurns.last()
      await expect(publishedTurn).toHaveAttribute('data-status', 'completed')
      await expand(publishedTurn.getByTestId('turn-process-toggle').locator('..'))
      await expandActivityGroups(publishedTurn)
      await publishedTurn.getByTestId('tool-detail-toggle').click()
      const inline = page
        .getByTestId('ui-surface-evidence-review')
        .and(page.locator('[data-placement="inline"]'))
      await expect(inline).toHaveAttribute('data-revision', '1')
      await expect(inline.getByTestId('ui-action-read-report')).toBeEnabled()
      await expect(inline.getByTestId('ui-confirm')).toHaveCount(0)
      const sourceSession = await client.session.load(new URL(page.url()).searchParams.get('session')!, {
        cwd: runtime.workspace,
      })
      expect(
        (await sourceSession.projectUI()).nodes.some((node) => node.kind === 'tool' && node.name === 'read'),
      ).toBe(false)
      await expect(page.getByTestId('conversation-turn').last()).toHaveAttribute('data-status', 'completed', {
        timeout: 25_000,
      })
      await expect(composer).toBeEnabled()
      if (!(await inline.getByTestId('ui-expand').count())) {
        await inline.locator('header .agh-menu-anchor button').click()
        await page.getByTestId('ui-expand').click()
      } else await inline.getByTestId('ui-expand').click()
      const card = page.getByTestId('intelligent-ui-panel')
      await card.getByTestId('ui-action-read-report').click()
      await card.getByTestId('ui-confirm').click()
      await expect(card.locator('[data-status="succeeded"]')).toBeVisible()
      const view = await sourceSession.projectUI(undefined, { surface: 'web' })
      const action = view.nodes.findLast((node) => node.kind === 'tool' && node.name === 'read')
      const owner = view.turns.find((turn) => action && turn.nodeIds.includes(action.id))
      if (!action || !owner) throw new Error('The successful UI action must have a durable read result')
      const actionTurn = page.locator(`[data-turn-id=${JSON.stringify(owner.id)}]`)
      await expect(actionTurn).toHaveAttribute('data-status', 'completed', { timeout: 25_000 })
      await expand(actionTurn.getByTestId('turn-process-toggle').locator('..'))
      await expandActivityGroups(actionTurn)
      const actionTool = actionTurn.locator(`[data-node-id=${JSON.stringify(action.id)}]`)
      await actionTool.getByTestId('tool-detail-toggle').click()
      await actionTool.getByTestId('tool-fact-chain').click()
      const facts = page.locator('.trace-inspector')
      await expect(facts.locator('[data-link="ui"]')).toContainText(
        locale === 'en' ? 'Action succeeded' : '动作成功',
      )
      await expect(facts.locator('[data-link="ui"]')).toContainText(locale === 'en' ? 'revision 1' : '修订 1')
      await expect(page.locator('#view-trace')).toHaveAttribute('aria-selected', 'true')
      await expect(
        page
          .locator('.trace-row')
          .filter({ hasText: locale === 'en' ? 'Action succeeded' : '动作成功' })
          .first(),
      ).toBeVisible()
    } finally {
      await fixture.close()
    }
  })
