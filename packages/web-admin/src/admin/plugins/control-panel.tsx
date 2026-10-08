import type {
  AdminLoop,
  AdminModelAdapter,
  PackageCatalogDescriptor,
  PackageInstalledDescriptor,
  PluginGenerationStatus,
  SessionDefaultsSnapshot,
} from '@agnes/protocol'
import type { PluginRuntimeState } from '@agnes/web-foundation/client-modules/runtime-status'
import {
  ADMIN_LIST_LOCALE_NAMESPACE,
  adminListLocaleCatalog,
  Badge,
  Button,
  Field,
  Popover,
  Select,
  SettingsCard,
  SettingsInput,
  type StateTone,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import { ChoiceLabel, choiceName, type ResolvedComposition, readComposition } from '../../settings/choices.js'
import { SETTINGS_NAMESPACE, settingsCatalog } from '../../settings/locales.js'
import { SessionToolsPanel } from '../../settings/session-tools.js'
import type { PluginAdminApi } from './api.js'

export const PLUGIN_KINDS = ['tool', 'loop', 'model-adapter', 'mcp', 'skills', 'ui', 'bundle'] as const
export type PluginKind = (typeof PLUGIN_KINDS)[number]
type Text = (key: string, params?: Record<string, string | number>) => string
type Plugin = PackageInstalledDescriptor | PackageCatalogDescriptor

/** Keep author declarations and host/browser observations separate. */
export function pluginStates(
  item: Plugin,
  runtime?: PluginRuntimeState,
): readonly { key: string; tone: StateTone }[] {
  if (!('desired' in item)) return []
  const states: { key: string; tone: StateTone }[] = [{ key: 'installed', tone: 'off' }]
  if (item.desired === 'enabled') states.push({ key: 'enabled', tone: 'ok' })
  if (item.actual === 'running') states.push({ key: 'active', tone: 'ok' })
  if (item.draining === true) states.push({ key: 'draining', tone: 'warn' })
  if (item.actual === 'restart-required') states.push({ key: 'restart-required', tone: 'warn' })
  if (item.actual === 'failed' || runtime?.phase === 'failed') states.push({ key: 'failed', tone: 'bad' })
  return states
}
export function PluginBadges({
  item,
  runtime,
  t,
}: {
  item: Plugin
  runtime?: PluginRuntimeState | undefined
  t: Text
}) {
  return (
    <div className="agnes-settings-actions">
      {(item.kinds ?? []).map((kind) => (
        <Badge key={`kind:${kind}`}>{t(`kind.${kind}`)}</Badge>
      ))}
      {pluginStates(item, runtime).map(({ key, tone }) =>
        key === 'draining' ? (
          <Popover key={key} content={t('drain.tooltip')} trigger={['hover', 'focus']}>
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focus exposes the old-version explanation to keyboard users. */}
            <span role="note" tabIndex={0} aria-label={t('state.draining') + '. ' + t('drain.tooltip')}>
              <Badge tone="off">{t('state.draining')}</Badge>
            </span>
          </Popover>
        ) : (
          <Badge key={`state:${key}`} tone={tone}>
            {t(`state.${key}`)}
          </Badge>
        ),
      )}
    </div>
  )
}
/** Runtime defaults/development packages have no inventory row; their pins belong in diagnostics. */
export function GenerationDrainSummary({
  status,
  installed,
  t,
  nameOf,
}: {
  status: PluginGenerationStatus | undefined
  installed: readonly PackageInstalledDescriptor[]
  t: Text
  nameOf?: (id: string) => string
}) {
  const { t: names } = useUiText(ADMIN_LIST_LOCALE_NAMESPACE, adminListLocaleCatalog)
  const displayName = (id: string) => {
    const key = `row.name.${id}`
    const name = names(key)
    return name !== key ? name : (nameOf?.(id) ?? id.split('/').at(-1))
  }
  const plugins =
    status?.plugins.filter(
      (plugin) => plugin.drainingSessions > 0 && installed.some((item) => item.id === plugin.id),
    ) ?? []
  if (!plugins.length) return null
  const generations =
    status?.generations.filter(
      (generation) =>
        generation.state === 'draining' &&
        generation.boundSessions > 0 &&
        generation.packages.some((item) => plugins.some((plugin) => plugin.id === item.id)),
    ) ?? []
  // A session binds one generation; summing per-plugin counts would count it repeatedly.
  const sessions = generations.reduce((sum, generation) => sum + generation.boundSessions, 0)
  return (
    <div className="plugin-drain-notice">
      <p data-testid="plugin-drain-summary">
        {t(sessions ? 'drain.summary' : 'drain.summaryUnknown', {
          plugins: plugins.length,
          sessions,
          pluginNoun: t(plugins.length === 1 ? 'drain.pluginOne' : 'drain.pluginMany'),
          sessionNoun: t(sessions === 1 ? 'drain.sessionOne' : 'drain.sessionMany'),
        })}
      </p>
      <details data-testid="plugin-drain-details">
        <summary>{t('drain.details')}</summary>
        <ul>
          {plugins.map((plugin) => (
            <li key={plugin.id}>
              <strong>{displayName(plugin.id)}</strong>
              <ul>
                {generations.flatMap((generation) =>
                  generation.packages
                    .filter((item) => item.id === plugin.id)
                    .map((item) => (
                      <li key={generation.id}>
                        {t('drain.version', { version: item.version, sessions: generation.boundSessions })}
                        <br />
                        <code>
                          {plugin.id} · {generation.id}
                        </code>
                      </li>
                    )),
                )}
              </ul>
            </li>
          ))}
        </ul>
      </details>
    </div>
  )
}

export function KindFilter({
  value,
  onChange,
  t,
}: {
  value: PluginKind | ''
  onChange(value: PluginKind | ''): void
  t: Text
}) {
  return (
    <Field label={t('kind.filter')}>
      <Select<PluginKind | 'all'>
        virtual={false}
        aria-label={t('kind.filter')}
        value={value || 'all'}
        onChange={(kind) => onChange(kind === 'all' ? '' : kind)}
        options={[
          { value: 'all', label: t('kind.all') },
          ...PLUGIN_KINDS.map((kind) => ({ value: kind, label: t(`kind.${kind}`) })),
        ]}
      />
    </Field>
  )
}
const identity = (entry: { id: string; version: string }) => JSON.stringify([entry.id, entry.version])
const label = (entry: Pick<AdminLoop, 'id' | 'version' | 'label'>) =>
  `${entry.label ?? entry.id} · ${entry.version}`

export function SessionDefaultsPanel({
  api,
  canSave,
  t,
}: {
  api: PluginAdminApi | undefined
  canSave: boolean
  t: Text
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
        setLoop(loops.defaults.loop ? identity(loops.defaults.loop) : '')
        setAdapter(loops.defaults.modelAdapter ? identity(loops.defaults.modelAdapter) : '')
        setModel(loops.defaults.modelAdapter?.model ?? '')
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
  async function save() {
    if (!catalog || !api || !canSave || !valid || busy) return
    setBusy(true)
    setError('')
    setStatus('')
    try {
      const snapshot = await api.saveDefaults({
        revision: catalog.snapshot.revision,
        defaults: {
          ...(preset ? { preset } : {}),
          ...(selectedLoop ? { loop: { id: selectedLoop.id, version: selectedLoop.version } } : {}),
          ...(selectedAdapter
            ? { modelAdapter: { id: selectedAdapter.id, version: selectedAdapter.version, model } }
            : {}),
        },
      })
      setCatalog({ ...catalog, snapshot })
      setStatus('defaults.saved')
    } catch {
      setError('defaults.save-failed')
    } finally {
      setBusy(false)
    }
  }
  const stale =
    (!!preset && !catalog?.presets.includes(preset)) ||
    (!!loop && !selectedLoop) ||
    (!!adapter && !selectedAdapter) ||
    (!!model && !selectedAdapter?.models.some((entry) => entry.id === model))
  return (
    <SettingsCard className="plugin-session-defaults" aria-label={t('defaults.title')} aria-busy={busy}>
      <h3>{t('defaults.title')}</h3>
      <p>{t('defaults.description')}</p>
      {error && (
        <p className="resource-safe-error" role="alert">
          {t(error)}
        </p>
      )}
      {status && <p role="status">{t(status)}</p>}
      {stale && <p role="alert">{t('defaults.stale')}</p>}
      {catalog && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          {(catalog.presets.length > 0 || preset) && (
            <Field label={t('defaults.preset')}>
              {catalog.presets.length === 1 && (!preset || preset === catalog.presets[0]) ? (
                <div data-testid="admin-default-preset-readonly">
                  <ChoiceLabel entry={{ id: catalog.presets[0]! }} t={choiceText} />
                </div>
              ) : (
                <Select<string>
                  aria-label={t('defaults.preset')}
                  value={preset}
                  disabled={busy || !canSave}
                  onChange={setPreset}
                  options={[
                    {
                      value: '',
                      label: `${t('defaults.configured')} (${composition?.preset ? choiceName({ id: composition.preset }, choiceText) : choiceText('choiceSourceUnknown')})`,
                    },
                    ...(preset && !catalog.presets.includes(preset)
                      ? [
                          {
                            value: preset,
                            label: `${preset} · ${t('defaults.unavailable-choice')}`,
                            disabled: true,
                          },
                        ]
                      : []),
                    ...catalog.presets.map((value) => ({
                      value,
                      label: <ChoiceLabel entry={{ id: value }} t={choiceText} />,
                    })),
                  ]}
                />
              )}
            </Field>
          )}
          <Field
            label={t('defaults.loop')}
            hint={
              composition
                ? `${choiceText('choiceSource')} ${choiceText(composition.source.layer === 'admin' ? 'choiceSourceAdmin' : composition.source.layer === 'default' ? 'choiceSourceBuiltin' : 'choiceSourceProfile')} · ${composition.source.name}`
                : choiceText('choiceSourceUnknown')
            }
          >
            {catalog.loops.length === 1 && !stale ? (
              <div data-testid="admin-default-loop-readonly">
                <ChoiceLabel entry={catalog.loops[0] ?? { id: '', version: '' }} t={choiceText} />
              </div>
            ) : (
              <Select<string>
                aria-label={t('defaults.loop')}
                value={loop}
                disabled={busy || !canSave}
                className="agent-picker-select"
                onChange={setLoop}
                options={[
                  {
                    value: '',
                    label: composition
                      ? `${t('defaults.configured')} (${choiceName(catalog.loops.find((entry) => identity(entry) === identity(composition.loop)) ?? composition.loop, choiceText)} · ${composition.loop.id} ${composition.loop.version})`
                      : t('defaults.configured'),
                    title: composition
                      ? `${choiceText(composition.source.layer === 'admin' ? 'choiceSourceAdmin' : composition.source.layer === 'default' ? 'choiceSourceBuiltin' : 'choiceSourceProfile')} · ${composition.source.name}`
                      : choiceText('choiceSourceUnknown'),
                  },
                  ...(loop && !selectedLoop && catalog.snapshot.defaults.loop
                    ? [
                        {
                          value: loop,
                          label: `${label(catalog.snapshot.defaults.loop)} · ${t('defaults.unavailable-choice')}`,
                          disabled: true,
                        },
                      ]
                    : []),
                  ...catalog.loops.map((entry) => ({
                    value: identity(entry),
                    label: <ChoiceLabel entry={entry} t={choiceText} />,
                  })),
                ]}
              />
            )}
          </Field>
          {selectedLoop && (
            <p>
              {selectedLoop.sourcePackage} · {selectedLoop.capabilities.join(', ')}
            </p>
          )}
          <Field label={t('defaults.adapter')}>
            <Select<string>
              aria-label={t('defaults.adapter')}
              value={adapter}
              disabled={busy || !canSave}
              onChange={(value) => {
                setAdapter(value)
                setModel('')
              }}
              options={[
                { value: '', label: t('defaults.configured') },
                ...(adapter && !selectedAdapter && catalog.snapshot.defaults.modelAdapter
                  ? [
                      {
                        value: adapter,
                        label:
                          label(catalog.snapshot.defaults.modelAdapter) +
                          ' · ' +
                          t('defaults.unavailable-choice'),
                        disabled: true,
                      },
                    ]
                  : []),
                ...catalog.adapters.map((entry) => ({ value: identity(entry), label: label(entry) })),
              ]}
            />
          </Field>
          {selectedAdapter && (
            <Field label={t('defaults.model')}>
              <Select<string>
                aria-label={t('defaults.model')}
                value={model || null}
                disabled={busy || !canSave}
                onChange={setModel}
                options={selectedAdapter.models.map((entry) => ({
                  value: entry.id,
                  label: entry.label ?? entry.id,
                }))}
              />
            </Field>
          )}
          <Button htmlType="submit" disabled={!valid || !canSave || busy}>
            {t('defaults.save')}
          </Button>
        </form>
      )}
      <Button onClick={() => setReload((value) => value + 1)} disabled={!api || busy}>
        {t('defaults.reload')}
      </Button>
    </SettingsCard>
  )
}

export function pluginFailureMessage(message: string, t: Text, code?: string): string {
  const keys: Record<string, string> = {
    'Plugin export is missing.': 'failure.missing-export',
    'Plugin API range is incompatible.': 'failure.api-range',
    'A required plugin service is missing.': 'failure.missing-inject',
    'Plugin configuration schema is invalid.': 'failure.schema',
    'Plugin frontend could not be loaded.': 'failure.frontend',
    'Plugin capability policy blocked activation.': 'failure.capability',
    'Runtime activation failed.': 'failure.activation',
  }
  const reason = t(
    code?.startsWith('CLIENT_MODULE_') ? 'failure.frontend' : (keys[message] ?? 'failure.activation'),
  )
  return `${reason} ${t('failure.repair')}`
}

export function BundlesPanel({
  api,
  canSave,
  t,
  presets = [],
}: {
  api: PluginAdminApi | undefined
  canSave: boolean
  t: Text
  presets?: readonly { id: string }[]
}) {
  const { t: settingsText } = useUiText(SETTINGS_NAMESPACE, settingsCatalog)
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<PluginAdminApi['bundles']>>>()
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [dump, setDump] = useState('')
  const [sessionInfo, setSessionInfo] = useState<unknown>()
  const [dumpPreset, setDumpPreset] = useState<string>()
  const [origins, setOrigins] = useState<{ choice: string; layer: string; name: string }[]>([])
  const [reload, setReload] = useState(0)
  function moveBundle(index: number, offset: number) {
    setSelected((prior) => {
      const next = [...prior]
      const item = next[index],
        neighbor = next[index + offset]
      if (item === undefined || neighbor === undefined) return prior
      next[index] = neighbor
      next[index + offset] = item
      return next
    })
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload explicitly rereads desired bundle selection.
  useEffect(() => {
    let current = true
    setSnapshot(undefined)
    setDump('')
    setOrigins([])
    setSessionInfo(undefined)
    setMessage('')
    if (!api) return
    setBusy(true)
    Promise.all([api.bundles(), api.composition()])
      .then(([value, composition]) => {
        if (current) {
          setSessionInfo(composition)
          setSnapshot(value)
          setSelected(value.bundles)
        }
      })
      .catch(() => {
        if (current) setMessage('bundles.unavailable')
      })
      .finally(() => {
        if (current) setBusy(false)
      })
    return () => {
      current = false
    }
  }, [api, reload])
  async function save() {
    if (!api || !snapshot || busy || !canSave) return
    setBusy(true)
    try {
      await api.saveBundles({ revision: snapshot.revision, bundles: selected })
      setMessage('bundles.saved')
      setReload((value) => value + 1)
    } catch {
      setMessage('bundles.failed')
    } finally {
      setBusy(false)
    }
  }
  async function explain() {
    if (!api || busy) return
    setBusy(true)
    try {
      const value = await api.composition(dumpPreset)
      setSessionInfo(value)
      setDump(JSON.stringify(value, null, 2))
      if (
        value &&
        typeof value === 'object' &&
        'sources' in value &&
        value.sources &&
        typeof value.sources === 'object'
      )
        setOrigins(
          Object.entries(value.sources).flatMap(([choice, source]) =>
            source &&
            typeof source === 'object' &&
            'layer' in source &&
            typeof source.layer === 'string' &&
            'name' in source &&
            typeof source.name === 'string'
              ? [{ choice, layer: source.layer, name: source.name }]
              : [],
          ),
        )
    } catch {
      setMessage('bundles.unavailable')
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingsCard aria-label={t('bundles.title')}>
      <h2>{t('bundles.title')}</h2>
      <p>{t('bundles.description')}</p>
      <SessionToolsPanel value={sessionInfo} t={settingsText} />
      {message && <p role="status">{t(message)}</p>}
      {snapshot && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <ol data-testid="bundle-order">
            {selected.map((id, index) => (
              <li key={id}>
                {id}{' '}
                <Button
                  aria-label={`${t('bundles.up')} ${id}`}
                  disabled={index === 0 || busy || !canSave}
                  onClick={() => moveBundle(index, -1)}
                >
                  {t('bundles.up')}
                </Button>{' '}
                <Button
                  aria-label={`${t('bundles.down')} ${id}`}
                  disabled={index === selected.length - 1 || busy || !canSave}
                  onClick={() => moveBundle(index, 1)}
                >
                  {t('bundles.down')}
                </Button>
              </li>
            ))}
          </ol>
          {snapshot.catalog.map((entry) => {
            const { id, sourcePackage } = entry
            return (
              <label
                key={id}
                className="agnes-settings-checkbox"
                htmlFor={`bundle-default-${encodeURIComponent(id)}`}
              >
                <SettingsInput
                  id={`bundle-default-${encodeURIComponent(id)}`}
                  type="checkbox"
                  checked={selected.includes(id)}
                  disabled={busy || !canSave}
                  onChange={(event) =>
                    setSelected((prior) =>
                      event.target.checked ? [...prior, id] : prior.filter((entry) => entry !== id),
                    )
                  }
                />{' '}
                {selected.includes(id) ? String(selected.indexOf(id) + 1) + '. ' : ''}
                <ChoiceLabel entry={entry} t={settingsText} />
                {' · '}
                {sourcePackage}
              </label>
            )
          })}
          {selected
            .filter((id) => !snapshot.catalog.some((entry) => entry.id === id))
            .map((id) => (
              <p key={id}>
                <label htmlFor={`bundle-missing-${encodeURIComponent(id)}`}>
                  <SettingsInput
                    id={`bundle-missing-${encodeURIComponent(id)}`}
                    type="checkbox"
                    checked
                    disabled={busy || !canSave}
                    onChange={() => setSelected((prior) => prior.filter((entry) => entry !== id))}
                  />{' '}
                  {t('bundles.missing')}: {id}
                </label>
              </p>
            ))}
          <Button htmlType="submit" disabled={busy || !canSave}>
            {t('bundles.save')}
          </Button>
        </form>
      )}
      <Button disabled={!api || busy} onClick={() => setReload((value) => value + 1)}>
        {t('defaults.reload')}
      </Button>
      <Field label={settingsText('presets')}>
        <Select<string>
          aria-label={settingsText('presets')}
          data-testid="config-dump-preset"
          value={dumpPreset ?? ''}
          onChange={(value) => setDumpPreset(value || undefined)}
          options={[
            { value: '', label: t('defaults.configured') },
            ...presets.map((entry) => ({
              value: entry.id,
              label: <ChoiceLabel entry={entry} t={settingsText} />,
            })),
          ]}
        />
      </Field>
      <Button data-testid="config-dump" disabled={!api || busy} onClick={() => void explain()}>
        {t('bundles.explain')}
      </Button>
      {dump && (
        <>
          <p>{settingsText('dumpHelp')}</p>
          <table data-testid="config-choice-sources">
            <caption>{settingsText('origin')}</caption>
            <thead>
              <tr>
                <th scope="col">{settingsText('choice')}</th>
                <th scope="col">{settingsText('layer')}</th>
                <th scope="col">{settingsText('source')}</th>
              </tr>
            </thead>
            <tbody>
              {origins.map((origin) => (
                <tr key={origin.choice}>
                  <th scope="row">{origin.choice}</th>
                  <td>{origin.layer}</td>
                  <td>{origin.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focus enables keyboard scrolling of the dump. */}
          <pre tabIndex={0}>{dump}</pre>
        </>
      )}
    </SettingsCard>
  )
}
