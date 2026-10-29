/** @vitest-environment happy-dom */
import type { PackageInstalledDescriptor, PackageOperation } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { forgetInventory } from '../src/admin/plugins/admin/inventory-cache.js'
import { PluginAdminPage } from '../src/admin/plugins/admin/page.js'
import { PluginAdminApi } from '../src/admin/plugins/api.js'

afterEach(() => {
  forgetInventory()
  vi.restoreAllMocks()
  document.body.replaceChildren()
  sessionStorage.clear()
})

const context = {
  profile: 'enable-refresh',
  clientId: 'web',
  permissions: ['packages.read', 'packages.trust', 'packages.activate'] as const,
  readOnly: false,
}
const untrusted = {
  id: '@agnes-examples/hot-tool-plugin',
  version: '1.0.0',
  source: { type: 'file', ref: 'file:./hot-tool-plugin' },
  integrity: `sha256-${'a'.repeat(64)}`,
  trusted: false,
  desired: 'installed-disabled',
  actual: 'not-running',
  cleanupPending: false,
  rollbackTarget: null,
  contributions: [],
  blockers: [],
  capabilityHash: 'c'.repeat(64),
} as unknown as PackageInstalledDescriptor
const trusted = { ...untrusted, trusted: true } as PackageInstalledDescriptor
const enabled = { ...trusted, desired: 'enabled', actual: 'running' } as PackageInstalledDescriptor

function settled(operationId: string, kind: 'trust' | 'enable', installed: PackageInstalledDescriptor) {
  return {
    operationId,
    profile: context.profile,
    operation: kind,
    state: 'completed',
    packageId: installed.id,
    installed,
  } as unknown as PackageOperation
}

it('shows the enabled plugin after trust and enable, even when a read from before the enable lands last', async () => {
  let backend: PackageInstalledDescriptor = untrusted
  const overview = vi
    .spyOn(PluginAdminApi, 'overview')
    .mockImplementation(async () => ({ context, inventory: { packages: [backend] } }) as never)
  vi.spyOn(PluginAdminApi.prototype, 'treeList').mockResolvedValue({ nodes: [] } as never)
  vi.spyOn(PluginAdminApi.prototype, 'surfaceLinks').mockResolvedValue({ surfaces: [] })
  vi.spyOn(PluginAdminApi.prototype, 'runtime').mockRejectedValue(new Error('optional'))
  vi.spyOn(PluginAdminApi.prototype, 'composition').mockRejectedValue(new Error('optional'))
  vi.spyOn(PluginAdminApi.prototype, 'catalog').mockResolvedValue({ items: [], nextCursor: null })
  vi.spyOn(PluginAdminApi.prototype, 'trust').mockResolvedValue({ operationId: 'trust-1' } as never)
  const enable = vi
    .spyOn(PluginAdminApi.prototype, 'enable')
    .mockResolvedValue({ operationId: 'enable-1' } as never)
  let settleEnable: (() => void) | undefined
  vi.spyOn(PluginAdminApi.prototype, 'operation').mockImplementation(async (operationId: string) => {
    if (operationId === 'trust-1') {
      backend = trusted
      return settled('trust-1', 'trust', trusted)
    }
    // The enable is still running when it is first read; it settles when the test says so.
    await new Promise<void>((resolve) => {
      settleEnable = resolve
    })
    backend = enabled
    return settled('enable-1', 'enable', enabled)
  })
  for (const id of ['plugin-detail', 'source-dialog', 'plugin-confirm']) {
    const dialog = document.createElement('dialog')
    dialog.id = id
    document.body.append(dialog)
  }
  const page = new PluginAdminPage({
    surface: { host: document.body.appendChild(document.createElement('div')), render: () => null },
  })
  const row = () => page.viewContext().state.installed.find((item) => item.id === untrusted.id)
  try {
    await page.start()
    expect(row()?.trusted).toBe(false)
    await page.confirmEnable(row() as PackageInstalledDescriptor)
    await page.viewContext().pendingConfirm?.run()
    // Trust has landed and the enable it asked for is running.
    await vi.waitFor(() => expect(settleEnable).toBeDefined())
    expect(enable).toHaveBeenCalledWith(untrusted.id)
    expect(row()).toMatchObject({ trusted: true, desired: 'installed-disabled' })
    // A read starts now (a refresh, a focus, a package notice) and answers with what was true then.
    let answerStale: (() => void) | undefined
    overview.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerStale = () => resolve({ context, inventory: { packages: [trusted] } } as never)
        }),
    )
    void page.refresh()
    await vi.waitFor(() => expect(answerStale).toBeDefined())
    settleEnable?.()
    await vi.waitFor(() => expect(page.viewContext().state.lastOperation?.operation).toBe('enable'))
    answerStale?.()
    await vi.waitFor(() => expect(page.viewContext().state.loading).toBe(false))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(page.viewContext().state.loading).toBe(false)
    expect(row()).toMatchObject({ trusted: true, desired: 'enabled', actual: 'running' })
  } finally {
    page.dispose()
  }
})

it('starts a new overview read once told the pending one is out of date', async () => {
  const answers: Array<() => void> = []
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        answers.push(() => resolve(Response.json({ context, inventory: { packages: [] } })))
      }),
  )
  const first = PluginAdminApi.overview(fetcher)
  const joined = PluginAdminApi.overview(fetcher)
  expect(fetcher).toHaveBeenCalledTimes(1)
  PluginAdminApi.forgetPendingOverview(fetcher)
  const fresh = PluginAdminApi.overview(fetcher)
  expect(fetcher).toHaveBeenCalledTimes(2)
  for (const answer of answers) answer()
  await expect(Promise.all([first, joined, fresh])).resolves.toHaveLength(3)
})
