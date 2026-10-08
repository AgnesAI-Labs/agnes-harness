import type { ConfigAccount, ConfigSaveInput } from '@agnes/protocol'
import type { ConfigSchema, Translate } from '@agnes/web-ui'
import { configIssues, renderRegion, SchemaConfigFields, unmountRegion } from '@agnes/web-ui'

export const accountNetworkSchema: ConfigSchema = {
  type: 'object',
  additionalProperties: false,
  properties: Object.fromEntries(
    ['requestMs', 'connectMs', 'streamIdleMs'].map((key) => [
      key,
      {
        type: 'integer',
        minimum: 1,
        maximum: 3_600_000,
        'x-ui': {
          labelKey: `accounts.network.${key}`,
          id: `account-network-${key}`,
          testId: `account-network-${key}`,
        },
      },
    ]),
  ),
}

/** The account controller owns values and persistence; this region only renders shared schema fields. */
export function accountNetworkFields(root: HTMLElement | null, t: Translate, onChange: () => void) {
  let value: Record<string, unknown> = {}
  let disabled = false
  const normalized = () =>
    Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== '' && entry !== undefined))
  const render = () => {
    if (!root) return
    renderRegion(
      root,
      <details data-testid="account-network-details">
        <summary>{t('accounts.network.legend')}</summary>
        <fieldset className="config-section" disabled={disabled} data-testid="account-network-timeouts">
          <legend>{t('accounts.network.legend')}</legend>
          <p className="field-hint form-field-wide">{t('accounts.network.hint')}</p>
          <SchemaConfigFields
            schema={accountNetworkSchema}
            value={value}
            issues={configIssues(accountNetworkSchema, normalized())}
            onChange={(next) => {
              value = next
              render()
              onChange()
            }}
            t={t}
          />
        </fieldset>
      </details>,
    )
  }
  return {
    load(account: ConfigAccount | undefined) {
      value = { ...account?.networkTimeouts }
      render()
    },
    disabled(next: boolean) {
      disabled = next
      render()
    },
    changed(account: ConfigAccount): boolean {
      return ['requestMs', 'connectMs', 'streamIdleMs'].some(
        (key) =>
          normalized()[key] !==
          account.networkTimeouts?.[key as keyof NonNullable<ConfigAccount['networkTimeouts']>],
      )
    },
    read(): NonNullable<ConfigSaveInput['networkTimeouts']> {
      const next = normalized()
      if (configIssues(accountNetworkSchema, next).length) throw new Error(t('accounts.network.invalid'))
      return next
    },
    render,
    close() {
      if (root) unmountRegion(root)
    },
  }
}
