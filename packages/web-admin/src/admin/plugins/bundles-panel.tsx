import { Button, Field, Select, SettingsCard, SettingsInput, useUiText } from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import { ChoiceLabel } from '../../settings/choices.js'
import { SETTINGS_NAMESPACE, settingsCatalog } from '../../settings/locales.js'
import { SessionToolsPanel } from '../../settings/session-tools.js'
import type { PluginAdminApi } from './api.js'
import { label } from './composition-labels.js'
import type { Text } from './control-panel-types.js'

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
