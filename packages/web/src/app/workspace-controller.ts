import type { WorkspaceEntry } from '@agnes/protocol'
import { workspaceErrorNotice } from '@agnes/web-conversation/presentation'
import { preserveRouteParams } from '@agnes/web-ui'
import type { AppSessionContext } from '../app.js'
import { requestNewSession } from '../application.js'
import { archivedSessions } from '../archived-sessions.js'
import { mountNewSessionDialog } from '../new-session-dialog.js'
import { requestWorkspacePicker, workspacePickerAvailable } from '../workspace-picker.js'

/**
 * The draft's workspace and the picker that changes it. The address carries the draft's
 * `workspaceId`, so a refresh (which keeps `?new=1`) restores the same workspace instead of
 * asking again; the picker opens on its own only when no workspace is available at all.
 */
export function createWorkspaceController(
  context: Pick<
    AppSessionContext,
    | 'client'
    | 'clientModules'
    | 'composerRuntime'
    | 'connected'
    | 'list'
    | 'renderControls'
    | 'run'
    | 'selectedWorkspace'
    | 'sessionPending'
    | 't'
    | 'updateSidebar'
    | 'workspaceRows'
  >,
  host: HTMLElement,
) {
  let creating = false
  let pickerReady: boolean | undefined
  let pickerBusy = false
  const dialog = mountNewSessionDialog(host, {
    translate: (key, vars) => context.t(key, vars),
    submit: () => context.run(() => register(dialog.path.trim())),
    pick: () => context.run(pick),
    select: (workspace) => {
      remember(workspace)
      requestNewSession()
      dialog.close()
      context.renderControls()
      context.composerRuntime.focus()
    },
    remove: (workspace) => context.run(() => remove(workspace)),
    restoreFocus: () => context.clientModules.sidebar?.focusNew(),
  })

  /** Select the draft's workspace and name it in the address. */
  function remember(workspace: WorkspaceEntry | undefined): void {
    context.selectedWorkspace = workspace
    dialog.update({ current: workspace?.path })
    const url = new URL(location.href)
    // No workspace at all (e.g. the list failed to load) keeps the address's choice for the next refresh.
    if (workspace?.workspaceId) url.searchParams.set('workspaceId', workspace.workspaceId)
    else if (workspace) url.searchParams.delete('workspaceId')
    history.replaceState(history.state, '', preserveRouteParams(url))
  }

  /** An explicit choice, else the one already selected, else the most recently used available one. */
  function resolveDraft(workspace?: WorkspaceEntry): void {
    const selected = context.selectedWorkspace
    remember(
      workspace ??
        (selected?.available ? selected : (context.workspaceRows.find((row) => row.available) ?? selected)),
    )
  }

  function renderControls(): void {
    dialog.update({
      connected: context.connected,
      pending: context.sessionPending,
      creating,
      pickerBusy,
      pickerReady,
    })
  }

  function open(transitioning = false): void {
    if (!context.connected || (context.sessionPending && !transitioning) || creating) return
    dialog.update({ current: context.selectedWorkspace?.path })
    dialog.show()
  }

  function apply(page: { items: WorkspaceEntry[] }): void {
    context.workspaceRows = page.items
    const selected = context.selectedWorkspace
    if (selected) context.selectedWorkspace = page.items.find((row) => row.path === selected.path)
    dialog.update({ workspaces: page.items, current: context.selectedWorkspace?.path })
    context.updateSidebar()
  }

  async function register(cwd: string): Promise<void> {
    if (!context.connected || context.sessionPending || creating || !cwd) return
    creating = true
    context.renderControls()
    try {
      const { workspace } = await context.client.workspace.add(cwd)
      context.workspaceRows = [
        workspace,
        ...context.workspaceRows.filter((row) => row.path !== workspace.path),
      ]
      remember(workspace)
      dialog.update({ workspaces: context.workspaceRows, path: '' })
      await context.list()
      requestNewSession()
      dialog.close()
      context.composerRuntime.focus()
    } catch (error) {
      const failure = new Error(workspaceErrorNotice(error, context.t), { cause: error })
      dialog.update({ error: failure.message })
      throw failure
    } finally {
      creating = false
      context.renderControls()
    }
  }

  async function pick(): Promise<void> {
    if (!pickerReady || pickerBusy || creating) return
    pickerBusy = true
    renderControls()
    try {
      const result = await requestWorkspacePicker().catch(() => undefined)
      if (!result || result.status === 'unavailable') {
        pickerReady = false
        if (!result) dialog.update({ error: context.t('app.newSession.pickerFailed') })
        return
      }
      if (result.status === 'cancelled') return
      dialog.update({ path: result.path })
      await register(result.path)
    } finally {
      pickerBusy = false
      renderControls()
    }
  }

  /** `workspace.remove` archives the folder's sessions; the folder itself is never touched. */
  async function remove(workspace: WorkspaceEntry): Promise<void> {
    if (!workspace.workspaceId) throw new Error(context.t('workspace.remove.unavailable'))
    await context.client.call('_agnes/v1/workspace.remove', {
      workspaceId: workspace.workspaceId,
      ...(workspace.revision !== undefined ? { expectedRevision: workspace.revision } : {}),
    })
    apply(await context.client.workspace.list())
    await context.list()
    if (archivedSessions.getSnapshot().filter === 'archived') await archivedSessions.reload()
  }

  async function refreshPicker(): Promise<void> {
    pickerReady = await workspacePickerAvailable()
    renderControls()
  }

  return {
    dialog,
    get creating() {
      return creating
    },
    resolveDraft,
    renderControls,
    open,
    apply,
    register,
    remove,
    refreshPicker,
  }
}
