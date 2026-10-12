import type { WorkspaceEntry } from '@agnes/protocol'
import type { Translate } from '@agnes/web-conversation/presentation'
import { mountRegion } from '@agnes/web-ui'
import { WorkspaceDialog, type WorkspaceDialogState } from '@agnes/web-units'
import { useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { FolderIcon, WorkspaceOptions } from './navigation.js'

interface WorkspaceDialogActions {
  translate: Translate
  submit(): void
  pick(): void
  select(workspace: WorkspaceEntry): void
  restoreFocus(): void
}

/** A subscription bridge; the app controller still owns workspace registration and picker requests. */
export function mountNewSessionDialog(host: HTMLElement, actions: WorkspaceDialogActions) {
  let state: WorkspaceDialogState = {
    open: false,
    path: '',
    error: '',
    manual: false,
    workspaces: [],
    connected: false,
    pending: false,
    creating: false,
    pickerBusy: false,
    pickerReady: undefined,
  }
  const listeners = new Set<() => void>()
  const snapshot = () => state
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  const update = (next: Partial<WorkspaceDialogState>) => {
    state = { ...state, ...next }
    flushSync(() => {
      for (const listener of listeners) listener()
    })
  }
  const close = () => {
    if (!state.open) return
    update({ open: false })
    actions.restoreFocus()
  }
  function WorkspaceDialogBridge() {
    const view = useSyncExternalStore(subscribe, snapshot, snapshot)
    return (
      <WorkspaceDialog
        view={view}
        t={actions.translate}
        options={<WorkspaceOptions workspaces={view.workspaces} select={actions.select} />}
        folderIcon={<FolderIcon region />}
        onClose={close}
        onSubmit={actions.submit}
        onPick={actions.pick}
        onPathChange={(path) => update({ path })}
        onManualChange={(manual) => update({ manual })}
      />
    )
  }
  const disposeRoot = mountRegion(host, <WorkspaceDialogBridge />)
  const localeChanged = () => update({})
  window.addEventListener('agnes:locale-changed', localeChanged)
  return {
    get open() {
      return state.open
    },
    get path() {
      return state.path
    },
    update,
    show() {
      update({ open: true, manual: state.manual || state.pickerReady === false })
    },
    close,
    dispose() {
      window.removeEventListener('agnes:locale-changed', localeChanged)
      disposeRoot()
    },
  }
}
