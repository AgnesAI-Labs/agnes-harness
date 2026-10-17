import type { WorkspaceEntry } from '@agnes/protocol'
import type { Translate } from '@agnes/web-conversation/presentation'
import { createExternalStore, mountRegion, useStoreSelector } from '@agnes/web-ui'
import { WorkspaceDialog, type WorkspaceDialogState } from '@agnes/web-units/shell'
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
  const initialState: WorkspaceDialogState = {
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
  const store = createExternalStore(initialState)
  const { getSnapshot: snapshot } = store
  const update = (next: Partial<WorkspaceDialogState>) => {
    flushSync(() => store.set({ ...snapshot(), ...next }))
  }
  const close = () => {
    if (!snapshot().open) return
    update({ open: false })
    actions.restoreFocus()
  }
  function WorkspaceDialogBridge() {
    const view = useStoreSelector(store, (value) => value)
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
      return snapshot().open
    },
    get path() {
      return snapshot().path
    },
    update,
    show() {
      update({ open: true, manual: snapshot().manual || snapshot().pickerReady === false })
    },
    close,
    dispose() {
      window.removeEventListener('agnes:locale-changed', localeChanged)
      disposeRoot()
    },
  }
}
