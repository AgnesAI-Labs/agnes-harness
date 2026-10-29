import type { ConsoleMessage, Response } from '@playwright/test'
import { expect, test } from './fixtures.js'
import { chooseWorkspace, expand, preferences, section, settings } from './ui.js'

// Draft values must not enter Playwright's network trace or failure screenshots.
test.use({ trace: 'off', screenshot: 'off' })
test('credentials create inline, select in MCP, rename, refused delete and delete after unreferencing', async ({
  page,
  runtime,
  expectedBrowserErrors,
}) => {
  test.setTimeout(120_000)
  const canary = `synthetic-canary-${crypto.randomUUID()}`
  const leakedResponses: boolean[] = []
  const responseChecks: Promise<void>[] = []
  const leakedConsole: boolean[] = []
  const checkConsole = (message: ConsoleMessage) => leakedConsole.push(message.text().includes(canary))
  const checkResponse = (response: Response) => {
    if (response.url().includes('/admin/api/credentials'))
      responseChecks.push(
        response.text().then((text) => {
          leakedResponses.push(text.includes(canary))
        }),
      )
  }
  page.on('console', checkConsole)
  page.on('response', checkResponse)
  const noDraft = async () => {
    expect(
      await page.evaluate(
        (value) =>
          document.body.innerHTML.includes(value) ||
          [...document.querySelectorAll<HTMLInputElement>('input,textarea')].some((input) =>
            input.value.includes(value),
          ),
        canary,
      ),
    ).toBe(false)
  }
  try {
    await preferences(page)
    await page.goto(runtime.url)
    await chooseWorkspace(page, runtime)
    await settings(page)
    await section(page, 'mcp')
    await page.getByTestId('mcp-create').click()
    await page.locator('#mcp-method-remote').click()
    await expand(page.locator('#mcp-advanced'))
    await page.locator('#mcp-name').fill('Credential flow service')
    await page.locator('#mcp-url').fill('http://127.0.0.1:9/mcp')
    await page.getByTestId('mcp-credential-create').click()
    await page.getByTestId('credential-label').fill('Integration key')
    await page.getByTestId('credential-value').fill(canary)
    await expect(page.getByTestId('credential-value')).toHaveAttribute('type', 'password')
    await page.getByTestId('credential-save').click()
    await expect(page.getByTestId('credential-editor')).toHaveCount(0)
    await expect(page.locator('#mcp-name')).toHaveValue('Credential flow service')
    const ref = await page.locator('#mcp-credential').inputValue()
    expect(ref.startsWith('secret://generic/')).toBe(true)
    await expect(page.locator('#mcp-secret')).toHaveValue(ref)
    await noDraft()
    await page.locator('#mcp-form button[type=submit]').click()
    await expect(page.locator('#admin-confirm[open]')).toBeVisible()
    const created = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/admin/resources/api/mcp/create',
    )
    await page.locator('#admin-confirm-action').click()
    const creation = await created
    expect(creation.status()).toBe(200)
    const createReceipt = (await creation.json()) as { operationId: string }
    await expect(page.locator('#mcp-dialog')).not.toBeVisible()
    const client = await runtime.connect()
    await expect
      .poll(async () =>
        (await client.mcp.servers.list({ profile: 'local-dev' })).items.some(
          (item) =>
            item.definition?.secretBinding.kind === 'http-bearer' &&
            item.definition.secretBinding.credentialRef === ref,
        ),
      )
      .toBe(true)
    await expect
      .poll(
        async () =>
          (
            await client.resources.operation.get({
              profile: 'local-dev',
              operationId: createReceipt.operationId,
            })
          ).state,
      )
      .toBe('succeeded')
    await section(page, 'credentials')
    const row = page.getByTestId('credential-row').filter({ hasText: 'Integration key' })
    await expect(row).toBeVisible()
    await expect(row.getByTestId('credential-references')).toContainText('credential-flow-service')
    await row.getByRole('button', { name: 'Actions for Integration key' }).click()
    await page.getByTestId('credential-rename').click()
    await page.getByTestId('credential-label').fill('Renamed integration key')
    await page.getByTestId('credential-save').click()
    const renamed = page.getByTestId('credential-row').filter({ hasText: 'Renamed integration key' })
    await expect(renamed).toBeVisible()
    await renamed.getByRole('button', { name: 'Actions for Renamed integration key' }).click()
    await page.getByTestId('credential-delete').click()
    const referencedDelete = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/admin/api/credentials/delete',
    )
    await page.getByTestId('credential-delete-confirm').click()
    expect((await referencedDelete).status()).toBe(409)
    expectedBrowserErrors.push(
      'console: Failed to load resource: the server responded with a status of 409 (Conflict)',
    )
    await expect(page.getByTestId('credential-delete-error')).toContainText('not deleted')
    await expect(page.getByTestId('credential-force-confirm')).not.toBeChecked()
    await page.getByTestId('credential-delete-cancel').click()
    await section(page, 'mcp')
    await page.getByRole('button', { name: 'Credential flow service', exact: true }).click()
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(page.locator('#mcp-name')).toHaveValue('Credential flow service')
    await page.locator('#mcp-credential-trigger').click()
    await page.getByRole('option', { name: 'No credentials', exact: true }).click()
    await page.locator('#mcp-form button[type=submit]').click()
    const updated = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/admin/resources/api/mcp/update',
    )
    await page.locator('#admin-confirm-action').click()
    const update = await updated
    expect(update.status()).toBe(200)
    const updateReceipt = (await update.json()) as { operationId: string }
    await expect(page.locator('#mcp-dialog')).not.toBeVisible()
    // A saved form returns to the MCP list. Reopen the updated service through its page.
    await page.getByRole('button', { name: 'Credential flow service', exact: true }).click()
    await expect(page.locator('#resource-detail')).toContainText('Credential flow service')
    await page.getByTestId('push-back').click()
    await expect(page.locator('#resource-detail')).toBeHidden()
    await expect
      .poll(
        async () =>
          (await client.mcp.servers.list({ profile: 'local-dev' })).items.find(
            (item) => item.serverId === 'credential-flow-service',
          )?.definition?.secretBinding.kind,
      )
      .toBe('none')
    // The accepted definition is visible before its operation settles. Until then the
    // retained previous definition must continue to protect its credential from deletion.
    await expect
      .poll(
        async () =>
          (
            await client.resources.operation.get({
              profile: 'local-dev',
              operationId: updateReceipt.operationId,
            })
          ).state,
      )
      .toBe('succeeded')
    await section(page, 'credentials')
    await page.getByTestId('credentials-refresh').click()
    await expect(renamed.getByTestId('credential-references')).toContainText('Not used')
    await renamed.getByRole('button', { name: 'Actions for Renamed integration key' }).click()
    await page.getByTestId('credential-delete').click()
    await page.getByTestId('credential-delete-confirm').click()
    await expect(renamed).toHaveCount(0)
    await noDraft()
  } finally {
    // Stop collecting before the drain: a background refresh must not enqueue a body read
    // after the final assertions or race the fixture closing the page.
    page.off('response', checkResponse)
    try {
      await Promise.all(responseChecks)
    } finally {
      page.off('console', checkConsole)
    }
  }
  expect(leakedResponses.length > 0).toBe(true)
  expect(leakedResponses.some(Boolean)).toBe(false)
  expect(leakedConsole.some(Boolean)).toBe(false)
})
