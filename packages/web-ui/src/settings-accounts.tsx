import type { ConfigAccount, ConfigAccountInput } from '@agnes/protocol'
import type { ReactNode } from 'react'
import { fallbackT, type Translate } from './locales/index.js'
import { SettingsGroup, SettingsState } from './settings-layout.js'
import { Badge } from './ui/badge.js'
import { Button } from './ui/button.js'
import { EmptyState } from './ui/empty-state.js'
import { Icon } from './ui/icon.js'
import { Loadable } from './ui/loadable.js'
import { Menu } from './ui/menu.js'
import { Tag } from './ui/tag.js'

export type SettingsAccountsProps = {
  accounts: readonly ConfigAccount[]
  defaultAccountId?: string | null | undefined
  disabled: boolean
  phase?: 'idle' | 'loading' | 'ready' | 'empty' | 'error'
  onRetry?(): void
  onAdd?(): void
  providerChoices?: ReactNode
  onDemo?(): void
  saved?: boolean
  onDismissSaved?(): void
  editingId?: string | undefined
  removingId?: string | undefined
  onEdit(id: string): void
  onAction(account: ConfigAccount, action: ConfigAccountInput['action']): void
  onCancelRemove(): void
  t?: Translate
}

/** Indicators check enabled state before credentials; red means enabled with missing credentials, excluding the account from available models. */
function accountStatus(account: ConfigAccount): 'inactive' | 'ready' | 'missing' {
  if (!account.enabled) return 'inactive'
  return account.credentialConfigured ? 'ready' : 'missing'
}

/** A stable colour for a provider's logo tile, from its id. */
export function providerHue(providerId: string): number {
  let sum = 0
  for (const char of providerId) sum = (sum * 31 + char.charCodeAt(0)) % 997
  return sum % 6
}

export function SettingsAccounts({
  accounts,
  defaultAccountId,
  disabled,
  phase,
  onRetry,
  onAdd,
  providerChoices,
  onDemo,
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
    const status = accountStatus(account)
    const model = account.models.find((entry) => entry.id === account.model)?.name ?? account.model
    // The default account is guarded: it is neither disabled nor removed until another is default.
    const guarded = isDefault && canTransferDefault
    const items = [
      ...(account.enabled && !isDefault
        ? [{ id: 'default', label: t('accounts.makeDefault'), action: 'default' as const }]
        : []),
      { id: 'edit', label: t('accounts.edit') },
      ...(guarded
        ? []
        : [
            {
              id: account.enabled ? 'disable' : 'enable',
              label: t(account.enabled ? 'accounts.disable' : 'accounts.enable'),
              action: (account.enabled ? 'disable' : 'enable') as ConfigAccountInput['action'],
            },
            { id: 'remove', label: t('accounts.remove'), action: 'remove' as const, danger: true },
          ]),
    ]
    return (
      <div
        key={account.accountId}
        className="agnes-settings-item config-account"
        data-selected={account.accountId === editingId}
        data-status={status}
        data-enabled={account.enabled}
      >
        <span className="agnes-settings-logo" data-hue={providerHue(account.providerId)} aria-hidden="true">
          {(account.label.trim()[0] ?? '?').toUpperCase()}
        </span>
        <span className="agnes-settings-item-copy">
          <Button
            htmlType="button"
            className="config-account-select"
            appearance="ghost"
            aria-pressed={account.accountId === editingId}
            aria-label={t('accounts.editAria', { label: account.label })}
            disabled={disabled}
            onClick={() => onEdit(account.accountId)}
          >
            {account.label}
          </Button>
          <span className="agnes-settings-item-description config-account-meta">
            {t('accounts.modelCount', { model, count: account.models.length })}
          </span>
        </span>
        <span className="agnes-settings-value">
          {status === 'missing' ? (
            <Tag tone="bad">{t('accounts.missing')}</Tag>
          ) : isDefault ? (
            <Badge className="config-account-status">{t('accounts.defaultBadge')}</Badge>
          ) : !account.enabled ? (
            <Tag tone="info">{t('accounts.disabled')}</Tag>
          ) : null}
        </span>
        <div className="config-account-actions">
          {status === 'missing' && (
            <Button size="small" onClick={() => onEdit(account.accountId)} disabled={disabled}>
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
            items={items.map((item) => ({
              id: item.id,
              label: item.label,
              ariaLabel: `${item.label} ${account.label}`,
              danger: 'danger' in item && !!item.danger,
              onSelect: () =>
                'action' in item && item.action ? onAction(account, item.action) : onEdit(account.accountId),
            }))}
          />
          {removingId === account.accountId && (
            <>
              <Button
                appearance="danger"
                htmlType="button"
                size="small"
                disabled={disabled}
                aria-label={`${t('accounts.confirmRemove')} ${account.label}`}
                onClick={() => onAction(account, 'remove')}
              >
                {t('accounts.confirmRemove')}
              </Button>
              <Button htmlType="button" size="small" disabled={disabled} onClick={onCancelRemove}>
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
      {phase === 'loading' && <Loadable loading hasData={false} shape="rows" />}
      {phase === 'empty' && (
        <SettingsGroup className="config-accounts-welcome">
          <EmptyState
            icon={<Icon name="sparkles" size={48} />}
            title={t('accounts.empty')}
            description={t('accounts.emptyHelp')}
          />
          {providerChoices}
          <p className="config-accounts-demo">
            {t('accounts.or')}{' '}
            <Button type="text" title={t('accounts.demoHelp')} onClick={onDemo}>
              {t('accounts.demo')}
            </Button>
          </p>
        </SettingsGroup>
      )}
      {phase === 'error' && (
        <SettingsState tone="error">
          {t('accounts.readFailed')}
          <Button onClick={onRetry}>{t('accounts.retryRead')}</Button>
        </SettingsState>
      )}
      {(rows.length > 0 || phase === 'ready') && (
        <SettingsGroup className="config-account-list">
          {rows}
          <Button
            id="config-add-account"
            className="config-account-add"
            type="text"
            disabled={disabled}
            onClick={onAdd}
          >
            <Icon name="plus" />
            {t('settings-shell.addAccount')}
          </Button>
        </SettingsGroup>
      )}
    </>
  )
}
