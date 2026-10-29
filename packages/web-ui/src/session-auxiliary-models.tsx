import type { AuxiliaryModelSlots } from '@agnes/protocol'
import { useEffect, useRef, useState } from 'react'
import type { AuxiliaryModelOption } from './auxiliary-model-fields.js'
import { reportSuccess } from './feedback.js'
import { fallbackT, type Translate } from './locales/index.js'
import { SettingsState } from './settings-layout.js'
import { Select } from './ui/select.js'

/** Effective session routes and resolved defaults supplied by the host. */
export type SessionAuxiliarySnapshot = AuxiliaryModelSlots & { defaults?: AuxiliaryModelSlots }

export function SessionAuxiliaryModels({
  models,
  snapshot,
  save,
  onSaved,
  disabled,
  t = fallbackT,
}: {
  models: readonly AuxiliaryModelOption[]
  snapshot: SessionAuxiliarySnapshot
  save(slot: 'fast' | 'verifier', model: AuxiliaryModelOption): Promise<boolean>
  onSaved(slot: 'fast' | 'verifier', target: NonNullable<AuxiliaryModelSlots['fast']>): void
  disabled: boolean
  t?: Translate
}) {
  const mounted = useRef(true)
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  async function apply(slot: 'fast' | 'verifier', value: string) {
    const target =
      value === ''
        ? snapshot.defaults?.[slot]
        : models.find((model) => JSON.stringify([model.route, model.id]) === value)
    if (!target || disabled || pending.current) return
    const model = 'id' in target ? target : { route: target.route, id: target.model }
    pending.current = true
    setBusy(true)
    setMessage('')
    try {
      const accepted = await save(slot, model)
      if (accepted) {
        if (mounted.current) onSaved(slot, { route: model.route, model: model.id })
        reportSuccess('session-model-slots', t('modelSettings.slots.sessionSaved'))
      } else if (mounted.current) setMessage('sessionFailed')
    } catch {
      if (mounted.current) setMessage('sessionFailed')
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <div className="model-picker-auxiliary" data-testid="session-auxiliary-models">
      {(['fast', 'verifier'] as const).map((slot) => {
        const target = snapshot[slot]
        const fallback = snapshot.defaults?.[slot]
        const follows = target?.route === fallback?.route && target?.model === fallback?.model
        const value = target && !follows ? JSON.stringify([target.route, target.model]) : ''
        const current = models.find((model) => model.route === target?.route && model.id === target?.model)
        const defaultModel = models.find(
          (model) => model.route === fallback?.route && model.id === fallback?.model,
        )
        const id = `session-model-slot-${slot}`
        return (
          <div className="model-picker-aux-row" key={slot}>
            <div className="model-picker-aux-head">
              <label id={`${id}-label`} htmlFor={id}>
                {t(`modelSettings.slots.${slot}Session`)}
              </label>
              <small>{t(`modelSettings.slots.${slot}SessionHelp`)}</small>
            </div>
            <Select<string>
              id={id}
              data-testid={id}
              aria-labelledby={`${id}-label`}
              value={value}
              disabled={disabled || busy}
              getPopupContainer={(trigger) => trigger.parentElement ?? trigger}
              options={[
                {
                  value: '',
                  label: t('modelSettings.slots.followDefault', {
                    model: defaultModel?.name ?? fallback?.model ?? t('modelSettings.slots.unset'),
                  }),
                  disabled: !fallback && !!target,
                },
                ...(target && !current
                  ? [
                      {
                        value,
                        label: `${target.model} · ${t('modelSettings.slots.unavailable')}`,
                        disabled: true,
                      },
                    ]
                  : []),
                ...models.map((model) => ({
                  value: JSON.stringify([model.route, model.id]),
                  // The model leads; its account follows to tell same-named models apart.
                  label: `${model.name ?? model.id} · ${model.label ?? model.route}`,
                })),
              ]}
              onChange={(value) => void apply(slot, value)}
            />
          </div>
        )
      })}
      {message && (
        <SettingsState tone="error" data-testid="session-model-slot-status">
          {t(`modelSettings.slots.${message}`)}
        </SettingsState>
      )}
    </div>
  )
}
