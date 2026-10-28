import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.js'
import { fresh, openWorkspace } from './ui.js'

async function start(page: Page, input: string): Promise<string> {
  const composer = page.getByRole('textbox', { name: 'Task content', exact: true })
  await composer.fill(input)
  await composer.press('Enter')
  await expect(page.locator('#composer')).toHaveAttribute('data-busy', 'true')
  const id = new URL(page.url()).searchParams.get('session')
  if (!id) throw new Error('The started session must be in the URL')
  return id
}

const row = (page: Page, id: string) => page.locator(`.session-row:has([data-session="${id}"])`)

test('A session left running keeps its spinner, is marked done when it finishes, and the mark clears once opened', async ({
  page,
  runtime,
}) => {
  test.setTimeout(120_000)
  await openWorkspace(page, runtime)
  // The demo model runs this shell call, so the turn stays in flight while another session is open.
  const first = await start(page, 'call shell {"command":"sleep 8"}')
  await fresh(page)
  await expect(row(page, first).locator('.session-running')).toBeVisible()
  // A finished turn nobody has seen is a dot before the title.
  await expect(row(page, first).locator('.session-unread')).toHaveAttribute('aria-label', 'Done', {
    timeout: 30_000,
  })
  await expect(row(page, first).locator('.session-running')).toHaveCount(0)
  await row(page, first).locator(`[data-session="${first}"]`).click()
  await expect(page).toHaveURL(new RegExp(`session=${first}`))
  // Leave again: an opened session must not get its old mark back.
  await fresh(page)
  await expect(row(page, first)).toBeVisible()
  await expect(row(page, first).locator('.session-unread')).toHaveCount(0)
})

test('A session left waiting for an approval says so in the list', async ({ page, runtime }) => {
  test.setTimeout(120_000)
  await openWorkspace(page, runtime)
  const permission = page.locator('#composer-permission')
  await permission.click()
  await page.getByRole('option', { name: /^Edit workspace\b/ }).click()
  await expect(permission).toContainText('Edit workspace')
  const first = await start(page, 'call shell {"command":"echo E2E_NEEDS_APPROVAL"}')
  await fresh(page)
  await expect(row(page, first).getByTestId('session-mark')).toHaveText('Needs approval', {
    timeout: 30_000,
  })
})

test('A turn started by another client shows in this page list as running, then done', async ({
  page,
  runtime,
}) => {
  test.setTimeout(120_000)
  await openWorkspace(page, runtime)
  const other = await runtime.connect()
  const session = await other.session.new({
    cwd: runtime.workspace,
    sessionKey: crypto.randomUUID(),
    permission: 'full-access',
  })
  const turn = session.prompt([{ type: 'text', text: 'call shell {"command":"sleep 6"}' }])
  await page.reload()
  await expect(row(page, session.id).locator('.session-running')).toBeVisible({ timeout: 20_000 })
  await turn
  await expect(row(page, session.id).locator('.session-unread')).toHaveAttribute('aria-label', 'Done', {
    timeout: 20_000,
  })
})
