import { computerUseUiCatalog } from './locales/computer-use.js'
import { SettingsDetails, SettingsGroup, SettingsItem } from './settings-layout.js'
import { Badge } from './ui/badge.js'
import { Button } from './ui/button.js'
import { IconButton } from './ui/icon-button.js'
import { Tag } from './ui/tag.js'
import { useUiText } from './ui-locale.js'

export type SettingsComputerUseView = Readonly<{
  status: Readonly<{ label: string; summary: string; runtime: string; blockers: readonly string[] }>
  permissions: Readonly<{ label: string; summary: string; grantHidden: boolean }>
  doctor: Readonly<{ label: string; summary: string }>
  operation: Readonly<{ label: string; summary: string }>
  /** Which parts need the user; absent from a host that only reports labels. */
  attention?: Readonly<{ status: boolean; permissions: boolean; doctor: boolean; operation: boolean }>
  /** The driver is ready to use. */
  ready?: boolean
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

/** A state in words: amber when the user has something to do, green only for a confirmed good state. */
function StateMark({
  attention,
  ok = false,
  children,
}: {
  attention: boolean
  ok?: boolean
  children: string
}) {
  return attention ? <Tag tone="warn">{children}</Tag> : <Badge tone={ok ? 'ok' : 'off'}>{children}</Badge>
}

/**
 * Computer use as a built-in capability page. When everything works it is one line; whatever needs
 * the user opens by itself, with the button for that step beside it.
 */
export function ComputerUseCapability({
  view,
  actions,
  text,
}: {
  view: SettingsComputerUseView
  actions: SettingsComputerUseActions
  text?: (key: string) => string
}) {
  const { t } = useUiText('@agnes/web-ui/computer-use', computerUseUiCatalog)
  const label = (key: string) => {
    const value = text?.(key)
    return value && value !== key ? value : t(key)
  }
  const attention = view.attention ?? { status: false, permissions: false, doctor: false, operation: false }
  const needsUser = attention.status || attention.permissions || attention.doctor || attention.operation
  const canInstall =
    view.permissions.grantHidden && view.controls.updateDisabled && !view.controls.installDisabled
  return (
    <div
      className="agnes-settings-stack agh-computer-use"
      data-testid="computer-use-capability"
      data-attention={needsUser}
    >
      <SettingsGroup>
        <SettingsItem
          icon="eye"
          label={
            <>
              <span>{label('computerUse.status.eyebrow')}</span>{' '}
              <span role="status" data-testid="computer-use-state">
                <StateMark attention={attention.status || attention.permissions} ok={view.ready === true}>
                  {view.status.label}
                </StateMark>
              </span>
            </>
          }
          description={
            <>
              <span data-testid="computer-use-summary">{view.status.summary}</span>{' '}
              <span data-testid="computer-use-runtime">{view.status.runtime}</span>
              {view.status.blockers.length > 0 && (
                <ul data-testid="computer-use-blockers">
                  {view.status.blockers.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}
            </>
          }
        >
          {!view.permissions.grantHidden && (
            <Button
              appearance="primary"
              data-testid="computer-use-permission-grant"
              disabled={view.controls.grantDisabled}
              onClick={() => void actions.grantPermissions()}
            >
              {label('computerUse.permissions.grant')}
            </Button>
          )}
          {canInstall && (
            <Button
              appearance="primary"
              data-testid="computer-use-install"
              onClick={() => void actions.install()}
            >
              {label('computerUse.action.install')}
            </Button>
          )}
          <IconButton
            name="refresh-cw"
            label={label('computerUse.action.refresh')}
            data-testid="computer-use-refresh"
            disabled={view.controls.refreshDisabled}
            onClick={() => void actions.refresh()}
          />
        </SettingsItem>
      </SettingsGroup>
      <SettingsDetails
        title={label('computerUse.more')}
        data-testid="computer-use-more"
        {...(needsUser ? { open: true } : {})}
      >
        <SettingsGroup>
          <SettingsItem
            icon="shield"
            label={
              <>
                <span>{label('computerUse.permissions.eyebrow')}</span>{' '}
                <span data-testid="computer-use-permission-state">
                  <StateMark attention={attention.permissions}>{view.permissions.label}</StateMark>
                </span>
              </>
            }
            description={
              <span data-testid="computer-use-permission-summary">{view.permissions.summary}</span>
            }
          />
          <SettingsItem
            icon="activity"
            label={
              <>
                <span>{label('computerUse.doctor.eyebrow')}</span>{' '}
                <span data-testid="computer-use-doctor-state">
                  <StateMark attention={attention.doctor}>{view.doctor.label}</StateMark>
                </span>
              </>
            }
            description={<span data-testid="computer-use-doctor-summary">{view.doctor.summary}</span>}
          >
            <Button
              appearance={attention.doctor ? 'primary' : 'ghost'}
              data-testid="computer-use-doctor-run"
              disabled={view.controls.doctorDisabled}
              onClick={() => void actions.doctor()}
            >
              {label('computerUse.doctor.run')}
            </Button>
          </SettingsItem>
          <SettingsItem
            icon="download"
            label={
              <>
                <span>{label('computerUse.operation.eyebrow')}</span>{' '}
                <span data-testid="computer-use-operation-state">
                  <StateMark attention={attention.operation}>{view.operation.label}</StateMark>
                </span>
              </>
            }
            description={<span data-testid="computer-use-operation-summary">{view.operation.summary}</span>}
          >
            <Button
              appearance="ghost"
              data-testid="computer-use-update"
              disabled={view.controls.updateDisabled}
              onClick={() => void actions.update()}
            >
              {label('computerUse.action.update')}
            </Button>
            <Button
              appearance="ghost"
              data-testid="computer-use-restart"
              disabled={view.controls.restartDisabled}
              onClick={() => void actions.restart()}
            >
              {label('computerUse.action.restart')}
            </Button>
            <Button
              appearance="ghost"
              data-testid="computer-use-operation-refresh"
              disabled={view.controls.operationRefreshDisabled}
              onClick={() => void actions.refreshOperation()}
            >
              {label('computerUse.action.operationRefresh')}
            </Button>
            {!view.controls.cancelHidden && (
              <Button
                appearance="ghost"
                data-testid="computer-use-operation-cancel"
                disabled={view.controls.cancelDisabled}
                onClick={() => void actions.cancelOperation()}
              >
                {label('computerUse.action.cancel')}
              </Button>
            )}
          </SettingsItem>
        </SettingsGroup>
      </SettingsDetails>
    </div>
  )
}
