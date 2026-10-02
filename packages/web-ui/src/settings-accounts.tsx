import type { ConfigAccount, ConfigAccountInput } from '@agnes/protocol'
import { fallbackT, type Translate } from './locales/index.js'

export type SettingsAccountsProps = {
  accounts: readonly ConfigAccount[]
  defaultAccountId?: string | null | undefined
  disabled: boolean
  editingId?: string | undefined
  removingId?: string | undefined
  onEdit(id: string): void
  onAction(account: ConfigAccount, action: ConfigAccountInput['action']): void
  onCancelRemove(): void
  t?: Translate
}

export function SettingsAccounts({
  accounts,
  defaultAccountId,
  disabled,
  editingId,
  removingId,
  onEdit,
  onAction,
  onCancelRemove,
  t = fallbackT,
}: SettingsAccountsProps) {
  return accounts.map((account) => {
    const isDefault = defaultAccountId === account.accountId
    const canTransferDefault = accounts.some(
      (other) => other.enabled && other.accountId !== account.accountId,
    )
    const actions: Array<[ConfigAccountInput['action'], string]> = [
      [account.enabled ? 'disable' : 'enable', account.enabled ? t('accounts.disable') : t('accounts.enable')],
      ['default', t('accounts.makeDefault')],
      ['remove', removingId === account.accountId ? t('accounts.confirmRemove') : t('accounts.remove')],
    ]
    return (
      <div
        key={account.accountId}
        className="config-account"
        data-selected={account.accountId === editingId}
        data-credential={account.credentialConfigured ? 'configured' : 'missing'}
      >
        <button
          type="button"
          className="config-account-select"
          aria-pressed={account.accountId === editingId}
          disabled={disabled}
          onClick={() => onEdit(account.accountId)}
        >
          {account.label}
        </button>
        <span className="config-account-meta">
          <span>
            {account.providerId} · {account.model}
          </span>
          <span className="config-account-status" data-tone={account.enabled ? 'success' : 'neutral'}>
            {account.enabled ? t('accounts.enabled') : t('accounts.disabled')}
          </span>
          {isDefault && (
            <span className="config-account-status" data-tone="brand">
              {t('accounts.defaultBadge')}
            </span>
          )}
        </span>
        <div className="config-account-actions">
          <button
            type="button"
            aria-label={t('accounts.editAria', { label: account.label })}
            disabled={disabled}
            onClick={() => onEdit(account.accountId)}
          >
            {t('accounts.edit')}
          </button>
          {actions.map(([action, label]) => {
            if (action === 'default' && (!account.enabled || isDefault)) return null
            if ((action === 'disable' || action === 'remove') && isDefault && canTransferDefault) return null
            return (
              <button
                key={action}
                type="button"
                aria-label={`${label} ${account.label}`}
                disabled={disabled}
                onClick={() => onAction(account, action)}
              >
                {label}
              </button>
            )
          })}
          {removingId === account.accountId && (
            <button type="button" disabled={disabled} onClick={onCancelRemove}>
              {t('accounts.cancelRemove')}
            </button>
          )}
        </div>
      </div>
    )
  })
}
