import type { ConfigAccount, ConfigAccountInput } from '@agnes/protocol'
import { fallbackT, type Translate } from './locales/index.js'
import { SettingsList, SettingsState } from './settings-layout.js'
import { Badge } from './ui/badge.js'
import { Button } from './ui/button.js'
import { EmptyState } from './ui/empty-state.js'
import { Icon } from './ui/icon.js'
import { IconTile } from './ui/icon-tile.js'
import { Menu } from './ui/menu.js'
import { Tag } from './ui/tag.js'
import { Toast } from './ui/toast.js'

export type SettingsAccountsProps = {
  accounts: readonly ConfigAccount[]
  defaultAccountId?: string | null | undefined
  disabled: boolean
  phase?: 'idle' | 'loading' | 'ready' | 'empty' | 'error'
  onRetry?(): void
  saved?: boolean
  onDismissSaved?(): void
  editingId?: string | undefined
  removingId?: string | undefined
  onEdit(id: string): void
  onAction(account: ConfigAccount, action: ConfigAccountInput['action']): void
  onCancelRemove(): void
  t?: Translate
}

/** 指示灯先看启用状态再看凭据；红色只留给「启用但凭据缺失」，该状态会使模型列表构造失败。 */
function accountStatus(account: ConfigAccount): 'inactive' | 'ready' | 'missing' {
  if (!account.enabled) return 'inactive'
  return account.credentialConfigured ? 'ready' : 'missing'
}

export function SettingsAccounts({
  accounts,
  defaultAccountId,
  disabled,
  phase,
  onRetry,
  saved = false,
  onDismissSaved,
  editingId,
  removingId,
  onEdit,
  onAction,
  onCancelRemove,
  t = fallbackT,
}: SettingsAccountsProps) {
  const rows = accounts.map((account) => {
    const isDefault = defaultAccountId === account.accountId
    const canTransferDefault = accounts.some(
      (other) => other.enabled && other.accountId !== account.accountId,
    )
    const actions: Array<[ConfigAccountInput['action'], string]> = [
      [
        account.enabled ? 'disable' : 'enable',
        account.enabled ? t('accounts.disable') : t('accounts.enable'),
      ],
      ['default', t('accounts.makeDefault')],
      ['remove', t('accounts.remove')],
    ]
    return (
      <div
        key={account.accountId}
        className="config-account"
        data-selected={account.accountId === editingId}
        data-status={accountStatus(account)}
      >
        <IconTile name="key-round" />
        <Button
          htmlType="button"
          className="config-account-select"
          appearance="ghost"
          aria-pressed={account.accountId === editingId}
          disabled={disabled}
          onClick={() => onEdit(account.accountId)}
        >
          {account.label}
        </Button>
        <span className="config-account-meta">
          <span>
            {account.providerId} ·{' '}
            {account.models.find((model) => model.id === account.model)?.name ?? account.model}
          </span>
          {accountStatus(account) === 'missing' ? (
            <Tag tone="warn">{t('accounts.missing')}</Tag>
          ) : isDefault ? (
            <Badge className="config-account-status">{t('accounts.defaultBadge')}</Badge>
          ) : !account.enabled ? (
            <span>{t('accounts.disabled')}</span>
          ) : null}
        </span>
        <div className="config-account-actions">
          {accountStatus(account) === 'missing' && (
            <Button onClick={() => onEdit(account.accountId)} disabled={disabled}>
              {t('accounts.repair')}
            </Button>
          )}
          <Menu
            label={t('accounts.actions', { label: account.label })}
            trigger={
              <Button
                appearance="ghost"
                disabled={disabled}
                aria-label={t('accounts.actions', { label: account.label })}
                title={t('accounts.actions', { label: account.label })}
              >
                <Icon name="ellipsis" />
              </Button>
            }
            items={[
              {
                id: 'edit',
                label: t('accounts.editAria', { label: account.label }),
                onSelect: () => onEdit(account.accountId),
              },
              ...actions
                .filter(([action]) => {
                  if (action === 'default') return account.enabled && !isDefault
                  return !((action === 'disable' || action === 'remove') && isDefault && canTransferDefault)
                })
                .map(([action, label]) => ({
                  id: action,
                  label: `${label} ${account.label}`,
                  danger: action === 'remove',
                  onSelect: () => onAction(account, action),
                })),
            ]}
          />
          {removingId === account.accountId && (
            <>
              <Button
                appearance="danger"
                htmlType="button"
                disabled={disabled}
                aria-label={`${t('accounts.confirmRemove')} ${account.label}`}
                onClick={() => onAction(account, 'remove')}
              >
                {t('accounts.confirmRemove')}
              </Button>
              <Button htmlType="button" disabled={disabled} onClick={onCancelRemove}>
                {t('accounts.cancelRemove')}
              </Button>
            </>
          )}
        </div>
      </div>
    )
  })
  return (
    <>
      <Toast open={saved} onDismiss={() => onDismissSaved?.()}>
        {t('accounts.saved')}
      </Toast>
      {phase === 'loading' && <SettingsState tone="loading">{t('accounts.loading')}</SettingsState>}
      {phase === 'empty' && (
        <EmptyState
          icon={<Icon name="key-round" size={48} />}
          title={t('accounts.empty')}
          description={t('accounts.emptyHelp')}
        />
      )}
      {phase === 'error' && (
        <SettingsState tone="error">
          {t('accounts.readFailed')}
          <Button onClick={onRetry}>{t('accounts.retryRead')}</Button>
        </SettingsState>
      )}
      {rows.length > 0 && <SettingsList className="config-account-list">{rows}</SettingsList>}
    </>
  )
}
