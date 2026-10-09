import { expect, test } from './fixtures.js'
import { install } from './sdk.js'
import { chooseWorkspace, fresh, preferences, send, turn } from './ui.js'

// Entire scenario uses the offline demo adapter and an AbortSignal-driven synthetic tool.
test('human controls queue, interrupt, persist pause and stop/continue a child', async ({
  page,
  runtime,
}) => {
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
  await composer.fill('return this to my draft')
  await composer.press('Enter')
  await expect(page.getByTestId('queued-steer')).toContainText('return this to my draft')
  await page.getByTestId('composer-cancel').click()
  await expect(composer).toHaveValue('return this to my draft')
  await page.reload()
  await expect(composer).toHaveValue('return this to my draft')
  await turn(page, 'Recovered after human cancellation')

  await turn(page, 'call subagent_spawn {"task":"call e2e_wait_for_cancel {}","isolation":"shared"}')
  const tree = page.getByTestId('child-control-tree')
  await tree.locator('summary').click()
  const child = tree.getByTestId('child-control-row').first()
  await expect(child.getByTestId('child-stop')).toBeEnabled()
  await expect(child.getByTestId('child-control-metrics')).toBeVisible()
  await child.getByTestId('child-stop').click()
  await expect(child.getByTestId('child-continue-message')).toBeEnabled()
  await child.getByTestId('child-continue-message').fill('Finish with a synthetic answer')
  await child.getByTestId('child-continue').click()
  await expect.poll(async () => (await session.controls()).children?.[0]?.status).toBe('idle')
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
  const evidence = page.getByTestId('control-facts')
  await evidence.locator('summary').click()
  await expect(evidence.getByTestId('control-fact').filter({ hasText: 'child-stop' }).last()).toBeVisible()
})
