import type { AuxiliaryModelSlots } from '@agnes/protocol'
import { fallbackT, type Translate } from './locales/index.js'
import { SettingsGroup, SettingsItem, SettingsSelect } from './settings-layout.js'
import { Badge } from './ui/badge.js'

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
    <SettingsGroup>
      {(['fast', 'verifier'] as const).map((slot) => {
        const target = slots[slot]
        const value = target ? JSON.stringify([target.route, target.model]) : ''
        const available =
          !!target && models.some((model) => model.route === target.route && model.id === target.model)
        const id = `${prefix}-${slot}`
        const stale = !!target && !available
        return (
          <SettingsItem
            key={slot}
            labelId={`${id}-label`}
            label={t(`modelSettings.slots.${slot}`)}
            description={
              <>
                {t(`modelSettings.slots.${slot}Help`)}
                {/* The select already shows the choice; the line is repeated only as a warning. */}
                <span
                  className={stale ? 'model-slot-current' : 'model-slot-current visually-hidden'}
                  data-testid={`${id}-current`}
                >
                  {stale ? (
                    <Badge tone="warn">
                      {target.route} / {target.model} · {t('modelSettings.slots.unavailable')}
                    </Badge>
                  ) : target ? (
                    `${target.route} / ${target.model}`
                  ) : (
                    t('modelSettings.slots.unset')
                  )}
                </span>
              </>
            }
          >
            <SettingsSelect
              id={id}
              data-testid={id}
              aria-labelledby={`${id}-label`}
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
              {stale && (
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
          </SettingsItem>
        )
      })}
    </SettingsGroup>
  )
}
