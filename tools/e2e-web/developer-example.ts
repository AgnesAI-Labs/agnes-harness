import { resolve, sep } from 'node:path'
import type { NodeClient } from '@agnes/sdk'
import type { Page, Request } from '@playwright/test'
import { expect } from './fixtures.js'
import { complete } from './sdk.js'
import { homePage } from './ui.js'

/** Installs an agent through the reviewed local-source flow and waits for its worker generation. */
export async function installAgentSource(page: Page, client: NodeClient, directory: string, ref: string) {
  const id = ref.split('#')[0]
  // Establish the resident worker generation before the UI captures its activation baseline.
  await client.call('_agnes/v1/channels.catalog', {}, { timeoutMs: 120_000 })
  await homePage(page, 'plugins')
  await page.getByTestId('plugin-install-source').click()
  const source = page.getByRole('dialog', { name: 'Check a plugin source', exact: true })
  await source.getByRole('combobox', { name: 'Source type', exact: true }).selectOption('file')
  const refValue = `file:${resolve(directory).split(sep).join('/')}`
  await source.getByRole('textbox', { name: 'Source reference', exact: true }).fill(refValue)
  const check = source.getByRole('button', { name: 'Check source', exact: true })
  let inspectSent = false
  const observeInspect = (request: Request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/admin/plugins/api/inspect' &&
      request.postDataJSON()?.source?.ref === refValue
    )
      inspectSent = true
  }
  page.on('request', observeInspect)
  try {
    // A refresh can disable the button between actionability and the browser's click.
    // Repeat only an unsent inspection while the form offers the action.
    await expect(async () => {
      if (!inspectSent && (await check.isEnabled({ timeout: 1_000 }))) await check.click({ timeout: 2_000 })
      expect(inspectSent, 'the source inspection was submitted').toBe(true)
    }).toPass({ timeout: 15_000 })
  } finally {
    page.off('request', observeInspect)
  }
  const install = page
    .getByTestId('install-review')
    .getByRole('button', { name: 'Install and enable', exact: true })
  await expect(install).toBeEnabled({ timeout: 30_000 })
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/admin/plugins/api/enable' &&
        response.request().method() === 'POST' &&
        response.request().postDataJSON()?.id === id,
      { timeout: 120_000 },
    ),
    install.click(),
  ])
  expect(response.ok(), 'the approved enable request was accepted').toBe(true)
  const receipt = (await response.json()) as Awaited<ReturnType<NodeClient['packages']['enable']>>
  await complete(client, receipt, 120_000).catch(async (cause: unknown) => {
    const actual = await client.packages
      .list({ profile: 'local-dev' })
      .then(({ packages }) => packages.find((row) => row.id === id)?.actual)
      .catch(() => undefined)
    throw new Error(`Enable failed for ${id} (runtime: ${actual ?? 'unavailable'})`, { cause })
  })
  await expect(page.getByTestId('install-review')).toBeHidden({ timeout: 90_000 })
  // Activation can publish a generation while @shared is absent. This read acquires that
  // worker through the same resolver the launch uses.
  await client.call('_agnes/v1/agents.resolve', { ref }, { timeoutMs: 120_000 })
  expect(
    (await client.packages.list({ profile: 'local-dev' })).packages.find((row) => row.id === id),
  ).toMatchObject({ desired: 'enabled', actual: 'running' })
}
