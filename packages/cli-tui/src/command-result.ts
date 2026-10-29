import type { BusyInput } from './busy-input.js'
import type { SlashResult } from './commands.js'
import type { Component } from './component.js'
import type { Editor } from './editor.js'
import type { ModelPicker } from './views/model-picker.js'
import type { ProviderSetup } from './views/provider-setup.js'
import type { SessionPicker } from './views/session-picker.js'
import type { StatusBar } from './views/status-bar.js'
import type { UsagePanel } from './views/usage-panel.js'

export interface CommandResultHost {
  statusBar: StatusBar
  usagePanel: UsagePanel
  modelPicker: ModelPicker
  sessionPicker: SessionPicker
  providerSetup: ProviderSetup
  editor: Editor
  busyInput: BusyInput
  /** Anchors a connection-local view beside the projected nodes of the current session. */
  appendLocal: (view: Component) => void
  localCommandView: (command: string, output: string, quiet?: boolean) => Component
}

/** Shows what a slash command answered: its notice, transcript view or panel, draft and pickers. */
export function applyCommandResult(host: CommandResultHost, text: string, r: SlashResult): void {
  const { statusBar } = host
  if (r.details && r.text !== undefined) {
    statusBar.setNotice(undefined)
    host.usagePanel.show(r.text, r.title)
  } else if (r.text !== undefined) {
    // Explicit transcript output, and every multiline fallback, stays connection-local: Timeline
    // anchors it beside projected nodes but never manufactures a UINode or writes the ledger.
    if (r.presentation === 'transcript' || r.text.includes('\n')) {
      statusBar.setNotice(undefined)
      host.appendLocal(host.localCommandView(text, r.text))
    } else statusBar.setNotice(r.text)
  }
  if (r.draft !== undefined) host.editor.setText(r.draft)
  if (r.keep) host.busyInput.keep(r.keep)
  if (r.modelChoices) {
    statusBar.setNotice(undefined)
    host.modelPicker.show(r.modelChoices)
  }
  if (r.sessionChoices) {
    statusBar.setNotice(undefined)
    host.sessionPicker.show(r.sessionChoices, r.sessionPickerTitle, r.sessionScope)
  }
  if (r.providerSetup) {
    statusBar.setNotice(undefined)
    host.providerSetup.show(r.providerSetup)
  }
}
