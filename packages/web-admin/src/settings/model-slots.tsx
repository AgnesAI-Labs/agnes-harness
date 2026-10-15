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
  SettingsAdvanced,
  SettingsItem,
  SettingsState,
  type Translate,
} from '@agnes/web-ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import { PluginAdminApi } from '../admin/plugins/api.js'

/** A save refused because the settings changed elsewhere since they were read. */
class ModelSlotsConflict extends Error {}

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
export function modelSlotOptions(state: ModelSlotsState, accounts: readonly ModelSlotAccount[] = []) {
  const byRoute = new Map(accounts.map((account) => [account.route, account]))
  return [
    ...new Map(
      state.modelAdapters.flatMap((adapter) =>
        adapter.models.flatMap((model) => {
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
  const lifetime = useRef<AbortController>()
  const [message, setMessage] = useState<'' | 'saved' | 'failed' | 'conflict'>('')
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
  /** A choice is saved as it is made: the whole document, at the revision it was read at. */
  async function save(slots: ModelSlotsState['slots']) {
    if (!state || !state.canSave || busy) return
    // The choice shows at once and stays if the save is refused, so nothing has to be picked twice.
    setState({ ...state, slots })
    setMessage('')
    setBusy(true)
    try {
      const next = await modelSlotsSettings({ revision: state.revision, slots }, lifetime.current?.signal)
      if (lifetime.current?.signal.aborted) return
      setState(next)
      setMessage('saved')
      window.dispatchEvent(new Event('agnes:model-slots-changed'))
    } catch (cause) {
      if (!lifetime.current?.signal.aborted)
        setMessage(cause instanceof ModelSlotsConflict ? 'conflict' : 'failed')
    } finally {
      if (!lifetime.current?.signal.aborted) setBusy(false)
    }
  }
  const models = state ? modelSlotOptions(state, accounts) : []
  const named = (target: { route: string; model: string } | null | undefined, chosen = true) => {
    if (!target) return undefined
    const option = models.find((model) => model.route === target.route && model.id === target.model)
    // A chosen slot on a route nothing serves any more is left empty at session start, so say so.
    if (!option && chosen) return `${target.model} · ${t('modelSettings.slots.unavailable')}`
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
      {state ? (
        <AuxiliaryModelFields
          slots={state.slots}
          models={models}
          disabled={!state.canSave || busy}
          t={t}
          unsetLabel={{ fast: fastUnset }}
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
      {message === 'saved' && (
        <SettingsState tone="success" data-testid="model-slots-status">
          {t('modelSettings.slots.saved')}
        </SettingsState>
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
  if (configuration?.accounts?.length === 0)
    return (
      <SettingsItem
        label={t('modelSettings.slots.title')}
        aria-disabled="true"
        className="config-auxiliary-disabled"
      >
        <span>{t('accounts.auxiliaryEmpty')}</span>
      </SettingsItem>
    )
  return <ModelSlotsPanel key={configuration?.revision ?? 0} t={t} accounts={configuration?.accounts ?? []} />
}
