import type { ConfigAccount } from '@agnes/protocol'
import {
  Badge,
  Button,
  EmptyState,
  Icon,
  IconButton,
  Menu,
  SettingsBlock,
  SettingsGroup,
  SettingsTag,
  StateSwitch,
  useUiText,
} from '@agnes/web-ui'
import type { ReactNode } from 'react'
import { SIDE_MODELS_NAMESPACE, sideModelsCatalog } from '../side-models-locale.js'

/** The endpoint as the row shows it: its host (with a port), or the address when it does not parse. */
function endpointHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

export type SideModelListProps = {
  accounts: readonly ConfigAccount[]
  canSave: boolean
  busy: boolean
  /** The inline editor is open below the list (no settings page to push it onto). */
  editing: boolean
  removing: string | undefined
  copied: string | undefined
  tested: { accountId: string; key: string } | undefined
  /** The save outcome, shown under the list while no editor is open. */
  status: ReactNode
  /** The inline editor, when there is no settings page to push it onto. */
  children?: ReactNode
  onAdd(): void
  onEdit(account: ConfigAccount): void
  onToggle(account: ConfigAccount, enabled: boolean): void
  onCopy(account: ConfigAccount): void
  onTest(account: ConfigAccount): void
  onRemove(account: ConfigAccount | undefined): void
  onConfirmRemove(account: ConfigAccount): void
}

/** The side-model group: the same card rows as the account list above, an empty state, the hint. */
export function SideModelList(props: SideModelListProps) {
  const { t } = useUiText(SIDE_MODELS_NAMESPACE, sideModelsCatalog)
  const { accounts, canSave, busy, editing } = props
  const empty = accounts.length === 0 && !editing
  const addRow = (
    <Button
      type="text"
      className="config-account-add"
      data-testid="side-model-add"
      disabled={!canSave || busy}
      onClick={props.onAdd}
    >
      <Icon name="plus" />
      {t('side.add')}
    </Button>
  )
  return (
    <SettingsBlock
      bare
      className="side-models"
      data-testid="side-models"
      label={
        <>
          <span data-testid="side-models-title">{t('side.title')}</span>
          {accounts.length > 0 && (
            <span className="side-models-count" data-testid="side-models-count">
              {t('side.count', { count: accounts.length })}
            </span>
          )}
        </>
      }
    >
      {/* The empty state explains the same thing in its own description. */}
      {!empty && (
        <p className="side-models-note" data-testid="side-models-note">
          {t('side.note')}
        </p>
      )}
      {empty ? (
        <SettingsGroup className="side-models-empty">
          <EmptyState
            data-testid="side-models-empty"
            icon={<Icon name="git-branch" />}
            title={t('side.emptyTitle')}
            description={t('side.emptyNote')}
          />
          {addRow}
        </SettingsGroup>
      ) : (
        <SettingsGroup className="config-account-list">
          {accounts.map((account) => (
            <SideModelRow key={account.accountId} account={account} {...props} />
          ))}
          {addRow}
        </SettingsGroup>
      )}
      {props.children}
      {accounts.length > 0 && (
        <p className="side-models-note" data-testid="side-model-route-hint">
          {t('side.hint')}
        </p>
      )}
      {!editing && props.status}
    </SettingsBlock>
  )
}

function SideModelRow({
  account,
  canSave,
  busy,
  removing,
  copied,
  tested,
  onEdit,
  onToggle,
  onCopy,
  onTest,
  onRemove,
  onConfirmRemove,
}: SideModelListProps & { account: ConfigAccount }) {
  const { t } = useUiText(SIDE_MODELS_NAMESPACE, sideModelsCatalog)
  const id = account.accountId
  const only = account.models.length === 1 ? account.models[0] : undefined
  return (
    <>
      <div
        className="agnes-settings-item config-account side-model"
        data-testid={`side-model-${id}`}
        data-enabled={account.enabled}
      >
        <span className="agnes-settings-logo" aria-hidden="true">
          <Icon name="git-branch" />
        </span>
        <span className="agnes-settings-item-copy">
          <span className="side-model-name">
            <Button
              htmlType="button"
              className="config-account-select"
              appearance="ghost"
              aria-label={t('side.editAria', { label: account.label })}
              data-testid={`side-model-edit-${id}`}
              disabled={!canSave || busy}
              onClick={() => onEdit(account)}
            >
              {account.label}
            </Button>
            <Badge>{t(`side.adapter.${account.providerId}`)}</Badge>
            {!account.credentialConfigured && (
              <SettingsTag tone="warn">{t('side.credentialMissing')}</SettingsTag>
            )}
            {!account.enabled && <SettingsTag tone="muted">{t('side.disabled')}</SettingsTag>}
          </span>
          <span className="agnes-settings-item-description config-account-meta">
            <span className="side-model-route" translate="no">
              <span className="side-model-route-name" data-testid={`side-model-route-${id}`}>
                {account.route}
              </span>
              <IconButton
                name="copy"
                label={t('side.copyRouteAria', { route: account.route })}
                data-testid={`side-model-copy-${id}`}
                onClick={() => onCopy(account)}
              />
            </span>
            {copied === id && (
              <span className="side-model-notice" role="status" data-testid={`side-model-copied-${id}`}>
                <Icon name="check" />
                {t('side.copied')}
              </span>
            )}
            <span>{only ? only.name : t('side.modelCount', { count: account.models.length })}</span>
            <span aria-hidden="true">·</span>
            <span translate="no" title={account.baseUrl}>
              {endpointHost(account.baseUrl)}
            </span>
            {tested?.accountId === id && (
              <span
                className="side-model-notice"
                role={tested.key === 'side.testOk' ? 'status' : 'alert'}
                data-tone={tested.key === 'side.testOk' ? 'success' : 'error'}
                data-testid={`side-model-test-status-${id}`}
              >
                {t(tested.key)}
              </span>
            )}
          </span>
        </span>
        <div className="config-account-actions">
          <StateSwitch
            testId={`side-model-toggle-${id}`}
            label={t(account.enabled ? 'side.disable' : 'side.enable', { label: account.label })}
            checked={account.enabled}
            disabled={!canSave || busy}
            onToggle={(next) => onToggle(account, next)}
          />
          <Menu
            label={t('side.actions', { label: account.label })}
            trigger={
              <Button
                appearance="ghost"
                aria-label={t('side.actions', { label: account.label })}
                title={t('side.actions', { label: account.label })}
                data-testid={`side-model-menu-${id}`}
              >
                <Icon name="ellipsis" />
              </Button>
            }
            items={[
              {
                id: 'edit',
                label: t('side.edit'),
                testId: `side-model-menu-edit-${id}`,
                disabled: !canSave || busy,
                onSelect: () => onEdit(account),
              },
              {
                id: 'copy',
                label: t('side.copyRoute'),
                testId: `side-model-menu-copy-${id}`,
                onSelect: () => onCopy(account),
              },
              {
                id: 'test',
                label: t('side.test'),
                testId: `side-model-menu-test-${id}`,
                disabled: busy,
                onSelect: () => onTest(account),
              },
              {
                id: 'remove',
                label: t('side.remove'),
                testId: `side-model-remove-${id}`,
                danger: true,
                disabled: !canSave || busy,
                onSelect: () => onRemove(account),
              },
            ]}
          />
        </div>
      </div>
      {removing === id && (
        <div className="side-model-confirm" role="alert" data-testid={`side-model-remove-strip-${id}`}>
          <span>
            {t('side.removeBefore', { label: account.label })}
            <code translate="no">{account.route}</code>
            {t('side.removeAfter')}
          </span>
          <Button
            size="small"
            data-testid={`side-model-remove-cancel-${id}`}
            disabled={busy}
            onClick={() => onRemove(undefined)}
          >
            {t('side.cancel')}
          </Button>
          <Button
            size="small"
            appearance="danger"
            data-testid={`side-model-remove-confirm-${id}`}
            disabled={!canSave || busy}
            onClick={() => onConfirmRemove(account)}
          >
            {t('side.removeConfirm')}
          </Button>
        </div>
      )}
    </>
  )
}
