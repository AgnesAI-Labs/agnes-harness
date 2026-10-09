import { identity, label } from './composition-labels.js'
import type { AdminLoop, AdminModelAdapter, SessionDefaultsSnapshot } from '@agnes/protocol'
import { Button, Field, Select, SettingsCard, useUiText } from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import { ChoiceLabel, choiceName, type ResolvedComposition, readComposition } from '../../settings/choices.js'
import { SETTINGS_NAMESPACE, settingsCatalog } from '../../settings/locales.js'
import type { PluginAdminApi } from './api.js'
import type { Text } from './control-panel-types.js'

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
