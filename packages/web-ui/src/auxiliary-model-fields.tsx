import type { AuxiliaryModelSlots } from '@agnes/protocol'
import { type ReactNode, useLayoutEffect, useRef } from 'react'
import { fallbackT, type Translate } from './locales/index.js'
import { createSelectPicker, type SelectPicker } from './select-picker.js'
import { SettingsGroup, SettingsItem, SettingsSelect } from './settings-layout.js'
import { Badge } from './ui/badge.js'

/** `label` names the account the model comes from and `name` the model; ids are only the fallback. */
export type AuxiliaryModelOption = { route: string; id: string; label?: string; name?: string }
/** What a person reads for a model: its account and its name, never the internal route id alone. */
export const auxiliaryModelLabel = (model: AuxiliaryModelOption): string =>
  `${model.label ?? model.route} · ${model.name ?? model.id}`

/** The settings select with the themed picker over it; the select stays the form control. */
function PickedSelect({
  label,
  children,
  ...props
}: {
  id: string
  label: string
  value: string
  disabled: boolean
  'data-testid': string
  'aria-labelledby': string
  onChange(value: string): void
  children: ReactNode
}) {
  const select = useRef<HTMLSelectElement>(null)
  const picker = useRef<SelectPicker>()
  useLayoutEffect(() => {
    if (!select.current) return
    const created = createSelectPicker(select.current, { label })
    picker.current = created
    return () => {
      picker.current = undefined
      created.destroy()
    }
  }, [label])
  // The picker mirrors the select, so it is brought up to date after every render.
  useLayoutEffect(() => picker.current?.sync())
  const { onChange, ...rest } = props
  return (
    <SettingsSelect {...rest} ref={select} onChange={(event) => onChange(event.target.value)}>
      {children}
    </SettingsSelect>
  )
}
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
            <PickedSelect
              id={id}
              label={t(`modelSettings.slots.${slot}`)}
              data-testid={id}
              aria-labelledby={`${id}-label`}
              value={value}
              disabled={disabled}
              onChange={(selected) => {
                const model = models.find((entry) => JSON.stringify([entry.route, entry.id]) === selected)
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
                  {auxiliaryModelLabel(model)}
                </option>
              ))}
            </PickedSelect>
          </SettingsItem>
        )
      })}
    </SettingsGroup>
  )
}
