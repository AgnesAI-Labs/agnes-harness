import {
  isAdminModelAdapter,
  ModelSlotsSnapshot,
  validateAgainst,
  type AdminModelAdapter,
} from '@agnes/protocol'
import {
  AuxiliaryModelFields,
  Button,
  SettingsCard,
  SettingsState,
  SettingsToolbar,
  type Translate,
} from '@agnes/web-ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import { PluginAdminApi } from '../admin/plugins/api.js'

export type ModelSlotsState = ModelSlotsSnapshot & { modelAdapters: AdminModelAdapter[]; canSave: boolean }
export async function modelSlotsSettings(
  input?: ModelSlotsSnapshot,
  signal?: AbortSignal,
): Promise<ModelSlotsState> {
  // The context establishes the existing read-only recovery state before reading configuration.
  await PluginAdminApi.context()
  const response = await fetch('/admin/api/model-slots', {
    credentials: 'same-origin',
    cache: 'no-store',
    ...(signal ? { signal } : {}),
    ...(input
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }
      : {}),
  })
  const value: unknown = await response.json()
  if (
    !response.ok ||
    !value ||
    typeof value !== 'object' ||
    !('revision' in value) ||
    !('slots' in value) ||
    !validateAgainst(ModelSlotsSnapshot, { revision: value.revision, slots: value.slots }).ok ||
    !('modelAdapters' in value) ||
    !Array.isArray(value.modelAdapters) ||
    value.modelAdapters.length > 4096 ||
    !value.modelAdapters.every(isAdminModelAdapter) ||
    !('canSave' in value) ||
    typeof value.canSave !== 'boolean'
  )
    throw new Error('Model slots unavailable')
  return value as ModelSlotsState
}
export function modelSlotOptions(state: ModelSlotsState) {
  return [
    ...new Map(
      state.modelAdapters.flatMap((adapter) =>
        adapter.models.flatMap((model) =>
          model.route
            ? [
                [
                  JSON.stringify([model.route, model.id]),
                  { route: model.route, id: model.id, label: model.label ?? model.route },
                ] as const,
              ]
            : [],
        ),
      ),
    ).values(),
  ]
}
export function ModelSlotsPanel({ t }: { t: Translate }) {
  const [state, setState] = useState<ModelSlotsState>()
  const [busy, setBusy] = useState(true)
  const lifetime = useRef<AbortController>()
  const [message, setMessage] = useState('')
  const load = useCallback(async (signal?: AbortSignal) => {
    setBusy(true)
    try {
      const next = await modelSlotsSettings(undefined, signal)
      if (!signal?.aborted) {
        setState(next)
        setMessage('')
      }
    } catch {
      if (!signal?.aborted) setMessage('failed')
    } finally {
      if (!signal?.aborted) setBusy(false)
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    void load(controller.signal)
    return () => controller.abort()
  }, [load])
  async function save() {
    if (!state || !state.canSave || busy) return
    setBusy(true)
    try {
      const next = await modelSlotsSettings(
        { revision: state.revision, slots: state.slots },
        lifetime.current?.signal,
      )
      if (lifetime.current?.signal.aborted) return
      setState(next)
      setMessage('saved')
      window.dispatchEvent(new Event('agnes:model-slots-changed'))
    } catch {
      if (!lifetime.current?.signal.aborted) setMessage('failed')
    } finally {
      if (!lifetime.current?.signal.aborted) setBusy(false)
    }
  }
  return (
    <SettingsCard
      id="auxiliary-models"
      tabIndex={-1}
      title={t('modelSettings.slots.title')}
      description={t('modelSettings.slots.help')}
      data-testid="auxiliary-models"
    >
      {state ? (
        <AuxiliaryModelFields
          slots={state.slots}
          models={modelSlotOptions(state)}
          disabled={!state.canSave || busy}
          t={t}
          onChange={(slot, target) => {
            setState((current) =>
              current ? { ...current, slots: { ...current.slots, [slot]: target } } : current,
            )
            setMessage('')
          }}
        />
      ) : (
        !message && <SettingsState tone="loading">{t('modelSettings.slots.loading')}</SettingsState>
      )}
      <SettingsToolbar>
        <Button
          data-testid="model-slots-reload"
          disabled={busy}
          onClick={() => void load(lifetime.current?.signal)}
        >
          {t('modelSettings.slots.reload')}
        </Button>
        <Button
          data-testid="model-slots-save"
          disabled={!state?.canSave || busy}
          loading={busy}
          onClick={() => void save()}
        >
          {t('modelSettings.slots.save')}
        </Button>
      </SettingsToolbar>
      {message && (
        <SettingsState tone={message === 'saved' ? 'success' : 'error'} data-testid="model-slots-status">
          {t(`modelSettings.slots.${message}`)}
        </SettingsState>
      )}
    </SettingsCard>
  )
}
