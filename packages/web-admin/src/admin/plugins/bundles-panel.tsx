import {
  Banner,
  Button,
  IconButton,
  Select,
  SettingsCode,
  SettingsFooter,
  SettingsGroup,
  SettingsItem,
  SettingsState,
  SettingsTechnicalDetails,
  StateSwitch,
  Tag,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import { choiceName } from '../../settings/choices.js'
import { SETTINGS_NAMESPACE, settingsCatalog } from '../../settings/locales.js'
import { SessionToolsPanel } from '../../settings/session-tools.js'
import type { PluginAdminApi } from './api.js'
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
  const [failed, setFailed] = useState('')
  const [dump, setDump] = useState('')
  const [sessionInfo, setSessionInfo] = useState<unknown>()
  const [dumpPreset, setDumpPreset] = useState<string>()
  const [origins, setOrigins] = useState<{ choice: string; layer: string; name: string }[]>([])
  const [reload, setReload] = useState(0)
  function moveBundle(index: number, offset: number) {
    setMessage('')
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
    setFailed('')
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
        if (current) setFailed('bundles.unavailable')
      })
      .finally(() => {
        if (current) setBusy(false)
      })
    return () => {
      current = false
    }
  }, [api, reload])
  const dirty =
    !!snapshot &&
    (selected.length !== snapshot.bundles.length ||
      selected.some((id, index) => id !== snapshot.bundles[index]))
  const toggle = (id: string, on: boolean) => {
    setMessage('')
    setSelected((prior) => (on ? [...prior, id] : prior.filter((entry) => entry !== id)))
  }
  async function save() {
    if (!api || !snapshot || busy || !canSave || !dirty) return
    setBusy(true)
    setFailed('')
    try {
      await api.saveBundles({ revision: snapshot.revision, bundles: selected })
      // Read the stored selection back: its revision moved with the save.
      const value = await api.bundles()
      setSnapshot(value)
      setSelected(value.bundles)
      setMessage('bundles.saved')
    } catch {
      setFailed('bundles.failed')
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
      setFailed('bundles.unavailable')
    } finally {
      setBusy(false)
    }
  }
  // Chosen bundles first, in the order they apply; the rest follow as the catalog lists them.
  const rows = snapshot
    ? [
        ...selected.map((id) => ({ id, entry: snapshot.catalog.find((item) => item.id === id) })),
        ...snapshot.catalog
          .filter((item) => !selected.includes(item.id))
          .map((entry) => ({ id: entry.id, entry })),
      ]
    : []
  return (
    <div className="agnes-settings-stack" aria-busy={busy} data-testid="bundles-panel">
      {failed && (
        <Banner
          tone="error"
          role="alert"
          action={
            <Button size="small" disabled={!api || busy} onClick={() => setReload((value) => value + 1)}>
              {t('defaults.reload')}
            </Button>
          }
        >
          {t(failed)}
        </Banner>
      )}
      {busy && !snapshot && <SettingsState tone="loading" />}
      {snapshot && rows.length === 0 && <SettingsState>{t('bundles.empty')}</SettingsState>}
      {snapshot && rows.length > 0 && (
        <SettingsGroup
          role="group"
          aria-label={t('bundles.title')}
          data-testid="bundle-order"
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.defaultPrevented) return
            if (!(event.target instanceof HTMLInputElement)) return
            event.preventDefault()
            event.stopPropagation()
            void save()
          }}
        >
          {rows.map(({ id, entry }) => {
            const position = selected.indexOf(id)
            const on = position >= 0
            const name = entry ? choiceName(entry, settingsText) : id
            return (
              <SettingsItem
                key={id}
                data-bundle={id}
                data-selected={on || undefined}
                label={
                  <>
                    {on && <span className="agnes-settings-order">{position + 1}</span>}
                    <span>{name}</span>
                    {!entry && <Tag tone="warn">{t('bundles.missing')}</Tag>}
                  </>
                }
                description={entry ? t('bundles.from', { name: entry.sourcePackage }) : undefined}
              >
                {on && selected.length > 1 && (
                  <>
                    <IconButton
                      name="chevron-up"
                      label={`${t('bundles.up')} ${name}`}
                      disabled={position === 0 || busy || !canSave}
                      onClick={() => moveBundle(position, -1)}
                    />
                    <IconButton
                      name="chevron-down"
                      label={`${t('bundles.down')} ${name}`}
                      disabled={position === selected.length - 1 || busy || !canSave}
                      onClick={() => moveBundle(position, 1)}
                    />
                  </>
                )}
                <StateSwitch
                  id={`bundle-default-${encodeURIComponent(id)}`}
                  label={name}
                  checked={on}
                  disabled={busy || !canSave}
                  onToggle={(checked) => toggle(id, checked)}
                />
              </SettingsItem>
            )
          })}
        </SettingsGroup>
      )}
      {snapshot && rows.length > 0 && (
        <SettingsFooter status={message ? t(message) : t('bundles.description')}>
          <Button
            appearance="primary"
            data-testid="bundles-save"
            onClick={() => void save()}
            loading={busy && dirty}
            disabled={!dirty || busy || !canSave}
          >
            {t('bundles.save')}
          </Button>
        </SettingsFooter>
      )}
      <SettingsTechnicalDetails data-testid="bundles-technical">
        <SettingsGroup>
          <SettingsItem label={t('bundles.explain')} description={settingsText('dumpHelp')}>
            <Select<string>
              aria-label={settingsText('presets')}
              data-testid="config-dump-preset"
              value={dumpPreset ?? ''}
              popupMatchSelectWidth={false}
              onChange={(value) => setDumpPreset(value || undefined)}
              options={[
                { value: '', label: t('defaults.configured') },
                ...presets.map((entry) => ({ value: entry.id, label: choiceName(entry, settingsText) })),
              ]}
            />
            <Button data-testid="config-dump" disabled={!api || busy} onClick={() => void explain()}>
              {t('bundles.explain-action')}
            </Button>
          </SettingsItem>
        </SettingsGroup>
        {dump && (
          <>
            <div className="agnes-settings-table">
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
            </div>
            <SettingsCode label={t('bundles.explain')} copy={dump}>
              {dump}
            </SettingsCode>
          </>
        )}
        <SessionToolsPanel value={sessionInfo} t={settingsText} />
      </SettingsTechnicalDetails>
    </div>
  )
}
