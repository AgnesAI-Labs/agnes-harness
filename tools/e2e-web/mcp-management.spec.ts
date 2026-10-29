import { resolve } from 'node:path'
import { expect, test } from './fixtures.js'
import { chooseWorkspace, fresh, preferences, section, settings } from './ui.js'

test('Removing an enabled MCP server says to disable it first and keeps the server', async ({
  page,
  runtime,
  expectedBrowserErrors,
}) => {
  test.setTimeout(120_000)
  // The host refuses the removal with a 409 the browser logs as a failed resource load.
  expectedBrowserErrors.push(
    'console: Failed to load resource: the server responded with a status of 409 (Conflict)',
  )
  await runtime.cli([
    'mcp',
    'add',
    'e2e',
    '--name',
    'E2E stdio',
    '--stdio',
    'node',
    '--arg',
    resolve('tools/e2e-web/fixtures/mcp.mjs'),
    '--sandbox-profile',
    'off-with-warning',
    '--yes',
  ])
  const revision = async () => {
    const value = /revision=([a-f0-9]{64})/.exec(await runtime.cli(['mcp', 'get', 'e2e']))?.[1]
    if (!value) throw new Error('MCP must supply a reviewed revision')
    return value
  }
  await runtime.cli(['mcp', 'trust', 'e2e', '--expected-revision', await revision(), '--yes'])
  await runtime.cli(['mcp', 'enable', 'e2e', '--expected-revision', await revision(), '--yes'])
  await preferences(page, 'en')
  await page.goto(runtime.url)
  await chooseWorkspace(page, runtime, 'en')
  await fresh(page, 'en')
  await settings(page, 'en')
  await section(page, 'mcp')
  await page
    .getByRole('button', { name: /E2E stdio/ })
    .first()
    .click()
  await page.getByRole('button', { name: 'Remove', exact: true }).click()
  await page
    .getByRole('dialog', { name: 'Confirm action', exact: true })
    .getByRole('button', { name: 'Confirm', exact: true })
    .click()
  // The detail page covers the list's notice line, so the refusal must show on the detail page itself.
  await expect(
    page.getByRole('alert').filter({ hasText: /Disable it and wait for the operation to finish/ }),
  ).toBeVisible()
  await expect(page.getByText('The resource action failed.')).toHaveCount(0)
  // The refused removal changed nothing.
  expect(await runtime.cli(['mcp', 'get', 'e2e'])).toContain('revision=')
})

test('Plugins page add-MCP form scrolls with the wheel after the advanced fold opens', async ({
  page,
  runtime,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await preferences(page, 'en')
  const skip = page.getByTestId('first-run-skip')
  await page.addLocatorHandler(skip, () => skip.click(), { times: 1 })
  await page.goto(new URL('/?page=plugins&tab=mcp', runtime.url).href)
  await expect(page.getByTestId('plugins-tab-mcp')).toBeVisible()
  await expect(page.getByTestId('mcp-create')).toBeEnabled({ timeout: 30_000 })
  await page.getByTestId('mcp-create').click()
  await page.locator('#mcp-method-local').click()
  await page.locator('#mcp-advanced button.agh-disclosure-summary').click()
  const last = page.locator('#mcp-tools')
  const inView = () =>
    last.evaluate((node) => node.getBoundingClientRect().bottom <= document.documentElement.clientHeight)
  // The open fold outgrows the viewport, so the last field starts below the fold.
  expect(await inView()).toBe(false)
  // The wheel over the form must reach the page's scroller instead of being held by the form.
  await page.locator('#mcp-connection-fields').hover()
  await page.mouse.wheel(0, 3000)
  await expect.poll(inView).toBe(true)
})
