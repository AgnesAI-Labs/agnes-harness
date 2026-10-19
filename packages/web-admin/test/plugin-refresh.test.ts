/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest'
import { forgetInventory } from '../src/admin/plugins/admin/inventory-cache.js'
import { PluginAdminPage } from '../src/admin/plugins/admin/page.js'
import { PluginAdminApi } from '../src/admin/plugins/api.js'
import { visibleRefresh } from '../src/visible-refresh.js'

afterEach(() => {
  forgetInventory()
  vi.restoreAllMocks()
  vi.useRealTimers()
  document.body.replaceChildren()
  sessionStorage.clear()
})

it('reads the plugin tree on mount, real changes and one explicit refresh, and rests when idle or hidden', async () => {
  vi.useFakeTimers()
  let hidden = false
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => (hidden ? 'hidden' : 'visible'))
  vi.spyOn(PluginAdminApi, 'context').mockResolvedValue({
    profile: 'test',
    clientId: 'web',
    permissions: ['packages.read'],
    readOnly: false,
  })
  vi.spyOn(PluginAdminApi.prototype, 'list').mockResolvedValue({ packages: [] } as never)
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
    operation.mockResolvedValue({
      operationId: 'op-running',
      operation: 'enable',
      state: 'completed',
    } as never)
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(operation).toHaveBeenCalledTimes(3)
    expect(tree).toHaveBeenCalledTimes(5)
    vi.mocked(PluginAdminApi.prototype.list).mockRejectedValueOnce(new Error('temporary outage'))
    await page.refresh()
    expect(page.viewContext().state.connection).toBe('offline')
    expect(page.viewContext().state.inventoryAuthoritative).toBe(false)
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(page.viewContext().state.connection).toBe('connected')
    expect(tree).toHaveBeenCalledTimes(7)
    page.dispose()
    window.dispatchEvent(new Event('agnes:plugins-invalidated'))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(tree).toHaveBeenCalledTimes(7)
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

it('reuses recent inventory only after checking context, while changes and expiry force reads', async () => {
  vi.useFakeTimers()
  const context = vi.spyOn(PluginAdminApi, 'context').mockResolvedValue({
    profile: 'fresh',
    clientId: 'web',
    permissions: ['packages.read'],
    readOnly: false,
  })
  const list = vi.spyOn(PluginAdminApi.prototype, 'list').mockResolvedValue({ packages: [] } as never)
  vi.spyOn(PluginAdminApi.prototype, 'treeList').mockResolvedValue({ nodes: [] } as never)
  vi.spyOn(PluginAdminApi.prototype, 'surfaceLinks').mockResolvedValue({ surfaces: [] })
  vi.spyOn(PluginAdminApi.prototype, 'runtime').mockResolvedValue({ providers: [] } as never)
  vi.spyOn(PluginAdminApi.prototype, 'composition').mockResolvedValue({} as never)
  vi.spyOn(PluginAdminApi.prototype, 'catalog').mockResolvedValue({ items: [], nextCursor: null })
  const pins = vi.spyOn(PluginAdminApi.prototype, 'pinsInspect').mockRejectedValue(new Error('not allowed'))
  for (const id of ['plugin-detail', 'source-dialog', 'plugin-confirm']) {
    const dialog = document.createElement('dialog')
    dialog.id = id
    document.body.append(dialog)
  }
  const create = () =>
    new PluginAdminPage({
      surface: { host: document.body.appendChild(document.createElement('div')), render: () => null },
    })
  let page = create()
  try {
    await page.start()
    expect(list).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(list).toHaveBeenCalledTimes(1)
    page.dispose()
    page = create()
    await page.start()
    expect(context).toHaveBeenCalledTimes(2)
    expect(list).toHaveBeenCalledTimes(1)
    expect(page.viewContext().state.connection).toBe('connected')
    expect(pins).not.toHaveBeenCalled()
    await page.refresh()
    expect(list).toHaveBeenCalledTimes(2)
    page.dispose()
    window.dispatchEvent(new Event('agnes:plugins-invalidated'))
    page = create()
    await page.start()
    expect(list).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(30_001)
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(list).toHaveBeenCalledTimes(4)
    page.dispose()
    context.mockResolvedValue({ profile: 'other', clientId: 'web', permissions: [], readOnly: true })
    page = create()
    await page.start()
    expect(list).toHaveBeenCalledTimes(5)
    expect(page.viewContext().canEffect('packages.install')).toBe(false)
    page.dispose()
    context.mockRejectedValueOnce(new Error('offline'))
    page = create()
    await page.start()
    expect(list).toHaveBeenCalledTimes(5)
    expect(page.viewContext().state.inventoryAuthoritative).toBe(false)
    expect(page.viewContext().state.connection).toBe('offline')
  } finally {
    page.dispose()
  }
})
