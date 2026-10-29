import type { WorkspaceEntry } from '@agnes/protocol'
import { Button, Dialog, EmptyState, Icon, SettingsInput } from '@agnes/web-ui'
import { type ReactNode, useCallback, useRef } from 'react'
import type { Translate } from './locales/index.js'

export interface WorkspaceDialogState {
  open: boolean
  path: string
  error: string
  /** Filters the recent workspaces by name or path. */
  query: string
  workspaces: readonly WorkspaceEntry[]
  /** The path of the draft's workspace, marked in the list. */
  current: string | undefined
  connected: boolean
  pending: boolean
  creating: boolean
  pickerBusy: boolean
  pickerReady: boolean | undefined
}
/** Recent workspaces switch on one click; a new folder comes from the system picker or a typed path. */
export function WorkspaceDialog({
  view,
  t,
  options,
  onClose,
  onSubmit,
  onPick,
  onPathChange,
  onQueryChange,
}: {
  view: WorkspaceDialogState
  t: Translate
  options: ReactNode
  onClose(): void
  onSubmit(): void
  onPick(): void
  onPathChange(path: string): void
  onQueryChange(query: string): void
}) {
  const input = useRef<HTMLInputElement>(null)
  const picker = useRef<HTMLButtonElement>(null)
  const blocked = !view.connected || view.pending || view.creating || view.pickerBusy
  const empty = view.workspaces.length === 0
  const remote = view.pickerReady === false
  const focus = useCallback(() => {
    if (view.pickerReady) picker.current?.focus()
    else input.current?.focus()
  }, [view.pickerReady])
  const pick = (primary: boolean) => (
    <Button
      id="workspace-pick"
      ref={picker}
      appearance={primary ? 'primary' : 'secondary'}
      disabled={blocked || !view.pickerReady}
      aria-busy={view.pending || view.creating || view.pickerBusy || view.pickerReady === undefined}
      onClick={onPick}
    >
      <Icon name={primary ? 'folder' : 'folder-plus'} />
      <span>{t(view.pickerBusy ? 'app.newSession.opening' : 'app.newSession.pickFolder')}</span>
    </Button>
  )
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
        footer={null}
        closable={{ disabled: view.creating || view.pickerBusy }}
        onCancel={() => {
          if (!view.creating && !view.pickerBusy) onClose()
        }}
        afterOpenChange={(open) => {
          if (open) focus()
        }}
        title={<h2 id="new-session-title">{t('index-shell.pickWorkspaceTitle')}</h2>}
      >
        <form
          id="new-session-form"
          onSubmit={(event) => {
            event.preventDefault()
            onSubmit()
          }}
        >
          <p className="dialog-intro">{t('index-shell.pickWorkspaceIntro')}</p>
          {remote && (
            <p id="workspace-picker-state" className="workspace-picker-note" aria-live="polite">
              <Icon name="monitor" />
              <span>{t('app.newSession.noPicker')}</span>
            </p>
          )}
          {empty ? (
            <EmptyState
              className="workspace-empty"
              icon={<Icon name="folder" size={20} />}
              title={t('index-shell.emptyTitle')}
              description={t('index-shell.emptyBody')}
              actions={remote ? undefined : pick(true)}
            />
          ) : (
            <>
              <SettingsInput
                id="workspace-search"
                type="search"
                value={view.query}
                autoComplete="off"
                spellCheck={false}
                placeholder={t('index-shell.searchWorkspaces')}
                aria-label={t('index-shell.searchWorkspaces')}
                onInput={(event) => onQueryChange(event.currentTarget.value)}
              />
              <fieldset id="workspace-options" className="workspace-options">
                <legend className="visually-hidden">{t('index-shell.recentLegend')}</legend>
                <div id="workspace-option-items" className="workspace-option-items">
                  {options}
                </div>
              </fieldset>
            </>
          )}
          <div id="workspace-manual" className="workspace-new">
            {!empty && <p className="workspace-new-heading">{t('index-shell.newFolder')}</p>}
            <div className="workspace-new-row">
              {!empty && !remote && pick(false)}
              {!remote && <span className="workspace-new-or">{t('index-shell.or')}</span>}
              <span className="workspace-path" data-invalid={view.error ? 'true' : undefined}>
                <SettingsInput
                  id="new-session-cwd"
                  ref={input}
                  value={view.path}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t('index-shell.cwdPlaceholder')}
                  aria-label={t('index-shell.cwdLabel')}
                  aria-invalid={view.error ? true : undefined}
                  aria-describedby="new-session-error"
                  disabled={view.pickerBusy}
                  onInput={(event) => onPathChange(event.currentTarget.value)}
                />
                <Button
                  id="new-session-create"
                  appearance={view.path.trim() ? 'primary' : 'secondary'}
                  size="small"
                  htmlType="submit"
                  disabled={blocked || !view.path.trim()}
                  aria-busy={view.pending || view.creating || view.pickerBusy}
                >
                  {t(view.creating ? 'app.newSession.verifying' : 'app.newSession.useWorkspace')}
                </Button>
              </span>
            </div>
            <p id="new-session-error" role="alert">
              {view.error}
            </p>
            {!remote && (
              <p id="workspace-picker-state" className="field-hint" aria-live="polite">
                {t(
                  view.pickerBusy
                    ? 'app.newSession.pickSystemHint'
                    : view.pickerReady === undefined
                      ? 'app.newSession.checkingPicker'
                      : empty
                        ? 'app.newSession.pickMachine'
                        : 'app.newSession.pickMachineList',
                )}
              </p>
            )}
          </div>
        </form>
      </Dialog>
    </dialog>
  )
}
