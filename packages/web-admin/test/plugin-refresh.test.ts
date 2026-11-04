/** @vitest-environment happy-dom */

import type {
  PackageCatalogPage,
  PackageInstalledDescriptor,
  PackageOperation,
  PackagePreview,
} from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { forgetInventory } from '../src/admin/plugins/admin/inventory-cache.js'
import { OperationBackoff, withOperationDesired } from '../src/admin/plugins/admin/operation-refresh.js'
import { PluginAdminPage } from '../src/admin/plugins/admin/page.js'
import { PluginAdminApi } from '../src/admin/plugins/api.js'
import { ADMIN_FEATURES } from '../src/admin/plugins/types.js'
import { visibleRefresh } from '../src/visible-refresh.js'

afterEach(() => {
  forgetInventory()
  vi.restoreAllMocks()
  vi.useRealTimers()
  document.body.replaceChildren()
  sessionStorage.clear()
})

it('keeps newer catalog community data when an older background read finishes last', async () => {
  const context = {
    profile: 'community-refresh',
    clientId: 'web',
    permissions: ['packages.read'] as const,
    readOnly: false,
  }
  const community = (totalReported: number): NonNullable<PackageCatalogPage['community']> => ({
    state: 'ready',
    error: null,
    items: [],
    totalReported,
    lastSuccessAt: '2026-11-04T00:00:00.000Z',
    nextAttemptAt: null,
  })
  vi.spyOn(PluginAdminApi, 'overview').mockResolvedValue({ context, inventory: { packages: [] } })
  vi.spyOn(PluginAdminApi.prototype, 'treeList').mockResolvedValue({ nodes: [] } as never)
  vi.spyOn(PluginAdminApi.prototype, 'surfaceLinks').mockResolvedValue({ surfaces: [] })
  vi.spyOn(PluginAdminApi.prototype, 'runtime').mockRejectedValue(new Error('optional'))
  vi.spyOn(PluginAdminApi.prototype, 'composition').mockRejectedValue(new Error('optional'))
  const catalog = vi
    .spyOn(PluginAdminApi.prototype, 'catalog')
    .mockResolvedValue({ items: [], nextCursor: null, community: community(1) })
  for (const id of ['plugin-detail', 'source-dialog', 'plugin-confirm']) {
    const dialog = document.createElement('dialog')
    dialog.id = id
    document.body.append(dialog)
  }
  const page = new PluginAdminPage({
    surface: { host: document.body.appendChild(document.createElement('div')), render: () => null },
  })
  try {
    await page.start()
    await page.selectTab('discover')
    let complete!: (result: PackageCatalogPage) => void
    catalog.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    const pending = page.viewContext().refreshCommunity()
    catalog.mockResolvedValueOnce({ items: [], nextCursor: null, community: community(2) })
    await page.loadCatalog()
    complete({ items: [], nextCursor: null, community: community(1) })
    await pending
    expect(page.viewContext().state.community?.totalReported).toBe(2)
    catalog.mockRejectedValueOnce(new Error('offline'))
    await page.viewContext().refreshCommunity()
    expect(page.viewContext().state.community?.totalReported).toBe(2)
    expect(page.viewContext().state.communityReadFailed).toBe(true)
    catalog.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    const leaving = page.viewContext().refreshCommunity()
    await page.selectTab('installed')
    complete({ items: [], nextCursor: null, community: community(3) })
    await leaving
    expect(page.viewContext().state.community?.totalReported).toBe(2)
  } finally {
    page.dispose()
  }
})

it.each(['new-content', 'same-content', 'blocked', 'trusted'] as const)(
  'reviews an installed source as an update: %s',
  async (mode) => {
    const row = {
      id: '@fixture/community',
      version: '1.0.0',
      integrity: `sha256-${'a'.repeat(64)}`,
      contributions: [],
      desired: 'installed-disabled',
      actual: 'not-running',
      trusted: mode === 'trusted',
      capabilityHash: 'c'.repeat(64),
    } as unknown as PackageInstalledDescriptor
    const context = {
      profile: 'source-update',
      clientId: 'web',
      permissions: ['packages.read', 'packages.install', 'packages.trust', 'packages.activate'] as const,
      features: Object.values(ADMIN_FEATURES),
      readOnly: false,
    }
    vi.spyOn(PluginAdminApi, 'overview').mockResolvedValue({ context, inventory: { packages: [row] } })
    vi.spyOn(PluginAdminApi.prototype, 'treeList').mockResolvedValue({ nodes: [] } as never)
    vi.spyOn(PluginAdminApi.prototype, 'surfaceLinks').mockResolvedValue({ surfaces: [] })
    vi.spyOn(PluginAdminApi.prototype, 'runtime').mockRejectedValue(new Error('optional'))
    vi.spyOn(PluginAdminApi.prototype, 'composition').mockRejectedValue(new Error('optional'))
    vi.spyOn(PluginAdminApi.prototype, 'catalog').mockResolvedValue({ items: [], nextCursor: null })
    const source = { type: 'git' as const, ref: 'git:https://github.com/fixture/community.git' }
    const preview = {
      ...row,
      source,
      version: '2.0.0',
      integrity: mode === 'same-content' ? row.integrity : `sha256-${'b'.repeat(64)}`,
      warnings: [],
      blockers:
        mode === 'blocked' ? [{ code: 'unsupported-manifest', safeMessage: 'Unsupported format' }] : [],
      capabilityDiff: { added: [], removed: [] },
    } as unknown as PackagePreview
    vi.spyOn(PluginAdminApi.prototype, 'inspect').mockResolvedValue({
      operationId: 'inspect-community',
      profile: context.profile,
    })
    vi.spyOn(PluginAdminApi.prototype, 'operation').mockResolvedValue({
      operationId: 'inspect-community',
      operation: 'inspect',
      state: 'completed',
      preview,
    } as PackageOperation)
    const update = vi
      .spyOn(PluginAdminApi.prototype, 'update')
      .mockResolvedValue({ operationId: 'update-community', profile: context.profile })
    const install = vi.spyOn(PluginAdminApi.prototype, 'install')
    for (const id of ['plugin-detail', 'source-dialog', 'plugin-confirm']) {
      const dialog = document.createElement('dialog')
      dialog.id = id
      document.body.append(dialog)
    }
    const page = new PluginAdminPage({
      surface: { host: document.body.appendChild(document.createElement('div')), render: () => null },
    })
    try {
      await page.start()
      await page.inspect(source, 'install', document.createElement('button'))
      await vi.waitFor(() => expect(page.viewContext().state.preview).toBeDefined())
      expect(page.viewContext().state.previewMode).toBe('update')
      await page.confirmReview()
      if (mode === 'blocked') expect(update).not.toHaveBeenCalled()
      else if (mode === 'trusted')
        expect(update).toHaveBeenCalledWith(row.id, source, preview.integrity, {
          expectedInstalledIntegrity: row.integrity,
          expectedActiveIntegrity: null,
          trust: { integrity: preview.integrity, capabilityHash: preview.capabilityHash },
        })
      else expect(update).toHaveBeenCalledWith(row.id, source, preview.integrity, undefined)
      expect(install).not.toHaveBeenCalled()
    } finally {
      page.dispose()
    }
  },
)

it('reads the plugin tree on mount, real changes and one explicit refresh, and rests when idle or hidden', async () => {
  vi.useFakeTimers()
  let hidden = false
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => (hidden ? 'hidden' : 'visible'))
  const context = {
    profile: 'test',
    clientId: 'web',
    permissions: ['packages.read'] as const,
    readOnly: false,
  }
  const enabled = {
    id: '@agnes/fixture',
    integrity: 'a',
    desired: 'enabled',
    actual: 'running',
    contributions: [],
  } as never
  const disabled = { ...(enabled as object), desired: 'installed-disabled' } as never
  const overview = vi.spyOn(PluginAdminApi, 'overview').mockResolvedValue({
    context,
    inventory: { packages: [enabled] },
  })
  const tree = vi.spyOn(PluginAdminApi.prototype, 'treeList').mockResolvedValue({ nodes: [] } as never)
  vi.spyOn(PluginAdminApi.prototype, 'surfaceLinks').mockResolvedValue({ surfaces: [] })
  vi.spyOn(PluginAdminApi.prototype, 'runtime').mockRejectedValue(new Error('optional'))
  vi.spyOn(PluginAdminApi.prototype, 'composition').mockRejectedValue(new Error('optional'))
  vi.spyOn(PluginAdminApi.prototype, 'catalog').mockResolvedValue({ items: [], nextCursor: null })
  vi.spyOn(PluginAdminApi.prototype, 'pinsInspect').mockResolvedValue({ orphans: [] } as never)
  for (const id of ['plugin-detail', 'source-dialog', 'plugin-confirm']) {
    const dialog = document.createElement('dialog')
    dialog.id = id
    document.body.append(dialog)
  }
  const page = new PluginAdminPage({
    surface: { host: document.body.appendChild(document.createElement('div')), render: () => null },
  })
  try {
    await page.start()
    expect(tree).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(tree).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event('agnes:plugins-invalidated'))
    await vi.advanceTimersByTimeAsync(0)
    expect(tree).toHaveBeenCalledTimes(2)
    await Promise.all([page.refresh(), page.refresh(), page.refresh()])
    expect(tree).toHaveBeenCalledTimes(3)
    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('agnes:plugins-invalidated'))
    await page.refresh()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(tree).toHaveBeenCalledTimes(3)
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(tree).toHaveBeenCalledTimes(4)
    const operation = vi
      .spyOn(PluginAdminApi.prototype, 'operation')
      .mockResolvedValue({ operationId: 'op-running', operation: 'enable', state: 'running' } as never)
    page.track('op-running')
    await vi.advanceTimersByTimeAsync(0)
    window.dispatchEvent(new Event('agnes:plugins-invalidated'))
    window.dispatchEvent(new Event('agnes:plugins-invalidated'))
    expect(operation).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1200)
    expect(operation).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1200)
    expect(operation).toHaveBeenCalledTimes(2)
    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(operation).toHaveBeenCalledTimes(2)
    expect(tree).toHaveBeenCalledTimes(4)
    let finishOverview: (() => void) | undefined
    overview.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOverview = () => resolve({ context, inventory: { packages: [disabled] } })
        }),
    )
    operation.mockResolvedValue({
      operationId: 'op-running',
      operation: 'disable',
      state: 'completed',
      packageId: '@agnes/fixture',
      installed: disabled,
    } as never)
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(operation).toHaveBeenCalledTimes(3)
    // A confirmed disable renders before the full inventory refresh can answer.
    expect(page.viewContext().state.installed[0]?.desired).toBe('installed-disabled')
    expect(page.viewContext().state.lastOperation?.state).toBe('completed')
    expect(tree).toHaveBeenCalledTimes(4)
    finishOverview?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(tree).toHaveBeenCalledTimes(5)
    overview.mockRejectedValueOnce(new Error('temporary outage'))
    await page.refresh()
    expect(page.viewContext().state.connection).toBe('offline')
    expect(page.viewContext().state.inventoryAuthoritative).toBe(false)
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(page.viewContext().state.connection).toBe('connected')
    expect(tree).toHaveBeenCalledTimes(6)
    page.dispose()
    window.dispatchEvent(new Event('agnes:plugins-invalidated'))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(tree).toHaveBeenCalledTimes(6)
  } finally {
    page.dispose()
  }
})

it('coalesces changes during a read into one follow-up and ignores completion after disposal', async () => {
  let finish: (() => void) | undefined
  const read = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const reader = visibleRefresh(read, ['agnes:plugins-invalidated'])
  try {
    const first = reader.request()
    await Promise.resolve()
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    for (let i = 0; i < 3; i++) window.dispatchEvent(new Event('agnes:plugins-invalidated'))
    expect(read).toHaveBeenCalledTimes(1)
    finish?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(read).toHaveBeenCalledTimes(2)
    window.dispatchEvent(new Event('agnes:plugins-invalidated'))
    reader.dispose()
    finish?.()
    await first
    expect(read).toHaveBeenCalledTimes(2)
  } finally {
    reader.dispose()
  }
})

it('reuses optional feeds while every refresh obtains a fresh verified overview', async () => {
  vi.useFakeTimers()
  const overview = vi.spyOn(PluginAdminApi, 'overview').mockResolvedValue({
    context: {
      profile: 'fresh',
      clientId: 'web',
      permissions: ['packages.read', 'packages.install'],
      readOnly: false,
    },
    inventory: { packages: [] },
  })
  const list = vi.spyOn(PluginAdminApi.prototype, 'list').mockResolvedValue({ packages: [] } as never)
  let finishTree!: (value: Awaited<ReturnType<PluginAdminApi['treeList']>>) => void
  const pendingTree = new Promise<Awaited<ReturnType<PluginAdminApi['treeList']>>>((resolve) => {
    finishTree = resolve
  })
  const tree = vi
    .spyOn(PluginAdminApi.prototype, 'treeList')
    .mockResolvedValue({ nodes: [] } as never)
    .mockImplementationOnce(() => pendingTree)
  vi.spyOn(PluginAdminApi.prototype, 'surfaceLinks').mockResolvedValue({ surfaces: [] })
  let finishRuntime!: (value: Awaited<ReturnType<PluginAdminApi['runtime']>>) => void
  const pendingRuntime = new Promise<Awaited<ReturnType<PluginAdminApi['runtime']>>>((resolve) => {
    finishRuntime = resolve
  })
  vi.spyOn(PluginAdminApi.prototype, 'runtime')
    .mockResolvedValue({ providers: [] } as never)
    .mockImplementationOnce(() => pendingRuntime)
  vi.spyOn(PluginAdminApi.prototype, 'composition').mockResolvedValue({} as never)
  vi.spyOn(PluginAdminApi.prototype, 'catalog').mockResolvedValue({ items: [], nextCursor: null })
  const pins = vi.spyOn(PluginAdminApi.prototype, 'pinsInspect').mockRejectedValue(new Error('not allowed'))
  const inspect = vi.spyOn(PluginAdminApi.prototype, 'inspect').mockRejectedValue(new Error('not ready'))
  for (const id of ['plugin-detail', 'source-dialog', 'plugin-confirm']) {
    const dialog = document.createElement('dialog')
    dialog.id = id
    document.body.append(dialog)
  }
  const render = vi.fn(() => null)
  const create = () =>
    new PluginAdminPage({
      surface: { host: document.body.appendChild(document.createElement('div')), render },
    })
  let page = create()
  try {
    const ready = page.start()
    await vi.waitFor(() => expect(page.viewContext().state.context?.profile).toBe('fresh'))
    await page.selectTab('discover')
    expect(page.viewContext().state.inventoryAuthoritative).toBe(false)
    expect(page.viewContext().canEffect('packages.install')).toBe(false)
    expect((await page.inspect({ type: 'file', ref: 'file:./synthetic' }, 'install', document.body)).ok).toBe(
      false,
    )
    expect(inspect).not.toHaveBeenCalled()
    finishTree({ nodes: [] } as never)
    await vi.waitFor(() => expect(page.viewContext().canEffect('packages.install')).toBe(true))
    await ready
    await page.selectTab('installed')
    expect(overview).toHaveBeenCalledTimes(1)
    expect(tree).toHaveBeenCalledTimes(1)
    expect(list).not.toHaveBeenCalled()
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(overview).toHaveBeenCalledTimes(1)
    page.dispose()
    page = create()
    await page.start()
    expect(overview).toHaveBeenCalledTimes(2)
    expect(tree).toHaveBeenCalledTimes(1)
    expect(page.viewContext().state.connection).toBe('connected')
    expect(pins).not.toHaveBeenCalled()
    await page.refresh()
    expect(overview).toHaveBeenCalledTimes(3)
    expect(tree).toHaveBeenCalledTimes(2)
    page.dispose()
    window.dispatchEvent(new Event('agnes:plugins-invalidated'))
    page = create()
    await page.start()
    expect(overview).toHaveBeenCalledTimes(4)
    expect(tree).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(30_001)
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(overview).toHaveBeenCalledTimes(5)
    expect(tree).toHaveBeenCalledTimes(4)
    page.dispose()
    overview.mockResolvedValue({
      context: { profile: 'other', clientId: 'web', permissions: [], readOnly: true },
    })
    page = create()
    await page.start()
    expect(overview).toHaveBeenCalledTimes(6)
    expect(page.viewContext().canEffect('packages.install')).toBe(false)
    page.dispose()
    overview.mockRejectedValueOnce(new Error('offline'))
    page = create()
    await page.start()
    expect(overview).toHaveBeenCalledTimes(7)
    expect(list).not.toHaveBeenCalled()
    expect(page.viewContext().state.inventoryAuthoritative).toBe(false)
    expect(page.viewContext().state.connection).toBe('offline')
    page.dispose()
    render.mockClear()
    finishRuntime({ providers: [] } as never)
    await vi.advanceTimersByTimeAsync(0)
    expect(render).not.toHaveBeenCalled()
  } finally {
    page.dispose()
    finishTree({ nodes: [] } as never)
    finishRuntime({ providers: [] } as never)
  }
})

it('notices a slow operation within a few seconds of it finishing', () => {
  const backoff = new OperationBackoff(new Map())
  const waits = Array.from({ length: 12 }, () => backoff.next('op', 1200, 3000))
  expect(waits.slice(0, 3)).toEqual([1200, 2400, 3000])
  expect(Math.max(...waits)).toBe(3000)
  const reconnect = new OperationBackoff(new Map())
  expect(Array.from({ length: 8 }, () => reconnect.next('op', 3000)).at(-1)).toBe(30_000)
})

it('shows a completed disable on the plugin row before the inventory is read again', () => {
  const row = (id: string, desired: string) => ({ id, desired }) as never
  const installed = [row('@agnes/a', 'enabled'), row('@agnes/b', 'enabled')]
  const done = (operation: string, state: string, desired: string) =>
    ({ operation, state, installed: row('@agnes/a', desired) }) as never
  expect(withOperationDesired(installed, done('disable', 'completed', 'installed-disabled'))).toEqual([
    row('@agnes/a', 'installed-disabled'),
    row('@agnes/b', 'enabled'),
  ])
  for (const other of [
    done('disable', 'failed', 'installed-disabled'),
    done('update', 'completed', 'installed-disabled'),
  ])
    expect(withOperationDesired(installed, other)).toBe(installed)
})
