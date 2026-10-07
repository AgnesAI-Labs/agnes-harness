import type {
  AdminLoop,
  AdminModelAdapter,
  PackageCatalogDescriptor,
  PackageInstalledDescriptor,
  SessionDefaultsSnapshot,
} from '@agnes/protocol'
import { Badge, Button, Field, Select, type StateTone } from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import type { PluginRuntimeState } from '../../client-modules/runtime-status.js'
import type { PluginAdminApi } from './api.js'

export const PLUGIN_KINDS = ['tool', 'loop', 'model-adapter', 'mcp', 'skills', 'ui'] as const
export type PluginKind = (typeof PLUGIN_KINDS)[number]
type Text = (key: string) => string
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
    <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap', marginBlock: '0.375rem' }}>
      {(item.kinds ?? []).map((kind) => (
        <Badge key={`kind:${kind}`}>{t(`kind.${kind}`)}</Badge>
      ))}
      {pluginStates(item, runtime).map(({ key, tone }) => (
        <Badge key={`state:${key}`} tone={tone}>
          {t(`state.${key}`)}
        </Badge>
      ))}
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
    <Field label={t('kind.filter')} style={{ display: 'grid', gap: '0.375rem', marginBlock: '0.75rem' }}>
      <Select<PluginKind | ''>
        aria-label={t('kind.filter')}
        value={value}
        onChange={onChange}
        style={{ minWidth: 180 }}
        options={[
          { value: '', label: t('kind.all') },
          ...PLUGIN_KINDS.map((kind) => ({ value: kind, label: t(`kind.${kind}`) })),
        ]}
      />
    </Field>
  )
}
const identity = (entry: { id: string; version: string }) => JSON.stringify([entry.id, entry.version])
const label = (entry: AdminLoop) => `${entry.label ?? entry.id} · ${entry.version}`

export function SessionDefaultsPanel({
  api,
  canSave,
  t,
}: {
  api: PluginAdminApi | undefined
  canSave: boolean
  t: Text
}) {
  const [catalog, setCatalog] = useState<{
    loops: readonly AdminLoop[]
    adapters: readonly AdminModelAdapter[]
    snapshot: SessionDefaultsSnapshot
  }>()
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
    Promise.all([api.loops(), api.modelAdapters()])
      .then(([loops, adapters]) => {
        if (!current) return
        setCatalog({ loops: loops.loops, adapters: adapters.modelAdapters, snapshot: loops })
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
    (!loop || !!selectedLoop) && (!adapter || !!selectedAdapter?.models.some((entry) => entry.id === model))
  async function save() {
    if (!catalog || !api || !canSave || !valid || busy) return
    setBusy(true)
    setError('')
    setStatus('')
    try {
      const snapshot = await api.saveDefaults({
        revision: catalog.snapshot.revision,
        defaults: {
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
    (!!loop && !selectedLoop) ||
    (!!adapter && !selectedAdapter) ||
    (!!model && !selectedAdapter?.models.some((entry) => entry.id === model))
  return (
    <section
      className="plugin-session-defaults"
      style={{
        padding: '0.75rem',
        marginBottom: '1rem',
        border: '1px solid var(--agnes-line-primary)',
        borderRadius: 'var(--radius-card)',
        background: 'var(--agnes-bg-surface)',
      }}
      aria-label={t('defaults.title')}
      aria-busy={busy}
    >
      <h2>{t('defaults.title')}</h2>
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
          style={{ display: 'grid', gap: '0.75rem' }}
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <Field label={t('defaults.loop')} style={{ display: 'grid', gap: '0.375rem' }}>
            <Select<string>
              aria-label={t('defaults.loop')}
              value={loop}
              disabled={busy || !canSave}
              style={{ width: '100%', maxWidth: 480 }}
              onChange={setLoop}
              options={[
                { value: '', label: t('defaults.configured') },
                ...(loop && !selectedLoop && catalog.snapshot.defaults.loop
                  ? [
                      {
                        value: loop,
                        label:
                          label({ ...catalog.snapshot.defaults.loop, sourcePackage: '', capabilities: [] }) +
                          ' · ' +
                          t('defaults.unavailable-choice'),
                        disabled: true,
                      },
                    ]
                  : []),
                ...catalog.loops.map((entry) => ({ value: identity(entry), label: label(entry) })),
              ]}
            />
          </Field>
          {selectedLoop && (
            <p>
              {selectedLoop.sourcePackage} · {selectedLoop.capabilities.join(', ')}
            </p>
          )}
          <Field label={t('defaults.adapter')} style={{ display: 'grid', gap: '0.375rem' }}>
            <Select<string>
              aria-label={t('defaults.adapter')}
              value={adapter}
              disabled={busy || !canSave}
              style={{ width: '100%', maxWidth: 480 }}
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
                          label({
                            ...catalog.snapshot.defaults.modelAdapter,
                            sourcePackage: '',
                            capabilities: [],
                          }) +
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
            <Field label={t('defaults.model')} style={{ display: 'grid', gap: '0.375rem' }}>
              <Select<string>
                aria-label={t('defaults.model')}
                value={model || null}
                disabled={busy || !canSave}
                style={{ width: '100%', maxWidth: 480 }}
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
    </section>
  )
}

export function pluginFailureMessage(message: string, t: Text): string {
  const keys: Record<string, string> = {
    'Plugin export is missing.': 'failure.missing-export',
    'Plugin API range is incompatible.': 'failure.api-range',
    'A required plugin service is missing.': 'failure.missing-inject',
    'Plugin configuration schema is invalid.': 'failure.schema',
    'Plugin frontend could not be loaded.': 'failure.frontend',
    'Runtime activation failed.': 'failure.activation',
  }
  return keys[message] ? t(keys[message]) : message
}
