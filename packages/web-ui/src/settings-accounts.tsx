import type { ConfigAccount, ConfigAccountInput } from '@agnes/protocol'
import { Button } from './ui/button.js'
import { Badge } from './ui/badge.js'
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

/** 指示灯先看启用状态再看凭据；红色只留给「启用但凭据缺失」，该状态会使模型列表构造失败。 */
function accountStatus(account: ConfigAccount): 'inactive' | 'ready' | 'missing' {
  if (!account.enabled) return 'inactive'
  return account.credentialConfigured ? 'ready' : 'missing'
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
      [
        account.enabled ? 'disable' : 'enable',
        account.enabled ? t('accounts.disable') : t('accounts.enable'),
      ],
      ['default', t('accounts.makeDefault')],
      ['remove', removingId === account.accountId ? t('accounts.confirmRemove') : t('accounts.remove')],
    ]
    return (
      <div
        key={account.accountId}
        className="config-account"
        data-selected={account.accountId === editingId}
        data-status={accountStatus(account)}
      >
        <Button
          htmlType="button"
          className="config-account-select"
          aria-pressed={account.accountId === editingId}
          disabled={disabled}
          onClick={() => onEdit(account.accountId)}
        >
          {account.label}
        </Button>
        <span className="config-account-meta">
          <span>
            {account.providerId} · {account.model}
          </span>
          <Badge className="config-account-status" tone={account.enabled ? 'ok' : 'off'}>
            {account.enabled ? t('accounts.enabled') : t('accounts.disabled')}
          </Badge>
          {isDefault && <Badge className="config-account-status">{t('accounts.defaultBadge')}</Badge>}
        </span>
        <div className="config-account-actions">
          <Button
            htmlType="button"
            aria-label={t('accounts.editAria', { label: account.label })}
            disabled={disabled}
            onClick={() => onEdit(account.accountId)}
          >
            {t('accounts.edit')}
          </Button>
          {actions.map(([action, label]) => {
            if (action === 'default' && (!account.enabled || isDefault)) return null
            if ((action === 'disable' || action === 'remove') && isDefault && canTransferDefault) return null
            return (
              <Button
                key={action}
                htmlType="button"
                aria-label={`${label} ${account.label}`}
                disabled={disabled}
                onClick={() => onAction(account, action)}
              >
                {label}
              </Button>
            )
          })}
          {removingId === account.accountId && (
            <Button htmlType="button" disabled={disabled} onClick={onCancelRemove}>
              {t('accounts.cancelRemove')}
            </Button>
          )}
        </div>
      </div>
    )
  })
}
