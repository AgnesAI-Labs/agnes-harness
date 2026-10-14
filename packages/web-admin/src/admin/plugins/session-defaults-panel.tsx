import {
  type AdminLoop,
  type AdminModelAdapter,
  defaultLoop,
  defaultModelAdapter,
  type RuntimeAdminSnapshot,
  type SessionDefaultsSnapshot,
} from '@agnes/protocol'
import {
  Banner,
  Button,
  Select,
  SettingsDetails,
  SettingsFooter,
  SettingsGroup,
  SettingsItem,
  SettingsState,
  SettingsTechnicalDetails,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import { choiceName, type ResolvedComposition, readComposition } from '../../settings/choices.js'
import { SETTINGS_NAMESPACE, settingsCatalog } from '../../settings/locales.js'
import type { PluginAdminApi } from './api.js'
import { identity, label } from './composition-labels.js'
import type { Text } from './control-panel-types.js'

type Provider = RuntimeAdminSnapshot['providers'][number]
/** Slots a new session fills beside its loop and model adapter, in the order the page lists them. */
const EVERYDAY_SLOTS = ['memory', 'child-agent'] as const
const MORE_SLOTS = ['compaction', 'sandbox', 'tool-runtime', 'tool-policy'] as const

/**
 * What a new session starts with: one row per choice, its options the providers installed now. The
 * host stores a default for the loop, the model adapter and the permission preset; the other slots
 * follow the profile, so their rows state what is in effect.
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
    presets: readonly string[]
    adapters: readonly AdminModelAdapter[]
    snapshot: SessionDefaultsSnapshot
  }>()
  const [preset, setPreset] = useState('')
  const [loop, setLoop] = useState('')
  const [adapter, setAdapter] = useState('')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  // What the host holds: the form is saved only while it differs from this.
  const [stored, setStored] = useState({ preset: '', loop: '', adapter: '', model: '' })
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is an explicit request to reread host catalogs.
  useEffect(() => {
    let current = true
    setCatalog(undefined)
    setStatus('')
    setError('')
    if (!api)
      return () => {
        current = false
      }
    setBusy(true)
    Promise.all([api.loops(), api.modelAdapters(), api.composition().catch(() => undefined)])
      .then(([loops, adapters, resolved]) => {
        if (current) setComposition(readComposition(resolved))
        if (!current) return
        setCatalog({
          presets: loops.presets ?? [],
          loops: loops.loops,
          adapters: adapters.modelAdapters,
          snapshot: loops,
        })
        setPreset(loops.defaults.preset ?? '')
        const chosenLoop = defaultLoop(loops.defaults)
        const chosenAdapter = defaultModelAdapter(loops.defaults)
        setLoop(chosenLoop ? identity(chosenLoop) : '')
        setAdapter(chosenAdapter ? identity(chosenAdapter) : '')
        setModel(chosenAdapter?.model ?? '')
        setStored({
          preset: loops.defaults.preset ?? '',
          loop: chosenLoop ? identity(chosenLoop) : '',
          adapter: chosenAdapter ? identity(chosenAdapter) : '',
          model: chosenAdapter?.model ?? '',
        })
      })
      .catch(() => {
        if (current) setError('defaults.unavailable')
      })
      .finally(() => {
        if (current) setBusy(false)
      })
    return () => {
      current = false
    }
  }, [api, reload])
  const selectedLoop = catalog?.loops.find((entry) => identity(entry) === loop)
  const selectedAdapter = catalog?.adapters.find((entry) => identity(entry) === adapter)
  const valid =
    (!preset || !!catalog?.presets.includes(preset)) &&
    (!loop || !!selectedLoop) &&
    (!adapter || !!selectedAdapter?.models.some((entry) => entry.id === model))
  const dirty =
    preset !== stored.preset || loop !== stored.loop || adapter !== stored.adapter || model !== stored.model
  async function save() {
    if (!catalog || !api || !canSave || !valid || !dirty || busy) return
    setBusy(true)
    setError('')
    setStatus('')
    try {
      const snapshot = await api.saveDefaults({
        revision: catalog.snapshot.revision,
        defaults: {
          ...(preset ? { preset } : {}),
          ...(selectedLoop || selectedAdapter
            ? {
                providers: {
                  ...(selectedLoop
                    ? { loop: { provider: selectedLoop.id, version: selectedLoop.version } }
                    : {}),
                  ...(selectedAdapter
                    ? { 'model-adapter': { provider: selectedAdapter.id, version: selectedAdapter.version } }
                    : {}),
                },
              }
            : {}),
          ...(selectedAdapter ? { model } : {}),
        },
      })
      setCatalog({ ...catalog, snapshot })
      setStored({ preset, loop, adapter, model })
      setStatus('defaults.saved')
    } catch {
      setError('defaults.save-failed')
    } finally {
      setBusy(false)
    }
  }
  const storedLoop = catalog && defaultLoop(catalog.snapshot.defaults)
  const storedAdapter = catalog && defaultModelAdapter(catalog.snapshot.defaults)
  const stale =
    (!!preset && !catalog?.presets.includes(preset)) ||
    (!!loop && !selectedLoop) ||
    (!!adapter && !selectedAdapter) ||
    (!!model && !selectedAdapter?.models.some((entry) => entry.id === model))
  const edit = (apply: () => void) => {
    setStatus('')
    apply()
  }
  // What "follow the default" resolves to right now, by name only.
  const follow = (name?: string) =>
    name ? `${t('defaults.configured')} · ${name}` : t('defaults.configured')
  const resolvedLoop =
    composition &&
    (catalog?.loops.find((entry) => identity(entry) === identity(composition.loop)) ?? composition.loop)
  // The loop in effect: the chosen one, or the one the default resolves to.
  const effectiveLoop = selectedLoop ?? (catalog?.loops.length === 1 ? catalog.loops[0] : undefined)
  const sourceLayer =
    composition &&
    choiceText(
      composition.source.layer === 'admin'
        ? 'choiceSourceAdmin'
        : composition.source.layer === 'default'
          ? 'choiceSourceBuiltin'
          : 'choiceSourceProfile',
    )
  const unavailable = (value: string) => ({
    value,
    label: `${value} · ${t('defaults.unavailable-choice')}`,
    disabled: true,
  })
  const providerName = (entry: Provider) => {
    const name = choiceText(`providerName.${entry.id}`)
    return name === `providerName.${entry.id}` ? entry.id : name
  }
  const slotRow = (kind: string) => {
    const entries = providers.filter((entry) => entry.kind === kind)
    const active = entries.find((entry) => entry.active) ?? entries[0]
    if (!active) return null
    return (
      <SettingsItem
        key={kind}
        data-testid={`session-default-slot-${kind}`}
        label={choiceText(`provider.${kind}`)}
        description={entries.length > 1 ? t('defaults.slot-fixed') : undefined}
      >
        {entries.length > 1 ? (
          <Select<string>
            aria-label={choiceText(`provider.${kind}`)}
            value={identity(active)}
            disabled
            popupMatchSelectWidth={false}
            options={entries.map((entry) => ({ value: identity(entry), label: providerName(entry) }))}
          />
        ) : (
          <span>{providerName(active)}</span>
        )}
      </SettingsItem>
    )
  }
  const moreSlots = MORE_SLOTS.filter((kind) => providers.some((entry) => entry.kind === kind))
  return (
    <div className="agnes-settings-stack plugin-session-defaults" aria-busy={busy}>
      {error && (
        <Banner
          tone="error"
          role="alert"
          action={
            <Button size="small" onClick={() => setReload((value) => value + 1)} disabled={!api || busy}>
              {t('defaults.reload')}
            </Button>
          }
        >
          {t(error)}
        </Banner>
      )}
      {stale && (
        <Banner tone="warning" role="alert">
          {t('defaults.stale')}
        </Banner>
      )}
      {busy && !catalog && <SettingsState tone="loading" />}
      {catalog && (
        <>
          <SettingsGroup
            role="group"
            aria-label={t('defaults.title')}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.defaultPrevented) return
              if (!(event.target instanceof HTMLInputElement)) return
              event.preventDefault()
              event.stopPropagation()
              void save()
            }}
          >
            <SettingsItem label={t('defaults.loop')} description={t('defaults.loop-hint')}>
              {catalog.loops.length === 1 && !stale ? (
                <span data-testid="admin-default-loop-readonly">
                  {choiceName(catalog.loops[0] ?? { id: '' }, choiceText)}
                </span>
              ) : (
                <Select<string>
                  aria-label={t('defaults.loop')}
                  value={loop}
                  disabled={busy || !canSave}
                  className="agent-picker-select"
                  popupMatchSelectWidth={false}
                  onChange={(value) => edit(() => setLoop(value))}
                  options={[
                    { value: '', label: follow(resolvedLoop && choiceName(resolvedLoop, choiceText)) },
                    ...(loop && !selectedLoop && storedLoop
                      ? [
                          {
                            value: loop,
                            label: `${label(storedLoop)} · ${t('defaults.unavailable-choice')}`,
                            disabled: true,
                          },
                        ]
                      : []),
                    ...catalog.loops.map((entry) => ({
                      value: identity(entry),
                      label: choiceName(entry, choiceText),
                    })),
                  ]}
                />
              )}
            </SettingsItem>
            {EVERYDAY_SLOTS.map(slotRow)}
            <SettingsItem label={t('defaults.adapter')} description={t('defaults.adapter-hint')}>
              <Select<string>
                aria-label={t('defaults.adapter')}
                value={adapter}
                disabled={busy || !canSave}
                popupMatchSelectWidth={false}
                onChange={(value) =>
                  edit(() => {
                    setAdapter(value)
                    setModel('')
                  })
                }
                options={[
                  { value: '', label: follow() },
                  ...(adapter && !selectedAdapter && storedAdapter
                    ? [
                        {
                          value: adapter,
                          label: `${label(storedAdapter)} · ${t('defaults.unavailable-choice')}`,
                          disabled: true,
                        },
                      ]
                    : []),
                  ...catalog.adapters.map((entry) => ({
                    value: identity(entry),
                    label: entry.label ?? entry.id,
                  })),
                ]}
              />
            </SettingsItem>
            {selectedAdapter && (
              <SettingsItem label={t('defaults.model')}>
                <Select<string>
                  aria-label={t('defaults.model')}
                  value={model || null}
                  disabled={busy || !canSave}
                  popupMatchSelectWidth={false}
                  onChange={(value) => edit(() => setModel(value))}
                  options={selectedAdapter.models.map((entry) => ({
                    value: entry.id,
                    label: entry.label ?? entry.id,
                  }))}
                />
              </SettingsItem>
            )}
            {(catalog.presets.length > 0 || preset) && (
              <SettingsItem label={t('defaults.preset')} description={t('defaults.preset-hint')}>
                {catalog.presets.length === 1 && (!preset || preset === catalog.presets[0]) ? (
                  <span data-testid="admin-default-preset-readonly">
                    {choiceName({ id: catalog.presets[0] ?? '' }, choiceText)}
                  </span>
                ) : (
                  <Select<string>
                    aria-label={t('defaults.preset')}
                    value={preset}
                    disabled={busy || !canSave}
                    popupMatchSelectWidth={false}
                    onChange={(value) => edit(() => setPreset(value))}
                    options={[
                      {
                        value: '',
                        label: follow(
                          composition?.preset
                            ? choiceName({ id: composition.preset }, choiceText)
                            : undefined,
                        ),
                      },
                      ...(preset && !catalog.presets.includes(preset) ? [unavailable(preset)] : []),
                      ...catalog.presets.map((value) => ({
                        value,
                        label: choiceName({ id: value }, choiceText),
                      })),
                    ]}
                  />
                )}
              </SettingsItem>
            )}
            {moreSlots.length > 0 && (
              <SettingsDetails title={t('defaults.more-slots')} data-testid="session-default-more-slots">
                {moreSlots.map(slotRow)}
              </SettingsDetails>
            )}
          </SettingsGroup>
          <SettingsTechnicalDetails data-testid="session-defaults-technical">
            <dl>
              <dt>{t('defaults.source')}</dt>
              <dd>
                {composition
                  ? `${sourceLayer} · ${composition.source.name}`
                  : choiceText('choiceSourceUnknown')}
              </dd>
              {effectiveLoop && (
                <>
                  <dt>{t('defaults.loop-id')}</dt>
                  <dd>
                    <code>
                      {effectiveLoop.id} {effectiveLoop.version}
                    </code>
                  </dd>
                  <dt>{t('defaults.loop-package')}</dt>
                  <dd>
                    <code>{effectiveLoop.sourcePackage}</code>
                  </dd>
                  {effectiveLoop.capabilities.length > 0 && (
                    <>
                      <dt>{t('defaults.loop-capabilities')}</dt>
                      <dd>{effectiveLoop.capabilities.join(', ')}</dd>
                    </>
                  )}
                </>
              )}
              {selectedAdapter && (
                <>
                  <dt>{t('defaults.adapter-id')}</dt>
                  <dd>
                    <code>
                      {selectedAdapter.id} {selectedAdapter.version}
                    </code>
                  </dd>
                </>
              )}
              {preset && (
                <>
                  <dt>{t('defaults.preset-id')}</dt>
                  <dd>
                    <code>{preset}</code>
                  </dd>
                </>
              )}
            </dl>
          </SettingsTechnicalDetails>
          <SettingsFooter status={status ? t(status) : undefined} data-testid="session-defaults-footer">
            <Button
              appearance="primary"
              data-testid="session-defaults-save"
              onClick={() => void save()}
              loading={busy && dirty}
              disabled={!dirty || !valid || !canSave || busy}
            >
              {t('defaults.save')}
            </Button>
          </SettingsFooter>
        </>
      )}
    </div>
  )
}
