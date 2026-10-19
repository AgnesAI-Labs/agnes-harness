import { installDeveloperExample } from './developer-example.js'
import { expect, test } from './fixtures.js'
import { toolResult } from './sdk.js'
import { preferences, turn } from './ui.js'

test('fresh gallery hides teaching examples until deliberately installed, then reviews their agent launch', async ({
  page,
  runtime,
}, info) => {
  test.setTimeout(90_000)
  const client = await runtime.connect()
  expect((await client.config.get()).configured).toBe(false)
  expect((await client.session.list()).items).toHaveLength(0)
  await preferences(page)
  await page.goto(runtime.url)
  const guide = page.getByTestId('first-run-guide')
  await page.getByTestId('first-run-demo').click()
  await page.getByTestId('first-run-next').click()
  await guide
    .getByRole('button', { name: 'Enter a folder if the picker is unavailable', exact: true })
    .click()
  await guide.getByRole('textbox', { name: 'Folder path', exact: true }).fill(runtime.workspace)
  await guide.getByRole('button', { name: 'Use folder', exact: true }).click()
  await page.getByTestId('first-run-next').click()
  await page.getByTestId('first-run-next').click()
  await expect(guide).toBeHidden()
  for (const name of ['plugins', 'automation', 'agents']) {
    await page.getByTestId(`home-entry-${name}`).click()
    await expect(page.getByTestId(`home-page-${name}`)).toBeVisible()
    expect(new URL(page.url()).searchParams.get('page')).toBe(name)
  }
  const card = page.locator('[data-agent-ref="@agnes-fde/knowledge-qa#knowledge-qa"]')
  await expect(card).toHaveCount(0)
  await expect(page.getByTestId('general-agent')).toBeVisible()
  await expect(
    page.getByTestId('general-agent').getByRole('button', { name: 'Start now', exact: true }),
  ).toBeEnabled()
  await page.screenshot({ path: info.outputPath('gallery-fresh.png'), animations: 'disabled' })
  expect((await client.packages.list({ profile: 'local-dev' })).packages.map((row) => row.id)).not.toContain(
    '@agnes-fde/knowledge-qa',
  )
  await installDeveloperExample(page, 'examples/fde/knowledge-qa')
  await page.getByTestId('home-entry-agents').click()
  await expect(card).toContainText('Knowledge answer example')
  await page.screenshot({ path: info.outputPath('gallery-installed-teaching.png'), animations: 'disabled' })
  await card.getByRole('button', { name: 'Start now', exact: true }).click()
  const confirm = page.getByTestId('agent-start-confirm')
  await expect(confirm.or(page.getByTestId('agent-launch-review'))).toBeVisible()
  if (await confirm.isVisible()) await confirm.click()
  await expect(page.getByTestId('agent-launch-review')).toContainText('refund')
  await page.getByTestId('agent-launch-confirm').click()
  const composer = page.getByRole('textbox', { name: 'Task content', exact: true })
  await expect(composer).toBeVisible({ timeout: 30_000 })
  await expect(composer).toHaveValue(/refund/)
  expect(new URL(page.url()).searchParams.get('session')).toBeTruthy()
  await expect(page.getByTestId('conversation-turn')).toHaveCount(0)
  const clientBeforeSend = await runtime.connect()
  const startedId = new URL(page.url()).searchParams.get('session')!
  const beforeSend = await clientBeforeSend.session.load(startedId, { cwd: runtime.workspace })
  expect((await beforeSend.projectUI()).turns).toHaveLength(0)
  await turn(page, await composer.inputValue())
  const id = new URL(page.url()).searchParams.get('session')
  if (!id) throw new Error('The FDE first turn must create a durable session')
  const session = await client.session.load(id, { cwd: runtime.workspace })
  await session.attach()
  const descriptor = await client.session.runtime(id)
  expect(descriptor.loop?.id).toBe('fde.knowledge-qa')
  expect(descriptor.preset?.bundles).toEqual(['@agnes-fde/knowledge-qa#knowledge-qa'])
  expect(descriptor.policy?.toolPolicy).toBe('fde.knowledge-qa')
  expect((await session.capabilities())?.modelRoutes.value?.primary).toEqual({
    route: 'demo',
    model: 'demo-model',
  })
  expect((await toolResult(session, 'fde_knowledge_retrieve'))?.structured).toMatchObject({
    sources: expect.arrayContaining([
      expect.objectContaining({
        citation: expect.stringContaining('fixtures/docs/'),
        quote: expect.stringContaining('refund'),
      }),
    ]),
  })
  expect((await toolResult(session, 'present'))?.isError).not.toBe(true)
  expect((await client.config.get()).accounts).toHaveLength(0)
})
