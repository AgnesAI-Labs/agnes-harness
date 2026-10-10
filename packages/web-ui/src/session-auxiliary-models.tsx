import type { AuxiliaryModelSlots } from '@agnes/protocol'
import { useEffect, useRef, useState } from 'react'
import { AuxiliaryModelFields, type AuxiliaryModelOption } from './auxiliary-model-fields.js'
import { fallbackT, type Translate } from './locales/index.js'
import { SettingsDetails, SettingsState, SettingsToolbar } from './settings-layout.js'
import { Button } from './ui/button.js'

/** Session authority and persisted facts are supplied by the host, never inferred from primary. */
export function SessionAuxiliaryModels({
  models,
  load,
  save,
  disabled,
  t = fallbackT,
}: {
  models: readonly AuxiliaryModelOption[]
  load(): Promise<AuxiliaryModelSlots>
  save(slot: 'fast' | 'verifier', model: AuxiliaryModelOption): Promise<boolean>
  disabled: boolean
  t?: Translate
}) {
  const [slots, setSlots] = useState<AuxiliaryModelSlots>()
  const mounted = useRef(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    let disposed = false
    mounted.current = true
    void load()
      .then((value) => {
        if (!disposed) setSlots(value)
      })
      .catch(() => {
        if (!disposed) setMessage('sessionFailed')
      })
    return () => {
      disposed = true
      mounted.current = false
    }
  }, [load])
  async function apply(slot: 'fast' | 'verifier') {
    const target = slots?.[slot]
    if (!target || disabled || busy) return
    setBusy(true)
    try {
      const accepted = await save(slot, { route: target.route, id: target.model })
      if (mounted.current) setMessage(accepted ? 'sessionSaved' : 'sessionFailed')
    } catch {
      if (mounted.current) setMessage('sessionFailed')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <SettingsDetails title={t('modelSettings.slots.advanced')} data-testid="session-auxiliary-models">
      <p>{t('modelSettings.slots.sessionHelp')}</p>
      {slots ? (
        <AuxiliaryModelFields
          prefix="session-model-slot"
          slots={slots}
          models={models}
          disabled={disabled || busy}
          allowUnset={false}
          t={t}
          onChange={(slot, target) => {
            setSlots((current) => ({ ...current, [slot]: target }))
            setMessage('')
          }}
        />
      ) : (
        !message && <SettingsState tone="loading">{t('modelSettings.slots.loading')}</SettingsState>
      )}
      <SettingsToolbar>
        {(['fast', 'verifier'] as const).map((slot) => (
          <Button
            key={slot}
            data-testid={`session-model-slot-${slot}-save`}
            disabled={disabled || busy || !slots?.[slot]}
            onClick={() => void apply(slot)}
          >
            {t('modelSettings.slots.saveSession', { slot })}
          </Button>
        ))}
      </SettingsToolbar>
      {message && (
        <SettingsState
          tone={message === 'sessionSaved' ? 'success' : 'error'}
          data-testid="session-model-slot-status"
        >
          {t(`modelSettings.slots.${message}`)}
        </SettingsState>
      )}
    </SettingsDetails>
  )
}
