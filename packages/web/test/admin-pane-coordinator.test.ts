import { createAdminPaneStore } from '@agnes/web-units/admin-pane-store'
import { describe, expect, it, vi } from 'vitest'
import { createAdminPaneController, createPendingCoordinator } from '../src/admin-pane-coordinator.js'

describe('admin pane pending coordinator', () => {
  it('shares one in-flight operation for repeated clicks on the same pane', async () => {
    const coordinator = createPendingCoordinator<'resources' | 'plugin'>()
    const release = vi.fn<() => void>()
    let resolve!: () => void
    const operation = new Promise<void>((done) => {
      resolve = done
    })

    const first = coordinator.run('resources', async () => {
      release()
      await operation
    })
    const second = coordinator.run('resources', async () => {
      throw new Error('duplicate operation')
    })

    expect(second).toBe(first)
    expect(release).toHaveBeenCalledTimes(0)
    await Promise.resolve()
    expect(release).toHaveBeenCalledTimes(1)
    resolve()
    await Promise.all([first, second])
    expect(coordinator.has('resources')).toBe(false)
  })
})

describe('admin pane controller', () => {
  const deferred = () => {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((done, fail) => {
      resolve = done
      reject = fail
    })
    return { promise, resolve, reject }
  }
  const setup = (overrides: Partial<Parameters<typeof createAdminPaneController>[0]> = {}) => {
    const store = createAdminPaneStore()
    const pane = { hidden: true } as HTMLElement
    const settings = {
      open: vi.fn(() => {
        pane.hidden = false
      }),
      pane: () => pane,
    }
    const resources = {
      reload: vi.fn(async () => {}),
      sync: vi.fn(async () => {}),
      ready: Promise.resolve(),
    }
    const mountResources = vi.fn(async () => resources)
    const mountPlugin = vi.fn(async () => ({ reload: vi.fn(async () => {}) }))
    const controller = createAdminPaneController({
      store,
      settings,
      mountPlugin,
      mountResources,
      workspaceId: () => undefined,
      errorText: (error) => `failed: ${(error as Error).message}`,
      ...overrides,
    })
    return { controller, store, settings, pane, resources, mountResources, mountPlugin }
  }

  it('shows the requested tab as loading, then reveals the list once it is ready', async () => {
    const { controller, store, settings, mountResources } = setup()
    const opening = controller.open('resources', 'mcp')
    expect(store.snapshot().resources).toMatchObject({ loading: true, ready: false, tab: 'mcp' })
    expect(settings.open).toHaveBeenCalledWith('resources')
    await opening
    expect(mountResources).toHaveBeenCalledWith({ tab: 'mcp' })
    expect(store.snapshot().resources).toMatchObject({ loading: false, ready: true, tab: 'mcp' })
  })

  it('mounts once and syncs the mounted pane to the workspace on later opens', async () => {
    const { controller, resources, mountResources } = setup({ workspaceId: () => 'a'.repeat(64) })
    await controller.open('resources', 'skills')
    await controller.open('resources', 'mcp')
    expect(mountResources).toHaveBeenCalledTimes(1)
    expect(resources.sync).toHaveBeenCalledWith(
      { tab: 'mcp', workspaceId: 'a'.repeat(64) },
      { refresh: true },
    )
  })

  it('lets a later tab choice supersede a load in flight', async () => {
    const gate = deferred()
    const resources = { reload: async () => {}, sync: vi.fn(async () => {}), ready: gate.promise }
    const { controller, store } = setup({ mountResources: async () => resources })
    const first = controller.open('resources', 'skills')
    await Promise.resolve()
    const second = controller.open('resources', 'mcp')
    expect(store.snapshot().resources).toMatchObject({ loading: true, tab: 'mcp' })
    gate.resolve()
    await Promise.all([first, second])
    // The superseded request never settles the store; the newest one syncs and reveals its tab.
    expect(resources.sync).toHaveBeenCalledWith({ tab: 'mcp' }, { refresh: true })
    expect(store.snapshot().resources).toMatchObject({ loading: false, ready: true, tab: 'mcp' })
  })

  it('reports a failed open on the pane and keeps the list out of view', async () => {
    const { controller, store } = setup({
      mountResources: async () => {
        throw new Error('daemon unreachable')
      },
    })
    await controller.open('resources', 'skills')
    expect(store.snapshot().resources).toMatchObject({
      loading: false,
      ready: false,
      notice: { text: 'failed: daemon unreachable', kind: 'error' },
    })
  })

  it('clears the previous failure when the pane is opened again', async () => {
    let fail = true
    const { controller, store } = setup({
      mountPlugin: async () => {
        if (fail) throw new Error('first')
        return { reload: async () => {} }
      },
    })
    await controller.open('plugin')
    expect(store.snapshot().plugin.notice.kind).toBe('error')
    fail = false
    const reopening = controller.open('plugin')
    expect(store.snapshot().plugin.loading).toBe(true)
    await reopening
    expect(store.snapshot().plugin).toMatchObject({ loading: false, notice: { text: '', kind: '' } })
  })

  it('does not navigate back to a pane the user has left while it was loading', async () => {
    const gate = deferred()
    const { controller, settings, pane } = setup({
      mountPlugin: async () => {
        await gate.promise
        return { reload: async () => {} }
      },
    })
    const opening = controller.open('plugin')
    pane.hidden = true
    gate.resolve()
    await opening
    expect(settings.open).toHaveBeenCalledTimes(1)
  })
})
