import type { ConsoleMessage, Request } from '@playwright/test'
import { expect, root as test } from './fixtures.js'
import { expand, preferences } from './ui.js'

// Draft values must not enter Playwright's network trace or failure screenshots.
test.use({ trace: 'off', screenshot: 'off' })
// Include the runtime fixture in the timeout for a cold daemon start.
test.describe.configure({ timeout: 150_000 })
test('credentials create inline, replace in place, rename and protect referenced credentials', async ({
  page,
  runtime,
  expectedBrowserErrors,
}) => {
  const workbench = page
  const canary = `synthetic-canary-${crypto.randomUUID()}`
  const leakedResponses: boolean[] = []
  const responseChecks: Promise<void>[] = []
  const unreadResponses: string[] = []
  const leakedConsole: boolean[] = []
  const setPath = '/admin/api/credentials/set'
  const writes: string[] = []
  const trackCredentialRequest = (request: Request) => {
    const path = new URL(request.url()).pathname
    if (path !== '/admin/api/credentials' && !path.startsWith('/admin/api/credentials/')) return
    if (request.method() === 'POST') writes.push(path)
    responseChecks.push(
      request
        .response()
        .then(async (response) => {
          if (response) leakedResponses.push((await response.text()).includes(canary))
        })
        .catch(() => {
          unreadResponses.push(path)
        }),
    )
  }
  const drainCredentialResponses = async () => {
    while (responseChecks.length) await Promise.all(responseChecks.splice(0))
  }
  const navigate = async (path: string) => {
    // Chromium drops response bodies when their document is replaced.
    await drainCredentialResponses()
    await page.goto(new URL(path, runtime.url).href)
  }
  const openMcp = () => navigate('/?page=plugins&tab=mcp')
  const openCredentials = () => navigate('/?settings=credentials')
  const checkConsole = (message: ConsoleMessage) => leakedConsole.push(message.text().includes(canary))
  page.on('console', checkConsole)
  page.on('request', trackCredentialRequest)
  const noDraft = async () => {
    expect(
      await workbench
        .locator('body')
        .evaluate(
          (body, value) =>
            body.innerHTML.includes(value) ||
            [...body.querySelectorAll<HTMLInputElement>('input,textarea')].some((input) =>
              input.value.includes(value),
            ),
          canary,
        ),
    ).toBe(false)
  }
  try {
    await preferences(page)
    await openMcp()
    const createMcp = workbench.getByTestId('mcp-create')
    await expect(createMcp).toBeEnabled({ timeout: 30_000 })
    await createMcp.click()
    await workbench.locator('#mcp-method-remote').click()
    await expand(workbench.locator('#mcp-advanced'))
    await workbench.locator('#mcp-name').fill('Credential flow service')
    await workbench.locator('#mcp-url').fill('http://127.0.0.1:9/mcp')
    await workbench.getByTestId('mcp-credential-create').click()
    await workbench.getByTestId('credential-label').fill('Integration key')
    await workbench.getByTestId('credential-value').fill(canary)
    await expect(workbench.getByTestId('credential-value')).toHaveAttribute('type', 'password')
    const createdCredential = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/admin/api/credentials/create',
      { timeout: 30_000 },
    )
    await workbench.getByTestId('credential-save').click()
    expect((await createdCredential).status()).toBe(200)
    await expect(workbench.getByTestId('credential-editor')).toHaveCount(0)
    await expect(workbench.locator('#mcp-name')).toHaveValue('Credential flow service')
    const ref = await workbench.locator('#mcp-credential').inputValue()
    expect(ref.startsWith('secret://generic/')).toBe(true)
    await expect(workbench.locator('#mcp-secret')).toHaveValue(ref)
    await noDraft()
    await workbench.locator('#mcp-form button[type=submit]').click()
    await expect(workbench.locator('#admin-confirm[open]')).toBeVisible()
    const created = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/admin/resources/api/mcp/create',
    )
    await workbench.locator('#admin-confirm-action').click()
    const creation = await created
    expect(creation.status()).toBe(200)
    const createReceipt = (await creation.json()) as { operationId: string }
    await expect(workbench.locator('#mcp-dialog')).not.toBeVisible()
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
    await openCredentials()
    const row = workbench.getByTestId('credential-row').filter({ hasText: 'Integration key' })
    await expect(row).toBeVisible()
    await expect(row.getByTestId('credential-references')).toContainText('credential-flow-service')
    const before = (await client.credentials.list()).items.find((item) => item.id === ref)
    expect(before).toMatchObject({ id: ref, label: 'Integration key' })
    const writesBeforeReplacement = writes.length
    const actions = row.getByRole('button', { name: 'Actions for Integration key' })
    await actions.scrollIntoViewIfNeeded()
    await actions.press('Enter')
    await workbench.getByTestId('credential-replace').click()
    await expect(workbench.getByTestId('credential-value')).toHaveValue('')
    await workbench.getByTestId('credential-value').fill(`${canary}-discarded`)
    await workbench.getByTestId('credential-cancel').click()
    await expect(workbench.getByTestId('credential-editor')).toHaveCount(0)
    expect(writes).toHaveLength(writesBeforeReplacement)
    await noDraft()

    const replaceAndGoBack = async (suffix: string, reply: 'lost' | 'confirmed' | 'refused') => {
      let recordStatus!: (status: number) => void
      let release!: () => void
      const committed = new Promise<number>((resolve) => {
        recordStatus = resolve
      })
      const delivery = new Promise<void>((resolve) => {
        release = resolve
      })
      await page.route(
        `**${setPath}`,
        async (route) => {
          if (reply === 'refused') {
            recordStatus(403)
            await delivery
            await route.fulfill({ status: 403, json: { error: { code: 'E_ADMIN_FORBIDDEN' } } })
            return
          }
          const response = await route.fetch()
          recordStatus(response.status())
          await delivery
          if (reply === 'lost') await route.abort('failed')
          else await route.fulfill({ response })
        },
        { times: 1 },
      )
      try {
        await actions.click()
        await workbench.getByTestId('credential-replace').click()
        await expect(workbench.getByTestId('credential-value')).toHaveValue('')
        await workbench.getByTestId('credential-value').fill(`${canary}-${suffix}`)
        await workbench.getByTestId('credential-save').click()
        expect(await committed).toBe(reply === 'refused' ? 403 : 200)
        await expect(workbench.getByTestId('credential-cancel')).toBeDisabled()
        await workbench.getByTestId('settings-subpage-back').click()
        await expect(workbench.getByTestId('credential-editor')).toHaveCount(0)
        await expect(row.getByRole('status')).toHaveText(/A change to this credential is in progress/)
        await actions.click()
        await expect(workbench.getByTestId('credential-replace')).toBeDisabled()
        await expect(workbench.getByTestId('credential-delete')).toBeDisabled()
        await workbench.getByRole('menu', { name: 'Actions for Integration key' }).press('Escape')
      } finally {
        release()
      }
      await expect(row.getByRole('status')).toBeEmpty()
    }
    expectedBrowserErrors.push('console: Failed to load resource: net::ERR_FAILED')
    await replaceAndGoBack('lost-response', 'lost')
    const unconfirmed = workbench
      .getByTestId('operation-notice')
      .filter({ hasText: 'A replacement for Integration key could not be confirmed.' })
    await expect(unconfirmed).toBeVisible()
    await noDraft()

    expectedBrowserErrors.push(
      'console: Failed to load resource: the server responded with a status of 403 (Forbidden)',
    )
    await replaceAndGoBack('refused', 'refused')
    const refusal = workbench
      .getByTestId('operation-notice')
      .filter({ hasText: 'You do not have permission to manage credentials.' })
    await expect(refusal).toBeVisible()
    await expect(refusal).toHaveAttribute('role', 'alert')
    await expect(unconfirmed).toBeVisible()

    await replaceAndGoBack('replacement', 'confirmed')
    await expect(
      workbench
        .getByTestId('operation-notice')
        .filter({ hasText: 'Reconnect the MCP services using this credential.' }),
    ).toBeVisible()
    await expect(unconfirmed).toBeVisible()
    await expect(refusal).toHaveCount(0)
    expect(writes.slice(writesBeforeReplacement)).toEqual([setPath, setPath, setPath])
    await expect(row).toHaveAttribute('data-credential-id', ref)
    expect((await client.credentials.list()).items.find((item) => item.id === ref)).toEqual(before)
    expect(
      (await client.mcp.servers.list({ profile: 'local-dev' })).items.find(
        (item) => item.serverId === 'credential-flow-service',
      )?.definition?.secretBinding,
    ).toEqual({ kind: 'http-bearer', credentialRef: ref })
    await noDraft()

    await row.getByRole('button', { name: 'Actions for Integration key' }).click()
    await workbench.getByTestId('credential-rename').click()
    await workbench.getByTestId('credential-label').fill('Renamed integration key')
    await workbench.getByTestId('credential-save').click()
    const renamed = workbench.getByTestId('credential-row').filter({ hasText: 'Renamed integration key' })
    await expect(renamed).toBeVisible()
    await renamed.getByRole('button', { name: 'Actions for Renamed integration key' }).click()
    await workbench.getByTestId('credential-delete').click()
    const referencedDelete = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/admin/api/credentials/delete',
    )
    await workbench.getByTestId('credential-delete-confirm').click()
    expect((await referencedDelete).status()).toBe(409)
    expectedBrowserErrors.push(
      'console: Failed to load resource: the server responded with a status of 409 (Conflict)',
    )
    await expect(workbench.getByTestId('credential-delete-error')).toContainText('not deleted')
    await expect(workbench.getByTestId('credential-force-confirm')).not.toBeChecked()
    await workbench.getByTestId('credential-delete-cancel').click()
    await expect(unconfirmed).toBeVisible()
    await openMcp()
    await workbench.getByRole('button', { name: 'Credential flow service', exact: true }).click()
    await workbench.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(workbench.locator('#mcp-name')).toHaveValue('Credential flow service')
    await workbench.locator('#mcp-credential-trigger').click()
    await workbench.getByRole('option', { name: 'No credentials', exact: true }).click()
    await workbench.locator('#mcp-form button[type=submit]').click()
    const updated = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/admin/resources/api/mcp/update',
    )
    await workbench.locator('#admin-confirm-action').click()
    const update = await updated
    expect(update.status()).toBe(200)
    const updateReceipt = (await update.json()) as { operationId: string }
    await expect(workbench.locator('#mcp-dialog')).not.toBeVisible()
    // A saved form returns to the MCP list. Reopen the updated service through its page.
    await workbench.getByRole('button', { name: 'Credential flow service', exact: true }).click()
    await expect(workbench.locator('#resource-detail')).toContainText('Credential flow service')
    await workbench.getByTestId('push-back').click()
    await expect(workbench.locator('#resource-detail')).toBeHidden()
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
    await openCredentials()
    await workbench.getByTestId('credentials-refresh').click()
    await expect(renamed.getByTestId('credential-references')).toContainText('Not used')
    await expect(workbench.getByTestId('credentials-refresh')).toBeEnabled()
    await renamed.getByRole('button', { name: 'Actions for Renamed integration key' }).click()
    await workbench.getByTestId('credential-delete').click()
    let recordDeletion!: (status: number) => void
    let releaseDeletion!: () => void
    const deleted = new Promise<number>((resolve) => {
      recordDeletion = resolve
    })
    const deleteReply = new Promise<void>((resolve) => {
      releaseDeletion = resolve
    })
    await page.route(
      '**/admin/api/credentials/delete',
      async (route) => {
        const response = await route.fetch()
        recordDeletion(response.status())
        await deleteReply
        await route.fulfill({ response })
      },
      { times: 1 },
    )
    const deleteDialog = workbench.getByRole('dialog', { name: 'Delete Renamed integration key?' })
    try {
      await workbench.getByTestId('credential-delete-confirm').click()
      expect(await deleted).toBe(200)
      await expect(workbench.getByTestId('credential-delete-cancel')).toBeDisabled()
      await deleteDialog.press('Escape')
      await expect(deleteDialog).toBeVisible()
    } finally {
      releaseDeletion()
    }
    await expect(deleteDialog).toBeHidden()
    await expect(renamed).toHaveCount(0)
    await noDraft()
  } finally {
    page.off('request', trackCredentialRequest)
    // Stop collecting before the drain: a background refresh must not enqueue a body read
    // after the final assertions or race the fixture closing the page.
    try {
      await drainCredentialResponses()
    } finally {
      page.off('console', checkConsole)
    }
  }
  expect(unreadResponses).toEqual([])
  expect(leakedResponses.length > 0).toBe(true)
  expect(leakedResponses.some(Boolean)).toBe(false)
  expect(leakedConsole.some(Boolean)).toBe(false)
})

test('a credential deleted through the daemon SDK disconnects the Cloud workbench in both tabs', async ({
  page,
  context,
  runtime,
}) => {
  const client = await runtime.connect()
  const { id } = await client.credentials.create({ label: 'Cloud fixture', value: 'synthetic-cloud-key' })
  const other = await client.credentials.create({ label: 'Unrelated fixture', value: 'synthetic-other-key' })
  const remote = 'http://127.0.0.1:1'
  const binding = `agnes.cloud.credential.v1:${remote}`
  await preferences(page)
  await page.goto(runtime.url)
  const cloudOrigin = await page.locator('#agnes-config').getAttribute('data-cloud-origin')
  expect(cloudOrigin).toBeTruthy()
  await context.route(
    (url) => url.origin === cloudOrigin && url.searchParams.get('remote') === remote,
    (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><p>Cloud fixture</p><script>
        parent.postMessage({
          type: 'agh.backend.frame/v1',
          kind: 'state',
          snapshot: { ready: true, connected: true, rows: [], activity: [], more: false }
        }, ${JSON.stringify(runtime.url)})
      </script>`,
      }),
  )
  await page.evaluate(
    ({ id, remote, binding }) => {
      localStorage.setItem('agnes.cloud.origin.v1', remote)
      localStorage.setItem(binding, id)
    },
    { id, remote, binding },
  )
  const second = await context.newPage()
  const workbench = new URL(runtime.url)
  workbench.searchParams.set('remote', remote)
  try {
    for (const tab of [page, second]) {
      const credentials = tab.waitForResponse(
        (response) => new URL(response.url()).pathname === '/admin/api/credentials' && response.ok(),
      )
      await tab.goto(workbench.href)
      await credentials
      await expect(
        tab.getByTestId('backend-frame-cloud').contentFrame().getByText('Cloud fixture'),
      ).toBeVisible()
    }
    await client.credentials.delete({ id: other.id })
    await expect(page.getByTestId('backend-frame-cloud')).toHaveCount(1)
    await expect(second.getByTestId('backend-frame-cloud')).toHaveCount(1)
    await client.credentials.delete({ id })
    for (const tab of [page, second]) {
      await expect(tab.getByTestId('backend-frame-cloud')).toHaveCount(0)
      expect(await tab.evaluate((key) => localStorage.getItem(key), binding)).toBeNull()
    }
  } finally {
    await second.close()
  }
})
