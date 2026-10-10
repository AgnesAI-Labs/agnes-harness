import type { AuxiliaryModelSlots } from '@agnes/protocol'
import { fallbackT, type Translate } from './locales/index.js'
import { Field } from './ui/field.js'
import { Badge } from './ui/badge.js'
import { SettingsList, SettingsRow, SettingsSelect } from './settings-layout.js'

export type AuxiliaryModelOption = { route: string; id: string; label?: string }
export function AuxiliaryModelFields({
  slots,
  models,
  disabled,
  onChange,
  t = fallbackT,
  prefix = 'model-slot',
  allowUnset = true,
}: {
  slots: AuxiliaryModelSlots
  models: readonly AuxiliaryModelOption[]
  disabled: boolean
  onChange(slot: 'fast' | 'verifier', target: AuxiliaryModelSlots['fast']): void
  t?: Translate
  allowUnset?: boolean
  prefix?: string
}) {
  return (
    <SettingsList>
      {(['fast', 'verifier'] as const).map((slot) => {
        const target = slots[slot]
        const value = target ? JSON.stringify([target.route, target.model]) : ''
        const available =
          !!target && models.some((model) => model.route === target.route && model.id === target.model)
        const id = `${prefix}-${slot}`
        return (
          <SettingsRow
            key={slot}
            title={t(`modelSettings.slots.${slot}`)}
            description={t(`modelSettings.slots.${slot}Help`)}
          >
            <p className="model-slot-current" data-testid={`${id}-current`}>
              <Badge tone={available ? 'ok' : 'warn'}>
                {target
                  ? `${target.route} / ${target.model}${available ? '' : ` · ${t('modelSettings.slots.unavailable')}`}`
                  : t('modelSettings.slots.unset')}
              </Badge>
            </p>
            <Field label={t('modelSettings.slots.model')} htmlFor={id}>
              <SettingsSelect
                id={id}
                data-testid={id}
                value={value}
                disabled={disabled}
                onChange={(event) => {
                  const model = models.find(
                    (entry) => JSON.stringify([entry.route, entry.id]) === event.target.value,
                  )
                  onChange(slot, model ? { route: model.route, model: model.id } : null)
                }}
              >
                <option value="" disabled={!allowUnset}>
                  {t(allowUnset ? 'modelSettings.slots.unset' : 'modelSettings.slots.choose')}
                </option>
                {target && !available && (
                  <option value={value} disabled>
                    {target.route} / {target.model} · {t('modelSettings.slots.unavailable')}
                  </option>
                )}
                {models.map((model) => (
                  <option
                    key={JSON.stringify([model.route, model.id])}
                    value={JSON.stringify([model.route, model.id])}
                  >
                    {model.label ?? model.route} · {model.id}
                  </option>
                ))}
              </SettingsSelect>
            </Field>
          </SettingsRow>
        )
      })}
    </SettingsList>
  )
}
