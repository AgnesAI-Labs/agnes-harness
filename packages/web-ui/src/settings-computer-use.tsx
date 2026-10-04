import { Button } from './ui/button.js'

export type SettingsComputerUseView = Readonly<{
  status: Readonly<{ label: string; summary: string; runtime: string; blockers: readonly string[] }>
  permissions: Readonly<{ label: string; summary: string; grantHidden: boolean }>
  doctor: Readonly<{ label: string; summary: string }>
  operation: Readonly<{ label: string; summary: string }>
  controls: Readonly<{
    refreshDisabled: boolean
    grantDisabled: boolean
    doctorDisabled: boolean
    installDisabled: boolean
    updateDisabled: boolean
    restartDisabled: boolean
    operationRefreshDisabled: boolean
    cancelDisabled: boolean
    cancelHidden: boolean
  }>
}>

export type SettingsComputerUseActions = Readonly<{
  refresh(): Promise<void>
  grantPermissions(): Promise<void>
  doctor(): Promise<void>
  install(): Promise<void>
  update(): Promise<void>
  restart(): Promise<void>
  refreshOperation(): Promise<void>
  cancelOperation(): Promise<void>
}>

export function SettingsComputerUse({
  view,
  actions,
  text,
}: {
  view: SettingsComputerUseView
  actions: SettingsComputerUseActions
  /** Render-time copy. Defaults to the English catalog so a missing host still stays in the default language. */
  text?: (key: string) => string
}) {
  const label = (key: string, fallback: string) => text?.(key) ?? fallback
  return (
    <section
      id="computer-use-settings-pane"
      className="settings-content"
      data-agnes-region="settings-pane"
      hidden
    >
      <header className="config-heading">
        <div>
          <h2>Computer Use</h2>
          <p>
            {label(
              'computerUse.intro',
              'Let Agnes see the screen and operate apps. This needs a model that accepts images.',
            )}
          </p>
        </div>
        <Button
          id="computer-use-refresh"
          className="secondary-button compact"
          htmlType="button"
          disabled={view.controls.refreshDisabled}
          onClick={() => void actions.refresh()}
        >
          {label('computerUse.action.refresh', 'Refresh status')}
        </Button>
      </header>
      <div className="config-workspace">
        <section className="config-card" aria-labelledby="computer-use-state">
          <p className="eyebrow">{label('computerUse.status.eyebrow', 'Status')}</p>
          <strong id="computer-use-state" role="status">
            {view.status.label}
          </strong>
          <p id="computer-use-summary">{view.status.summary}</p>
          <p id="computer-use-runtime">{view.status.runtime}</p>
          <ul id="computer-use-blockers">
            {view.status.blockers.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </section>
        <section className="config-card" aria-labelledby="computer-use-permission-state">
          <p className="eyebrow">{label('computerUse.permissions.eyebrow', 'System permissions')}</p>
          <strong id="computer-use-permission-state">{view.permissions.label}</strong>
          <p id="computer-use-permission-summary">{view.permissions.summary}</p>
          <Button
            id="computer-use-permission-grant"
            className="primary-button compact"
            htmlType="button"
            hidden={view.permissions.grantHidden}
            disabled={view.controls.grantDisabled}
            onClick={() => void actions.grantPermissions()}
          >
            {label('computerUse.permissions.grant', 'Open macOS authorization')}
          </Button>
        </section>
        <section className="config-card" aria-labelledby="computer-use-doctor-state">
          <p className="eyebrow">{label('computerUse.doctor.eyebrow', 'Driver diagnostics')}</p>
          <strong id="computer-use-doctor-state">{view.doctor.label}</strong>
          <p id="computer-use-doctor-summary">{view.doctor.summary}</p>
          <Button
            id="computer-use-doctor-run"
            className="secondary-button compact"
            htmlType="button"
            disabled={view.controls.doctorDisabled}
            onClick={() => void actions.doctor()}
          >
            {label('computerUse.doctor.run', 'Run diagnostics')}
          </Button>
        </section>
        <section className="config-card" aria-labelledby="computer-use-operation-state">
          <p className="eyebrow">{label('computerUse.operation.eyebrow', 'Install and maintenance')}</p>
          <strong id="computer-use-operation-state">{view.operation.label}</strong>
          <p id="computer-use-operation-summary">{view.operation.summary}</p>
          <div className="config-actions">
            <Button
              id="computer-use-install"
              className="secondary-button compact"
              htmlType="button"
              disabled={view.controls.installDisabled}
              onClick={() => void actions.install()}
            >
              {label('computerUse.action.install', 'Prepare driver')}
            </Button>
            <Button
              id="computer-use-update"
              className="secondary-button compact"
              htmlType="button"
              disabled={view.controls.updateDisabled}
              onClick={() => void actions.update()}
            >
              {label('computerUse.action.update', 'Update driver')}
            </Button>
            <Button
              id="computer-use-restart"
              className="secondary-button compact"
              htmlType="button"
              disabled={view.controls.restartDisabled}
              onClick={() => void actions.restart()}
            >
              {label('computerUse.action.restart', 'Restart driver')}
            </Button>
            <Button
              id="computer-use-operation-refresh"
              className="secondary-button compact"
              htmlType="button"
              disabled={view.controls.operationRefreshDisabled}
              onClick={() => void actions.refreshOperation()}
            >
              {label('computerUse.action.operationRefresh', 'Refresh progress')}
            </Button>
            <Button
              id="computer-use-operation-cancel"
              className="secondary-button compact"
              htmlType="button"
              hidden={view.controls.cancelHidden}
              disabled={view.controls.cancelDisabled}
              onClick={() => void actions.cancelOperation()}
            >
              {label('computerUse.action.cancel', 'Cancel operation')}
            </Button>
          </div>
        </section>
      </div>
    </section>
  )
}
