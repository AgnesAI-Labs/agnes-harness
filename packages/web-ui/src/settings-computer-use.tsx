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
}: {
  view: SettingsComputerUseView
  actions: SettingsComputerUseActions
}) {
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
          <p>让 Agnes 查看屏幕并操作应用。需要使用支持图片的模型。</p>
        </div>
        <Button
          id="computer-use-refresh"
          className="secondary-button compact"
          htmlType="button"
          disabled={view.controls.refreshDisabled}
          onClick={() => void actions.refresh()}
        >
          刷新状态
        </Button>
      </header>
      <div className="config-workspace">
        <section className="config-card" aria-labelledby="computer-use-state">
          <p className="eyebrow">使用状态</p>
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
          <p className="eyebrow">系统权限</p>
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
            打开 macOS 授权
          </Button>
        </section>
        <section className="config-card" aria-labelledby="computer-use-doctor-state">
          <p className="eyebrow">驱动诊断</p>
          <strong id="computer-use-doctor-state">{view.doctor.label}</strong>
          <p id="computer-use-doctor-summary">{view.doctor.summary}</p>
          <Button
            id="computer-use-doctor-run"
            className="secondary-button compact"
            htmlType="button"
            disabled={view.controls.doctorDisabled}
            onClick={() => void actions.doctor()}
          >
            运行诊断
          </Button>
        </section>
        <section className="config-card" aria-labelledby="computer-use-operation-state">
          <p className="eyebrow">安装与维护</p>
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
              准备驱动
            </Button>
            <Button
              id="computer-use-update"
              className="secondary-button compact"
              htmlType="button"
              disabled={view.controls.updateDisabled}
              onClick={() => void actions.update()}
            >
              更新驱动
            </Button>
            <Button
              id="computer-use-restart"
              className="secondary-button compact"
              htmlType="button"
              disabled={view.controls.restartDisabled}
              onClick={() => void actions.restart()}
            >
              重启驱动
            </Button>
            <Button
              id="computer-use-operation-refresh"
              className="secondary-button compact"
              htmlType="button"
              disabled={view.controls.operationRefreshDisabled}
              onClick={() => void actions.refreshOperation()}
            >
              刷新进度
            </Button>
            <Button
              id="computer-use-operation-cancel"
              className="secondary-button compact"
              htmlType="button"
              hidden={view.controls.cancelHidden}
              disabled={view.controls.cancelDisabled}
              onClick={() => void actions.cancelOperation()}
            >
              取消操作
            </Button>
          </div>
        </section>
      </div>
    </section>
  )
}
