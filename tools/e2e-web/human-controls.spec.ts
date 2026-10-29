import { expect, test } from './fixtures.js'
import { install } from './sdk.js'
import { chooseWorkspace, fresh, preferences, send, turn } from './ui.js'

// Entire scenario uses the offline demo adapter and an AbortSignal-driven synthetic tool.
test('human controls queue, interrupt, persist pause and stop/continue a child', async ({
  page,
  runtime,
}, info) => {
  test.setTimeout(120_000)
  await preferences(page)
  await page.goto(runtime.url)
  await chooseWorkspace(page, runtime)
  await install(await runtime.connect(), 'tools/e2e-web/fixtures/cancel-tool')
  await fresh(page)
  const original = await send(page, 'call e2e_wait_for_cancel {}')
  await expect(original.getByTestId('tool-detail-toggle')).toBeVisible()
  const composer = page.getByRole('textbox', { name: 'Task content', exact: true })
  await composer.fill('queued direction')
  await composer.press('Shift+Enter')
  await expect(composer).toHaveValue('queued direction\n')
  await composer.press('Backspace')
  await composer.press('Enter')
  const queued = page.getByTestId('queued-steer').first()
  await expect(queued).toContainText('queued direction')
  await queued.getByTestId('queued-steer-edit').click()
  await queued.getByTestId('queued-steer-editor').fill('withdraw this edited direction')
  await queued.getByTestId('queued-steer-edit').click()
  await expect(queued).toContainText('withdraw this edited direction')
  await queued.getByTestId('queued-steer-withdraw').click()
  await expect(page.getByTestId('queued-steer')).toHaveCount(0)

  await composer.fill('call e2e_wait_for_cancel {}')
  await composer.press('Enter')
  const beforeInterrupt = await page.getByTestId('conversation-turn').count()
  // Interrupting with a queued message is in the line's "more" menu.
  await page.getByTestId('queued-steer-more').first().click()
  await page.getByTestId('queued-steer-interrupt').click()
  await expect(original).toHaveAttribute('data-status', 'cancelled')
  await expect(page.getByTestId('conversation-turn')).toHaveCount(beforeInterrupt + 1)
  const interruptedTurn = page.getByTestId('conversation-turn').last()
  await expect(interruptedTurn.getByTestId('tool-detail-toggle')).toBeVisible()
  const client = await runtime.connect()
  const id = new URL(page.url()).searchParams.get('session')!
  const session = await client.session.load(id, { cwd: runtime.workspace })
  await session.attach()
  await page.getByTestId('composer-pause-resume').click()
  await expect.poll(async () => (await session.controls()).paused).toBe(true)
  await page.reload()
  await expect(page.getByTestId('composer-paused')).toBeVisible()
  await page.getByTestId('composer-pause-resume').click()
  await expect.poll(async () => (await session.controls()).paused).toBe(false)
  // Stop returns queued guidance to the draft (a queued follow-up stays queued), so this is sent as guidance.
  await composer.fill('return this to my draft')
  await composer.press('ControlOrMeta+Enter')
  await expect(page.getByTestId('queued-steer')).toContainText('return this to my draft')
  await page.getByTestId('composer-cancel').click()
  await expect(composer).toHaveValue('return this to my draft')
  await page.reload()
  await expect(composer).toHaveValue('return this to my draft')
  await expect(page.getByTestId('conversation-turn')).toHaveCount(beforeInterrupt + 1)
  await expect(original).toHaveAttribute('data-status', 'cancelled')
  await turn(page, 'Recovered after human cancellation')

  await turn(page, 'call tool_describe {"name":"subagent_spawn"}')
  await turn(page, 'call subagent_spawn {"task":"call e2e_wait_for_cancel {}","isolation":"shared"}')
  const tree = page.getByTestId('child-control-tree')
  await tree.locator('summary, .agh-disclosure-summary').click()
  const child = tree.getByTestId('child-control-row').first()
  await expect(child.getByTestId('child-stop')).toBeEnabled()
  await expect(child.getByTestId('child-control-metrics')).toBeVisible()
  const sessionUrl = page.url()
  await child.getByTestId('child-open').click()
  const report = page.getByRole('region', { name: 'Subagent messages', exact: true })
  await expect(report).toBeVisible()
  await expect(page.getByTestId('terminal-tab').filter({ hasText: 'Subagent' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  expect(page.url()).toBe(sessionUrl)
  await page.screenshot({ path: info.outputPath('subagent-tray-and-report.png'), animations: 'disabled' })
  await page.getByTestId('workbench-right-toggle').click()
  await child.getByTestId('child-stop').click()
  await expect(child.getByTestId('child-continue-message')).toBeEnabled()
  await child.getByTestId('child-continue-message').fill('Finish with a synthetic answer')
  await child.getByTestId('child-continue').click()
  await expect.poll(async () => (await session.controls()).children?.[0]?.status).toBe('idle')
  await child.getByTestId('child-open').click()
  const job = (await session.jobsRead(`child:${await child.getAttribute('data-child-id')}`)).job
  expect(job?.kind).toBe('child')
  expect(job?.stdout).toContain('Calling e2e_wait_for_cancel with example arguments.')
  await expect(report.locator('.workbench-child-report-body')).toHaveText(job?.stdout?.trim() ?? '')
  await expect(report.locator('.xterm')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('subagent-idle-report.png'), animations: 'disabled' })
  await page.getByTestId('workbench-right-toggle').click()
  const facts = (await session.controls({ afterSeq: 0 })).facts ?? []
  for (const action of ['interrupt', 'resume', 'child-stop', 'child-continue'])
    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action,
          outcome: 'applied',
          actor: expect.any(Object),
          ts: expect.any(String),
        }),
      ]),
    )
  await page.locator('#view-trace').click()
  // Control facts now participate in the unified trace rows, with localized action names.
  const evidence = page.locator('.trace-row').filter({ has: page.locator('.kind-control') })
  await expect(evidence.filter({ hasText: 'Stop child' }).last()).toBeVisible()
})
