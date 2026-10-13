import { expect, test } from './fixtures.js'
import { toolResult } from './sdk.js'
import { preferences, turn } from './ui.js'

test('fresh Demo home starts an FDE bundle from the business agents page', async ({ page, runtime }) => {
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
  const card = page.getByTestId('business-agent-code-review')
  await expect(card.getByTestId('business-agent-sample')).toContainText('Review the sample patch')
  await page.getByTestId('business-agent-start-code-review').click()
  await expect(page.getByTestId('agent-start-dialog').getByRole('dialog')).toBeVisible()
  expect((await client.packages.list({ profile: 'local-dev' })).packages.map((row) => row.id)).not.toContain(
    '@agnes-fde/code-review',
  )
  await page.getByTestId('agent-start-confirm').click()
  const composer = page.getByRole('textbox', { name: 'Task content', exact: true })
  await expect(composer).toBeVisible({ timeout: 30_000 })
  await expect(composer).toHaveValue(/Review the sample patch/)
  expect(new URL(page.url()).searchParams.getAll('bundle')).toEqual(['@agnes-fde/code-review#code-review'])
  await expect(page.getByTestId('conversation-turn')).toHaveCount(0)
  const workspace = page.locator('#new-session').getByRole('dialog')
  await expect(workspace).toBeVisible()
  const manual = workspace.getByTestId('workspace-manual-toggle')
  if ((await manual.getAttribute('aria-expanded')) !== 'true') await manual.click()
  await workspace.locator('#new-session-cwd').fill(runtime.workspace)
  await workspace.locator('#new-session-create').click()
  await expect(workspace).toBeHidden()
  await expect(composer).toHaveValue(/Review the sample patch/)
  await turn(page, await composer.inputValue())
  const id = new URL(page.url()).searchParams.get('session')
  if (!id) throw new Error('The FDE first turn must create a durable session')
  const session = await client.session.load(id, { cwd: runtime.workspace })
  await session.attach()
  const descriptor = await client.session.runtime(id)
  expect(descriptor.loop?.id).toBe('fde.code-review')
  expect(descriptor.preset?.bundles).toEqual(['@agnes-fde/code-review#code-review'])
  expect(descriptor.policy?.toolPolicy).toBe('fde.code-review')
  expect((await session.capabilities())?.modelRoutes.value?.primary).toEqual({
    route: 'demo',
    model: 'demo-model',
  })
  expect((await toolResult(session, 'fde_review_report'))?.structured).toMatchObject({
    status: 'needs-review',
    findings: [
      { rule: 'debug-log', file: 'src/handler.js', line: 2 },
      { rule: 'dynamic-eval', file: 'src/handler.js', line: 3 },
    ],
  })
  expect((await client.config.get()).accounts).toHaveLength(0)
})
