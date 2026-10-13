import { computerUseUiCatalog } from './locales/computer-use.js'
import { SettingsDetails, SettingsGroup, SettingsItem, SettingsPage } from './settings-layout.js'
import { Button } from './ui/button.js'
import { IconButton } from './ui/icon-button.js'
import { useUiText } from './ui-locale.js'

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
  const { t } = useUiText('@agnes/web-ui/computer-use', computerUseUiCatalog)
  const label = (key: string) => {
    const value = text?.(key)
    return value && value !== key ? value : t(key)
  }
  return (
    <SettingsPage
      title={label('computerUse.title')}
      description={label('computerUse.intro')}
      bodyClassName="config-workspace"
      actions={
        <IconButton
          name="refresh-cw"
          label={label('computerUse.action.refresh')}
          id="computer-use-refresh"
          htmlType="button"
          disabled={view.controls.refreshDisabled}
          onClick={() => void actions.refresh()}
        ></IconButton>
      }
      id="computer-use-settings-pane"
      className="settings-content"
      data-agnes-region="settings-pane"
      hidden
    >
      <SettingsGroup>
        <SettingsItem
          aria-labelledby="computer-use-state"
          label={
            <strong id="computer-use-state" role="status">
              {view.status.label}
            </strong>
          }
          description={
            <>
              <span id="computer-use-summary">{view.status.summary}</span>
              <span id="computer-use-runtime">{view.status.runtime}</span>
              <ul id="computer-use-blockers">
                {view.status.blockers.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            </>
          }
        >
          <Button
            id="computer-use-permission-grant"
            appearance="primary"
            htmlType="button"
            hidden={view.permissions.grantHidden}
            disabled={view.controls.grantDisabled}
            onClick={() => void actions.grantPermissions()}
          >
            {label('computerUse.permissions.grant')}
          </Button>
          <Button
            id="computer-use-install"
            appearance="primary"
            htmlType="button"
            hidden={
              !view.permissions.grantHidden || !view.controls.updateDisabled || view.controls.installDisabled
            }
            disabled={view.controls.installDisabled}
            onClick={() => void actions.install()}
          >
            {label('computerUse.action.install')}
          </Button>
        </SettingsItem>
      </SettingsGroup>
      <SettingsDetails title={label('computerUse.more')} data-testid="computer-use-more">
        <SettingsGroup>
          <SettingsItem
            role="group"
            aria-labelledby="computer-use-permission-title"
            labelId="computer-use-permission-title"
            label={label('computerUse.permissions.eyebrow')}
            description={
              <>
                <strong id="computer-use-permission-state">{view.permissions.label}</strong>
                <span id="computer-use-permission-summary">{view.permissions.summary}</span>
              </>
            }
          />
          <SettingsItem
            role="group"
            aria-labelledby="computer-use-doctor-title"
            labelId="computer-use-doctor-title"
            label={label('computerUse.doctor.eyebrow')}
            description={
              <>
                <strong id="computer-use-doctor-state">{view.doctor.label}</strong>
                <span id="computer-use-doctor-summary">{view.doctor.summary}</span>
              </>
            }
          >
            <Button
              id="computer-use-doctor-run"
              appearance="ghost"
              htmlType="button"
              disabled={view.controls.doctorDisabled}
              onClick={() => void actions.doctor()}
            >
              {label('computerUse.doctor.run')}
            </Button>
          </SettingsItem>
          <SettingsItem
            role="group"
            stacked
            aria-labelledby="computer-use-operation-title"
            labelId="computer-use-operation-title"
            label={label('computerUse.operation.eyebrow')}
            description={
              <>
                <strong id="computer-use-operation-state">{view.operation.label}</strong>
                <span id="computer-use-operation-summary">{view.operation.summary}</span>
              </>
            }
          >
            <Button
              id="computer-use-update"
              appearance="ghost"
              htmlType="button"
              disabled={view.controls.updateDisabled}
              onClick={() => void actions.update()}
            >
              {label('computerUse.action.update')}
            </Button>
            <Button
              id="computer-use-restart"
              appearance="ghost"
              htmlType="button"
              disabled={view.controls.restartDisabled}
              onClick={() => void actions.restart()}
            >
              {label('computerUse.action.restart')}
            </Button>
            <Button
              id="computer-use-operation-refresh"
              appearance="ghost"
              htmlType="button"
              disabled={view.controls.operationRefreshDisabled}
              onClick={() => void actions.refreshOperation()}
            >
              {label('computerUse.action.operationRefresh')}
            </Button>
            <Button
              id="computer-use-operation-cancel"
              appearance="ghost"
              htmlType="button"
              hidden={view.controls.cancelHidden}
              disabled={view.controls.cancelDisabled}
              onClick={() => void actions.cancelOperation()}
            >
              {label('computerUse.action.cancel')}
            </Button>
          </SettingsItem>
        </SettingsGroup>
      </SettingsDetails>
    </SettingsPage>
  )
}
