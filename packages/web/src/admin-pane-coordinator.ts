export type PendingCoordinator<K> = Readonly<{
  run(key: K, operation: () => void | Promise<void>): Promise<void>
  has(key: K): boolean
}>

export function createPendingCoordinator<K>(): PendingCoordinator<K> {
  const pending = new Map<K, Promise<void>>()

  return {
    run(key, operation): Promise<void> {
      const existing = pending.get(key)
      if (existing) return existing

      let current!: Promise<void>
      current = Promise.resolve()
        .then(operation)
        .finally(() => {
          if (pending.get(key) === current) pending.delete(key)
        })
      pending.set(key, current)
      return current
    },
    has: (key) => pending.has(key),
  }
}

export type AdminPaneName = 'plugin' | 'resources'
export type AdminResourceTab = 'skills' | 'mcp'
export type AdminResourceScope = { tab: AdminResourceTab; workspaceId?: string }
export type MountedAdminPane = Readonly<{
  reload(): Promise<void>
  ready?: Promise<void>
  sync?(scope: AdminResourceScope, options?: { refresh?: boolean }): Promise<void>
}>

/** The slice of the admin pane store the controller writes; React reads the other half. */
type AdminPaneWrites = Readonly<{
  begin(pane: AdminPaneName, tab?: AdminResourceTab): void
  clearNotice(pane: AdminPaneName): void
  fail(pane: AdminPaneName, message: string): void
  settle(pane: AdminPaneName, ready: boolean): void
}>

export type AdminPaneControllerOptions = Readonly<{
  store: AdminPaneWrites
  settings: { open(pane: AdminPaneName): void; pane(pane: AdminPaneName): HTMLElement | null }
  mountPlugin(): Promise<MountedAdminPane>
  mountResources(scope: AdminResourceScope): Promise<MountedAdminPane>
  /** The workbench's current workspace, when the resource pane should be scoped to it. */
  workspaceId(): string | undefined
  errorText(error: unknown): string
}>

/** Opens the embedded admin panes: mounts on first open, reloads afterwards, newest request wins. */
export function createAdminPaneController(options: AdminPaneControllerOptions) {
  const { store, settings } = options
  const mounted = new Map<AdminPaneName, MountedAdminPane>()
  const pending = createPendingCoordinator<AdminPaneName>()
  let resourceRequest = 0
  const scopeFor = (tab: AdminResourceTab): AdminResourceScope => {
    const workspaceId = options.workspaceId()
    return workspaceId ? { tab, workspaceId } : { tab }
  }

  return {
    async open(pane: AdminPaneName, tab: AdminResourceTab = 'skills'): Promise<void> {
      const request = pane === 'resources' ? ++resourceRequest : undefined
      const isCurrent = () => pane !== 'resources' || request === resourceRequest
      let ready = false
      store.begin(pane, tab)
      settings.open(pane)
      try {
        if (pane === 'resources' && pending.has(pane)) {
          // Join the existing mount before applying the latest tab; never mount the same pane twice.
          await pending.run(pane, () => {}).catch(() => undefined)
          if (!isCurrent() || settings.pane(pane)?.hidden !== false) return
        }
        await pending.run(pane, async () => {
          if (!isCurrent()) return
          store.clearNotice(pane)
          const existing = mounted.get(pane)
          if (existing) {
            if (pane === 'resources' && existing.sync) {
              await existing.sync(scopeFor(tab), { refresh: true })
              ready = true
            } else await existing.reload()
            return
          }
          if (pane === 'plugin') {
            mounted.set(pane, await options.mountPlugin())
            return
          }
          const resources = await options.mountResources(scopeFor(tab))
          mounted.set(pane, resources)
          await resources.ready
          ready = true
        })
      } catch (error) {
        if (isCurrent()) store.fail(pane, options.errorText(error))
      } finally {
        if (isCurrent()) {
          store.settle(pane, ready)
          // Loading an old pane must not navigate back after the user has selected another category.
          if (settings.pane(pane)?.hidden === false) settings.open(pane)
        }
      }
    },
  }
}
