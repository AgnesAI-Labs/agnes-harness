import {
  type AdminLoop,
  type AdminModelAdapter,
  defaultLoop,
  defaultModelAdapter,
  type RuntimeAdminSnapshot,
  type SessionDefaultsSnapshot,
} from '@agnes/protocol'
import {
  fallbackT,
  reportSuccess,
  Select,
  SettingsBlock,
  SettingsChoice,
  SettingsDrill,
  SettingsGroup,
  SettingsItem,
  SettingsTag,
  trackPageRequest,
  useAutosave,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import { choiceName, type ResolvedComposition, readComposition } from '../../settings/choices.js'
import { SETTINGS_NAMESPACE, settingsCatalog } from '../../settings/locales.js'
import { AdminApiError, type PluginAdminApi } from './api.js'
import { identity } from './composition-labels.js'
import type { Text } from './control-panel-types.js'

type Provider = RuntimeAdminSnapshot['providers'][number]
/** Slots a new session fills beside its loop and model adapter, in the order the page lists them. */
const EVERYDAY_SLOTS = ['memory', 'child-agent'] as const
const MORE_SLOTS = ['compaction', 'sandbox', 'tool-runtime', 'tool-policy'] as const
type Choice = { loop: string; adapter: string; model: string }
const sameChoice = (a: Choice, b: Choice) =>
  a.loop === b.loop && a.adapter === b.adapter && a.model === b.model

/** A payload-only adapter takes no messages, so a new session cannot start on it. */
export const defaultAdapterChoices = (adapters: readonly AdminModelAdapter[]): AdminModelAdapter[] =>
  adapters.filter((entry) => entry.capabilities.payloadOnly !== true)

/**
 * New session defaults: what a new session starts with, one row per choice, each saved as soon as it is picked.
 * The host stores the loop, the model adapter and its model; the permission and the preset are
 * chosen under Permissions and security and kept as they are. Memory, child-agent and the other slots follow the profile, so their
 * rows state what is in effect. A saved choice the catalog no longer has is marked on its row.
 */
export function SessionDefaultsPanel({
  api,
  canSave,
  t,
  providers = [],
}: {
  api: PluginAdminApi | undefined
  canSave: boolean
  t: Text
  /** The runtime catalog's providers; without it only the saved defaults are listed. */
  providers?: readonly Provider[] | undefined
}) {
  const { t: choiceText } = useUiText(SETTINGS_NAMESPACE, settingsCatalog)
  const [composition, setComposition] = useState<ResolvedComposition>()
  const [catalog, setCatalog] = useState<{
    loops: readonly AdminLoop[]
    adapters: readonly AdminModelAdapter[]
    snapshot: SessionDefaultsSnapshot
  }>()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [reload, setReload] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is an explicit request to reread host catalogs.
  useEffect(() => {
    let current = true
    setFailed(false)
    if (!api)
      return () => {
        current = false
      }
    setBusy(true)
    trackPageRequest(
      Promise.all([api.loops(), api.modelAdapters(), api.composition().catch(() => undefined)]),
    )
      .then(([loops, adapters, resolved]) => {
        if (!current) return
        setComposition(readComposition(resolved))
        setCatalog({ loops: loops.loops, adapters: adapters.modelAdapters, snapshot: loops })
      })
      .catch(() => {
        if (current) setFailed(true)
      })
      .finally(() => {
        if (current) setBusy(false)
      })
    return () => {
      current = false
    }
  }, [api, reload])
  const storedLoop = catalog && defaultLoop(catalog.snapshot.defaults)
  const storedAdapter = catalog && defaultModelAdapter(catalog.snapshot.defaults)
  const stored: Choice | undefined = catalog && {
    loop: storedLoop ? identity(storedLoop) : '',
    adapter: storedAdapter ? identity(storedAdapter) : '',
    model: storedAdapter?.model ?? '',
  }
  const choice = useAutosave<Choice>({
    resourceKey: 'settings:session-defaults',
    onSaved: () => reportSuccess('session-defaults', fallbackT('ui.defaultsSaved')),
    stored,
    equal: sameChoice,
    save: async (next) => {
      if (!api || !catalog) throw new Error('not ready')
      const loop = catalog.loops.find((entry) => identity(entry) === next.loop)
      const adapter = catalog.adapters.find((entry) => identity(entry) === next.adapter)
      const { preset, permission } = catalog.snapshot.defaults
      const snapshot = await api
        .saveDefaults({
          revision: catalog.snapshot.revision,
          defaults: {
            // The permission and preset are chosen under Permissions and security; a save here keeps both.
            ...(preset ? { preset } : {}),
            ...(permission ? { permission } : {}),
            ...(loop || adapter
              ? {
                  providers: {
                    ...(loop ? { loop: { provider: loop.id, version: loop.version } } : {}),
                    ...(adapter
                      ? { 'model-adapter': { provider: adapter.id, version: adapter.version } }
                      : {}),
                  },
                }
              : {}),
            ...(adapter && next.model ? { model: next.model } : {}),
          },
        })
        .catch((error: unknown) => {
          // Saved elsewhere first: read the current defaults so Retry saves on their revision.
          if (error instanceof AdminApiError && error.details.code === 'CONFIG_REVISION_CONFLICT')
            setReload((count) => count + 1)
          throw error
        })
      setCatalog((known) => (known ? { ...known, snapshot } : known))
    },
  })
  const value = choice.value ?? { loop: '', adapter: '', model: '' }
  const selectedLoop = catalog?.loops.find((entry) => identity(entry) === value.loop)
  const selectedAdapter = catalog?.adapters.find((entry) => identity(entry) === value.adapter)
  const locked = busy || !canSave || !catalog
  const staleLoop = !!value.loop && !selectedLoop
  const staleAdapter = !!value.adapter && !selectedAdapter
  const staleModel =
    !!selectedAdapter && !!value.model && !selectedAdapter.models.some((m) => m.id === value.model)
  const resolvedLoop =
    composition &&
    (catalog?.loops.find((entry) => identity(entry) === identity(composition.loop)) ?? composition.loop)
  const loopName = (entry: AdminLoop | { id: string }) => choiceName(entry, choiceText)
  const source =
    composition &&
    choiceText(
      composition.source.layer === 'admin'
        ? 'choiceSourceAdmin'
        : composition.source.layer === 'default'
          ? 'choiceSourceBuiltin'
          : 'choiceSourceProfile',
    )
  const providerName = (entry: Provider) => {
    const name = choiceText(`providerName.${entry.id}`)
    return name === `providerName.${entry.id}` ? entry.id : name
  }
  const staleTag = <SettingsTag tone="warn">{t('defaults.stale-short')}</SettingsTag>
  const slotRow = (kind: string, fixedTag: boolean) => {
    const entries = providers.filter((entry) => entry.kind === kind)
    const active = entries.find((entry) => entry.active) ?? entries[0]
    if (!active) return null
    return (
      <SettingsItem
        key={kind}
        data-testid={`session-default-slot-${kind}`}
        label={fixedTag ? choiceText(`provider.${kind}`) : t(`defaults.slot.${kind}`)}
        info={entries.length > 1 ? t('defaults.slot-fixed') : undefined}
      >
        {entries.length > 1 && !fixedTag ? (
          <Select<string>
            aria-label={choiceText(`provider.${kind}`)}
            value={identity(active)}
            disabled
            popupMatchSelectWidth={false}
            options={entries.map((entry) => ({ value: identity(entry), label: providerName(entry) }))}
          />
        ) : (
          <span className="agnes-settings-value">
            {providerName(active)}
            {fixedTag && <SettingsTag tone="muted">{t('defaults.slot-profile')}</SettingsTag>}
          </span>
        )}
      </SettingsItem>
    )
  }
  const moreSlots = MORE_SLOTS.filter((kind) => providers.some((entry) => entry.kind === kind))
  const follow = (name?: string) =>
    name ? `${t('defaults.configured')} · ${name}` : t('defaults.configured')
  const set = (next: Partial<Choice>) => choice.set({ ...value, ...next })
  return (
    <SettingsBlock
      label={t('defaults.title')}
      className="plugin-session-defaults"
      data-testid="session-defaults"
      aria-busy={busy || choice.busy}
      failed={choice.failed}
      onRetry={choice.retry}
      state={failed ? 'error' : busy && !catalog ? 'loading' : undefined}
      onReload={() => setReload((count) => count + 1)}
    >
      {catalog && (
        <>
          <SettingsDrill
            id="session-loop"
            data-testid="session-default-loop"
            label={t('defaults.loop')}
            info={t('defaults.loop-hint')}
            value={
              <>
                {staleLoop && staleTag}
                {selectedLoop ? loopName(selectedLoop) : follow(resolvedLoop && loopName(resolvedLoop))}
              </>
            }
            description={t('defaults.loop-hint')}
          >
            <SettingsGroup
              role="radiogroup"
              aria-label={t('defaults.loop')}
              className="agnes-settings-choices"
            >
              <SettingsChoice
                type="radio"
                name="session-default-loop"
                value=""
                data-testid="session-loop-follow"
                checked={!value.loop}
                disabled={locked}
                onChange={() => set({ loop: '' })}
                label={follow(resolvedLoop && loopName(resolvedLoop))}
                hint={source && `${t('defaults.source')}: ${source}`}
              />
              {catalog.loops.map((entry) => (
                <SettingsChoice
                  key={identity(entry)}
                  type="radio"
                  name="session-default-loop"
                  value={identity(entry)}
                  data-testid={`session-loop-${entry.id}`}
                  checked={value.loop === identity(entry)}
                  disabled={locked}
                  onChange={() => set({ loop: identity(entry) })}
                  label={loopName(entry)}
                  hint={[
                    t('defaults.loop-from', { name: `${entry.sourcePackage} ${entry.version}` }),
                    entry.capabilities.length
                      ? t('defaults.loop-can', { list: entry.capabilities.join('、') })
                      : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                />
              ))}
            </SettingsGroup>
            {staleLoop && <p className="agnes-settings-note">{t('defaults.stale')}</p>}
            <p className="agnes-settings-note">
              {t('defaults.loop-source', {
                source: value.loop
                  ? choiceText('choiceSourceAdmin')
                  : (source ?? choiceText('choiceSourceProfile')),
              })}
            </p>
          </SettingsDrill>
          <SettingsItem label={t('defaults.model')}>
            {staleModel && staleTag}
            <Select<string>
              aria-label={t('defaults.model')}
              data-testid="session-default-model"
              value={selectedAdapter ? value.model || null : ''}
              disabled={locked || !selectedAdapter}
              popupMatchSelectWidth={false}
              onChange={(next) => set({ model: next })}
              options={
                selectedAdapter
                  ? selectedAdapter.models.map((entry) => ({
                      value: entry.id,
                      label: entry.label ?? entry.id,
                    }))
                  : [{ value: '', label: t('defaults.model-follow') }]
              }
            />
          </SettingsItem>
          {EVERYDAY_SLOTS.map((kind) => slotRow(kind, false))}
          <SettingsItem label={t('defaults.adapter')} info={t('defaults.adapter-hint')}>
            {staleAdapter && staleTag}
            <Select<string>
              aria-label={t('defaults.adapter')}
              data-testid="session-default-adapter"
              value={value.adapter}
              disabled={locked}
              popupMatchSelectWidth={false}
              onChange={(next) => {
                const adapter = catalog.adapters.find((entry) => identity(entry) === next)
                set({ adapter: next, model: adapter?.models[0]?.id ?? '' })
              }}
              options={[
                { value: '', label: follow() },
                ...(staleAdapter && storedAdapter
                  ? [
                      {
                        value: value.adapter,
                        label: `${storedAdapter.id} · ${t('defaults.unavailable-choice')}`,
                        disabled: true,
                      },
                    ]
                  : []),
                ...defaultAdapterChoices(catalog.adapters).map((entry) => ({
                  value: identity(entry),
                  label: entry.label ?? entry.id,
                })),
              ]}
            />
          </SettingsItem>
          {moreSlots.length > 0 && (
            <SettingsDrill
              id="session-slots"
              data-testid="session-default-more-slots"
              label={t('defaults.more-slots')}
              value={t('defaults.more-slots-value', { count: moreSlots.length })}
              description={t('defaults.more-slots-help')}
            >
              <SettingsBlock>{moreSlots.map((kind) => slotRow(kind, true))}</SettingsBlock>
            </SettingsDrill>
          )}
        </>
      )}
    </SettingsBlock>
  )
}
