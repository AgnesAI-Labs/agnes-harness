import {
  type AdminModelAdapter,
  isAdminModelAdapter,
  ModelSlotsSnapshot,
  validateAgainst,
} from '@agnes/protocol'
import {
  AuxiliaryModelFields,
  Banner,
  Button,
  Loadable,
  reportSuccess,
  SettingsAdvanced,
  SettingsState,
  type Translate,
} from '@agnes/web-ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import { PluginAdminApi } from '../admin/plugins/api.js'

/** A save refused because the settings changed elsewhere since they were read. */
class ModelSlotsConflict extends Error {}

export type ModelSlotsState = ModelSlotsSnapshot & { canSave: boolean }
export type ModelSlotCatalog = { modelAdapters: AdminModelAdapter[] }
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
  // 409 on a save: the revision this page read is no longer the saved one.
  if (input && response.status === 409) throw new ModelSlotsConflict('Model slots changed elsewhere')
  const value: unknown = await response.json()
  if (
    !response.ok ||
    !value ||
    typeof value !== 'object' ||
    !('revision' in value) ||
    !('slots' in value) ||
    !validateAgainst(ModelSlotsSnapshot, {
      revision: value.revision,
      slots: value.slots,
      ...('auto' in value && value.auto !== undefined ? { auto: value.auto } : {}),
    }).ok ||
    !('canSave' in value) ||
    typeof value.canSave !== 'boolean'
  )
    throw new Error('Model slots unavailable')
  return value as ModelSlotsState
}
/** Options are independent of the saved settings, including after a save. */
export async function modelSlotsCatalog(signal?: AbortSignal): Promise<ModelSlotCatalog> {
  const response = await fetch('/admin/api/model-adapters', {
    credentials: 'same-origin',
    cache: 'no-store',
    ...(signal ? { signal } : {}),
  })
  const value: unknown = await response.json()
  if (
    !response.ok ||
    !value ||
    typeof value !== 'object' ||
    !('modelAdapters' in value) ||
    !Array.isArray(value.modelAdapters) ||
    value.modelAdapters.length > 4096 ||
    !value.modelAdapters.every(isAdminModelAdapter)
  )
    throw new Error('Model options unavailable')
  return value as ModelSlotCatalog
}
/** The saved accounts, as far as naming a model needs them. */
export type ModelSlotAccount = Readonly<{
  route: string
  label: string
  models?: readonly Readonly<{ id: string; name?: string }>[]
}>
/**
 * One option per route and model. A route is an internal id (`account-acct-…`), so each option also
 * carries what a person calls it: the account's name and the model's display name.
 */
export function modelSlotOptions(state: ModelSlotCatalog, accounts: readonly ModelSlotAccount[] = []) {
  const byRoute = new Map(accounts.map((account) => [account.route, account]))
  return [
    ...new Map(
      state.modelAdapters.flatMap((adapter) =>
        // A payload-only adapter takes no messages, so none of its models can fill a slot a
        // conversation reads. The catalog leaves them out; this does not rely on that alone.
        (adapter.capabilities.payloadOnly === true ? [] : adapter.models).flatMap((model) => {
          if (!model.route) return []
          const account = byRoute.get(model.route)
          const name = account?.models?.find((entry) => entry.id === model.id)?.name
          return [
            [
              JSON.stringify([model.route, model.id]),
              {
                route: model.route,
                id: model.id,
                label: account?.label ?? model.label ?? adapter.label ?? model.route,
                ...(name ? { name } : {}),
              },
            ] as const,
          ]
        }),
      ),
    ).values(),
  ]
}
export function ModelSlotsPanel({
  t,
  accounts = [],
}: {
  t: Translate
  accounts?: readonly ModelSlotAccount[]
}) {
  const [state, setState] = useState<ModelSlotsState>()
  const [busy, setBusy] = useState(true)
  const [catalog, setCatalog] = useState<ModelSlotCatalog>()
  const [optionsState, setOptionsState] = useState<'loading' | 'failed' | 'ready'>('loading')
  const lifetime = useRef<AbortController>()
  const [message, setMessage] = useState<'' | 'failed' | 'conflict'>('')
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
  const loadOptions = useCallback(async (signal: AbortSignal) => {
    setOptionsState('loading')
    try {
      const next = await modelSlotsCatalog(signal)
      if (!signal.aborted) {
        setCatalog(next)
        setOptionsState('ready')
      }
    } catch {
      if (!signal.aborted) setOptionsState('failed')
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    void load(controller.signal)
    void loadOptions(controller.signal)
    return () => controller.abort()
  }, [load, loadOptions])
  /** A choice is saved as it is made: the whole document, at the revision it was read at. */
  async function save(slots: ModelSlotsState['slots']) {
    if (!state?.canSave || busy) return
    // The choice shows at once and stays if the save is refused, so nothing has to be picked twice.
    setState({ ...state, slots })
    setMessage('')
    setBusy(true)
    try {
      const next = await modelSlotsSettings({ revision: state.revision, slots }, lifetime.current?.signal)
      if (lifetime.current?.signal.aborted) return
      setState(next)
      reportSuccess('model-slots', t('modelSettings.slots.saved'))
      window.dispatchEvent(new Event('agnes:model-slots-changed'))
    } catch (cause) {
      if (!lifetime.current?.signal.aborted)
        setMessage(cause instanceof ModelSlotsConflict ? 'conflict' : 'failed')
    } finally {
      if (!lifetime.current?.signal.aborted) setBusy(false)
    }
  }
  const models = optionsState === 'ready' && catalog ? modelSlotOptions(catalog, accounts) : []
  const unavailableLabel = t(
    `modelSettings.slots.${optionsState === 'loading' ? 'checkingAvailability' : optionsState === 'failed' ? 'availabilityUnknown' : 'unavailable'}`,
  )
  const named = (target: { route: string; model: string } | null | undefined, chosen = true) => {
    if (!target) return undefined
    const option = models.find((model) => model.route === target.route && model.id === target.model)
    // Only a completed catalog can establish that a saved model is unavailable.
    if (!option && chosen) return `${target.model} · ${unavailableLabel}`
    return option?.name ?? target.model
  }
  // While the fast slot is unset the backend follows the default account and says which model that is.
  const automatic = state?.auto?.fast && !state.slots.fast ? named(state.auto.fast, false) : undefined
  const fastUnset = automatic
    ? t('modelSettings.slots.auto', { model: automatic })
    : t('modelSettings.slots.unset')
  return (
    <SettingsAdvanced
      id="auxiliary-models"
      tabIndex={-1}
      title={t('modelSettings.slots.title')}
      data-testid="auxiliary-models"
      summary={
        state
          ? `${t('modelSettings.slots.fast')} ${named(state.slots.fast) ?? fastUnset} · ${t('modelSettings.slots.verifier')} ${named(state.slots.verifier) ?? t('modelSettings.slots.unset')}`
          : undefined
      }
    >
      <p>{t('modelSettings.slots.help')}</p>
      {optionsState === 'loading' && (
        <SettingsState tone="loading" data-testid="model-slots-options-loading">
          {t('modelSettings.slots.optionsLoading')}
        </SettingsState>
      )}
      {optionsState === 'failed' && (
        <Banner
          tone="error"
          data-testid="model-slots-options-error"
          action={
            <Button
              size="small"
              onClick={() => lifetime.current && void loadOptions(lifetime.current.signal)}
            >
              {t('modelSettings.slots.reload')}
            </Button>
          }
        >
          {t('modelSettings.slots.optionsFailed')}
        </Banner>
      )}
      {state ? (
        <AuxiliaryModelFields
          slots={state.slots}
          models={models}
          disabled={!state.canSave || busy}
          t={t}
          unsetLabel={{ fast: fastUnset }}
          unavailableLabel={unavailableLabel}
          onChange={(slot, target) => {
            const { [slot]: _replaced, ...rest } = state.slots
            // An emptied fast slot goes back to following the default account; the verifier is
            // only ever what was chosen.
            void save(target || slot === 'verifier' ? { ...rest, [slot]: target } : rest)
          }}
        />
      ) : (
        !message && <Loadable loading hasData={false} shape="rows" />
      )}
      {(message === 'failed' || message === 'conflict') && (
        <Banner
          tone="error"
          data-testid="model-slots-status"
          action={
            <Button
              size="small"
              data-testid="model-slots-reload"
              disabled={busy}
              onClick={() => void load(lifetime.current?.signal)}
            >
              {t('modelSettings.slots.reload')}
            </Button>
          }
        >
          {t(`modelSettings.slots.${message}`)}
        </Banner>
      )}
    </SettingsAdvanced>
  )
}
/** The panel for one saved configuration: a new revision remounts it, and its accounts name the models. */
export function modelSlotsPanel(
  configuration: { revision?: number; accounts?: readonly ModelSlotAccount[] } | undefined,
  t: Translate,
) {
  return <ModelSlotsPanel key={configuration?.revision ?? 0} t={t} accounts={configuration?.accounts ?? []} />
}
