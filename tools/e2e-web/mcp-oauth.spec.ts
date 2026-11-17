import { expect, test } from './fixtures.js'
import { startOAuthFixture } from './oauth-fixture.js'
import { preferences } from './ui.js'

// The browser follows the sign-in to the fake authorization server's self-signed address.
test.use({ ignoreHTTPSErrors: true })

test('Authorizing an OAuth MCP server from its page ends on a result page and the page reads Authorized', async ({
  page,
  runtime,
}) => {
  test.setTimeout(120_000)
  const oauth = await startOAuthFixture()
  try {
    await runtime.cli([
      'mcp',
      'add',
      'oauth-e2e',
      '--name',
      'OAuth E2E',
      '--http',
      oauth.serverUrl,
      '--oauth',
      '--oauth-client-id',
      'e2e-client',
      '--yes',
    ])
    await preferences(page, 'en')
    const skip = page.getByTestId('first-run-skip')
    await page.addLocatorHandler(skip, () => skip.click(), { times: 1 })
    const mcpPage = new URL('/?page=plugins&tab=mcp', runtime.url).href
    await page.goto(mcpPage)
    await page
      .getByRole('button', { name: /OAuth E2E/ })
      .first()
      .click()
    const status = page.getByTestId('mcp-oauth')
    await expect(status).toHaveAttribute('data-status', 'pending')

    // Same page address as the callback address: no question before leaving.
    await page.getByTestId('mcp-oauth-authorize').click()
    await page.waitForURL(/\/oauth\/oauth-e2e\/callback/)
    await expect(page.getByText('AGH sign-in complete. You can close this page.')).toBeVisible()
    expect(oauth.tokenRequests).toHaveLength(1)

    await page.goto(mcpPage)
    await page
      .getByRole('button', { name: /OAuth E2E/ })
      .first()
      .click()
    await expect(page.getByTestId('mcp-oauth')).toHaveAttribute('data-status', 'authorized')
    await expect(page.getByTestId('mcp-oauth')).toContainText('Authorized')
  } finally {
    await oauth.close()
  }
})
