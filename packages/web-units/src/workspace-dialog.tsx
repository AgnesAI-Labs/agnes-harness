import type { WorkspaceEntry } from '@agnes/protocol'
import { Button, Dialog, SettingsInput } from '@agnes/web-ui'
import { type ReactNode, useCallback, useRef } from 'react'
import type { Translate } from './locales/index.js'

export interface WorkspaceDialogState {
  open: boolean
  path: string
  error: string
  manual: boolean
  workspaces: readonly WorkspaceEntry[]
  connected: boolean
  pending: boolean
  creating: boolean
  pickerBusy: boolean
  pickerReady: boolean | undefined
}
export function WorkspaceDialog({
  view,
  t,
  options,
  folderIcon,
  onClose,
  onSubmit,
  onPick,
  onPathChange,
  onManualChange,
}: {
  view: WorkspaceDialogState
  t: Translate
  options: ReactNode
  folderIcon: ReactNode
  onClose(): void
  onSubmit(): void
  onPick(): void
  onPathChange(path: string): void
  onManualChange(open: boolean): void
}) {
  const input = useRef<HTMLInputElement>(null)
  const picker = useRef<HTMLButtonElement>(null)
  const blocked = !view.connected || view.pending || view.creating || view.pickerBusy
  const focus = useCallback(() => {
    if (view.pickerReady) picker.current?.focus()
    else input.current?.focus()
  }, [view.pickerReady])
  return (
    <dialog
      id="new-session"
      className="react-dialog-host"
      role="presentation"
      data-agnes-region="dialog"
      hidden={!view.open}
      open={view.open}
    >
      <Dialog
        open={view.open}
        focusable={{ focusTriggerAfterClose: false }}
        forceRender
        footer={null}
        closable={{ disabled: view.creating || view.pickerBusy }}
        onCancel={() => {
          if (!view.creating && !view.pickerBusy) onClose()
        }}
        afterOpenChange={(open) => {
          if (open) focus()
        }}
        title={
          <div>
            <p className="dialog-kicker">{t('index-shell.newSessionKicker')}</p>
            <h2 id="new-session-title">{t('index-shell.pickWorkspaceTitle')}</h2>
          </div>
        }
      >
        <form
          id="new-session-form"
          onSubmit={(event) => {
            event.preventDefault()
            onSubmit()
          }}
        >
          <p className="dialog-intro">{t('index-shell.pickWorkspaceIntro')}</p>
          <fieldset id="workspace-options" className="workspace-options">
            <legend className="visually-hidden">{t('index-shell.recentLegend')}</legend>
            <div id="workspace-option-items" className="workspace-option-items">
              {options}
            </div>
          </fieldset>
          <div className="workspace-picker-action">
            <Button
              id="workspace-pick"
              ref={picker}
              appearance="primary"
              disabled={blocked || !view.pickerReady}
              hidden={view.pickerReady === false}
              aria-busy={view.pending || view.creating || view.pickerBusy || view.pickerReady === undefined}
              onClick={onPick}
            >
              {folderIcon}
              <span>{t(view.pickerBusy ? 'app.newSession.opening' : 'app.newSession.pickFolder')}</span>
            </Button>
            <p id="workspace-picker-state" className="field-hint" aria-live="polite">
              {t(
                view.pickerBusy
                  ? 'app.newSession.pickSystemHint'
                  : view.pickerReady === undefined
                    ? 'app.newSession.checkingPicker'
                    : view.pickerReady
                      ? 'app.newSession.pickMachine'
                      : 'app.newSession.noPicker',
              )}
            </p>
          </div>
          <details
            id="workspace-manual"
            className="workspace-manual"
            open={view.manual || view.pickerReady === false}
            onToggle={(event) => {
              const manual = event.currentTarget.open
              if (view.manual !== manual) onManualChange(manual)
            }}
          >
            <summary data-testid="workspace-manual-toggle">{t('index-shell.manualPath')}</summary>
            <label className="form-field" htmlFor="new-session-cwd">
              <span>{t('index-shell.cwdLabel')}</span>
              <SettingsInput
                id="new-session-cwd"
                ref={input}
                value={view.path}
                autoComplete="off"
                spellCheck={false}
                placeholder={t('index-shell.cwdPlaceholder')}
                aria-describedby="cwd-hint"
                disabled={view.pickerBusy}
                onInput={(event) => onPathChange(event.currentTarget.value)}
              />
            </label>
            <p id="cwd-hint" className="field-hint">
              {t('index-shell.cwdHint')}
            </p>
          </details>
          <p id="new-session-error" role="alert">
            {view.error}
          </p>
          <div className="dialog-actions">
            <Button id="new-session-cancel" disabled={view.creating || view.pickerBusy} onClick={onClose}>
              {t('index-shell.cancel')}
            </Button>
            <Button
              id="new-session-create"
              appearance="primary"
              htmlType="submit"
              disabled={blocked || !view.path.trim()}
              aria-busy={view.pending || view.creating || view.pickerBusy}
            >
              {t(view.creating ? 'app.newSession.verifying' : 'app.newSession.useWorkspace')}
            </Button>
          </div>
        </form>
      </Dialog>
    </dialog>
  )
}
