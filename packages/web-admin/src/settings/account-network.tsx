import type { ConfigAccount, ConfigSaveInput } from '@agnes/protocol'
import type { ConfigSchema, Translate } from '@agnes/web-ui'
import {
  configIssues,
  Field,
  renderRegion,
  SettingsPresetSelect,
  secondPresets,
  unmountRegion,
} from '@agnes/web-ui'
import { fieldError } from './account-form.js'

const NETWORK_KEYS = ['connectMs', 'requestMs', 'streamIdleMs'] as const
/** Second presets per timeout; Custom keeps any other stored value. */
const PRESETS: Readonly<Record<(typeof NETWORK_KEYS)[number], readonly number[]>> = {
  connectMs: [5, 10, 30],
  requestMs: [30, 60, 120, 300],
  streamIdleMs: [30, 60, 120, 300],
}

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
      // Three equal controls side by side; Custom turns its own column into a seconds field.
      <fieldset
        className="account-network"
        data-testid="account-network-timeouts"
        aria-disabled={disabled || undefined}
      >
        <legend className="account-network-legend">{t('accounts.network.legend')}</legend>
        {NETWORK_KEYS.map((key) => (
          <div key={key} className="account-field">
            <Field
              className="form-field"
              label={t(`accounts.network.${key}Short`)}
              htmlFor={`account-network-${key}`}
            />
            <SettingsPresetSelect
              id={`account-network-${key}`}
              data-testid={`account-network-${key}`}
              label={t(`accounts.network.${key}`)}
              defaultLabel={t('accounts.network.default')}
              disabled={disabled}
              value={typeof value[key] === 'number' ? (value[key] as number) : undefined}
              presets={secondPresets(PRESETS[key], (count) => t('accounts.network.seconds', { count }))}
              unit={t('accounts.network.secondUnit')}
              scale={1000}
              onChange={(next) => {
                const updated = { ...value }
                if (next === undefined) delete updated[key]
                else updated[key] = next
                value = updated
                render()
                onChange()
              }}
            />
          </div>
        ))}
      </fieldset>,
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
    /** The timeouts as entered, for the advanced options' summary. */
    values: (): Record<string, number> =>
      Object.fromEntries(
        NETWORK_KEYS.flatMap((key) => (typeof value[key] === 'number' ? [[key, value[key]]] : [])),
      ),
    read(): NonNullable<ConfigSaveInput['networkTimeouts']> {
      const next = normalized()
      if (configIssues(accountNetworkSchema, next).length)
        throw fieldError('network', t('accounts.network.invalid'))
      return next
    },
    render,
    close() {
      if (root) unmountRegion(root)
    },
  }
}
