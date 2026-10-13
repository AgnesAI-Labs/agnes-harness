export type AdminPaneName = 'plugin' | 'resources'
export type AdminResourceTab = 'skills' | 'mcp'

/** A fresh object per write: the notice element is shared with the pane's own controller. */
export type AdminPaneNotice = Readonly<{ text: string; kind: '' | 'error' }>

export type AdminPaneSnapshot = Readonly<{
  plugin: Readonly<{ loading: boolean; notice: AdminPaneNotice }>
  resources: Readonly<{
    loading: boolean
    /** The list and its toolbar stay out of view until the current tab has loaded. */
    ready: boolean
    tab: AdminResourceTab
    notice: AdminPaneNotice
  }>
}>

export type AdminPaneStore = Readonly<{
  snapshot(): AdminPaneSnapshot
  subscribe(listener: () => void): () => void
  /** A pane starts loading; the resources pane also records which tab was asked for. */
  begin(pane: AdminPaneName, tab?: AdminResourceTab): void
  clearNotice(pane: AdminPaneName): void
  fail(pane: AdminPaneName, message: string): void
  settle(pane: AdminPaneName, ready: boolean): void
}>

const NO_NOTICE: AdminPaneNotice = Object.freeze({ text: '', kind: '' })

/**
 * Load state of the embedded plugin and Skill / MCP panes. Commands stay with the controller.
 * `flush` lets the host commit each write synchronously: the settings shell reads the tab state
 * back from the navigation right after a pane starts loading.
 */
export function createAdminPaneStore(
  flush: (write: () => void) => void = (write) => write(),
): AdminPaneStore {
  let snapshot: AdminPaneSnapshot = {
    plugin: { loading: false, notice: NO_NOTICE },
    resources: { loading: false, ready: true, tab: 'skills', notice: NO_NOTICE },
  }
  const listeners = new Set<() => void>()
  const commit = (next: AdminPaneSnapshot) => {
    snapshot = next
    flush(() => {
      for (const listener of [...listeners]) listener()
    })
  }
  const patch = (pane: AdminPaneName, change: Partial<AdminPaneSnapshot['resources']>) =>
    commit({ ...snapshot, [pane]: { ...snapshot[pane], ...change } })
  return {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    begin(pane, tab) {
      if (pane === 'plugin') patch(pane, { loading: true })
      else patch(pane, { loading: true, ready: false, tab: tab ?? snapshot.resources.tab })
    },
    clearNotice: (pane) => patch(pane, { notice: { text: '', kind: '' } }),
    fail: (pane, message) => patch(pane, { notice: { text: message, kind: 'error' } }),
    settle(pane, ready) {
      if (pane === 'plugin') patch(pane, { loading: false })
      else patch(pane, { loading: false, ready })
    },
  }
}

/** Busy and disabled state of one navigation control, by its element id. */
export function adminPaneControl(
  snapshot: AdminPaneSnapshot | undefined,
  id: string,
): Readonly<{ busy: boolean; disabled: boolean }> {
  if (!snapshot) return { busy: false, disabled: false }
  // Resource tabs stay enabled so a later choice can supersede a load in flight.
  if (id === 'plugin-management') return { busy: snapshot.plugin.loading, disabled: snapshot.plugin.loading }
  if (id === 'skills-tab' || id === 'mcp-tab')
    return { busy: snapshot.resources.loading && id === `${snapshot.resources.tab}-tab`, disabled: false }
  return { busy: false, disabled: false }
}
