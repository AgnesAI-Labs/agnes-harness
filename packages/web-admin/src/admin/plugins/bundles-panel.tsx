import { type PackageInstalledDescriptor, resolvePluginMetadata } from '@agnes/protocol'
import {
  Banner,
  Button,
  CopyButton,
  fallbackT,
  IconButton,
  reportSuccess,
  Select,
  SettingsBlock,
  SettingsCode,
  SettingsDrill,
  SettingsItem,
  SettingsTag,
  SettingsTechnicalDetails,
  StateSwitch,
  useUiText,
} from '@agnes/web-ui'
import { type DragEvent, useEffect, useState } from 'react'
import { choiceName } from '../../settings/choices.js'
import { SETTINGS_NAMESPACE, settingsCatalog } from '../../settings/locales.js'
import { SessionToolsPanel } from '../../settings/session-tools.js'
import type { PluginAdminApi } from './api.js'
import type { Text } from './control-panel-types.js'

/** A stable colour for an agent's tile, from its ID. */
function hue(id: string): number {
  let sum = 0
  for (const char of id) sum = (sum * 31 + char.charCodeAt(0)) % 997
  return sum % 6
}

/** Move one entry of an ordered list to another position. */
export function reorder<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list]
  const [item] = next.splice(from, 1)
  if (item === undefined) return [...list]
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item)
  return next
}

/**
 * Agent FDE (formerly bundles): the business agents applied to every new session, in order. The row
 * states how many are on; its subpage lists them by name with a switch each, reorders them by
 * dragging (or Alt+↑/↓ on the handle), marks ones whose plugin is gone, and shows the composed
 * result. The order only takes effect after the background service restarts, so it is applied with
 * one explicit 「Apply」.
 */
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
  const { t: settingsText, locale } = useUiText(SETTINGS_NAMESPACE, settingsCatalog)
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<PluginAdminApi['bundles']>>>()
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [applied, setApplied] = useState(false)
  const [failed, setFailed] = useState('')
  const [dump, setDump] = useState('')
  const [sessionInfo, setSessionInfo] = useState<unknown>()
  const [dumpPreset, setDumpPreset] = useState<string>()
  const [origins, setOrigins] = useState<{ choice: string; layer: string; name: string }[]>([])
  const [reload, setReload] = useState(0)
  const [dragging, setDragging] = useState<string>()
  const [installed, setInstalled] = useState<readonly PackageInstalledDescriptor[]>([])
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload explicitly rereads desired bundle selection.
  useEffect(() => {
    let current = true
    setFailed('')
    if (!api) return
    setBusy(true)
    Promise.all([
      api.bundles(),
      api.composition().catch(() => undefined),
      // Names come from the installed packages; without them a row falls back to its ID.
      api.list().then(
        (list) => list.packages,
        () => [],
      ),
    ])
      .then(([value, composition, packages]) => {
        if (!current) return
        setInstalled(packages)
        setSessionInfo(composition)
        setSnapshot(value)
        setSelected(value.bundles)
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
  const edit = (next: string[]) => {
    setApplied(false)
    setSelected(next)
  }
  async function apply() {
    if (!api || !snapshot || busy || !canSave || !dirty) return
    setBusy(true)
    setFailed('')
    try {
      await api.saveBundles({ revision: snapshot.revision, bundles: selected })
      reportSuccess('bundles', fallbackT('ui.settingsSaved'), {
        kind: 'restart-required',
        message: fallbackT('ui.restartRequired'),
      })
      // Read the stored selection back: its revision moved with the save.
      const value = await api.bundles().catch(() => {
        setFailed('bundles.refreshFailed')
        return undefined
      })
      setApplied(true)
      if (!value) return
      setSnapshot(value)
      setSelected(value.bundles)
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
      const sources = (value as { sources?: unknown }).sources
      setOrigins(
        sources && typeof sources === 'object'
          ? Object.entries(sources).flatMap(([choice, source]) => {
              const entry = source as { layer?: unknown; name?: unknown } | null
              return typeof entry?.layer === 'string' && typeof entry.name === 'string'
                ? [{ choice, layer: entry.layer, name: entry.name }]
                : []
            })
          : [],
      )
    } catch {
      setFailed('bundles.unavailable')
    } finally {
      setBusy(false)
    }
  }
  // Chosen agents first, in the order they apply; the rest follow as the catalog lists them.
  const rows = snapshot
    ? [
        ...selected.map((id) => ({ id, entry: snapshot.catalog.find((item) => item.id === id) })),
        ...snapshot.catalog
          .filter((item) => !selected.includes(item.id))
          .map((entry) => ({ id: entry.id, entry })),
      ]
    : []
  /**
   * A business agent by the name its package gives it (the catalog's own name first, then the
   * installed package's metadata), with its version. Without a name the row shows the ID, small
   * and monospace, never as a title.
   */
  const describe = (id: string) => {
    const entry = snapshot?.catalog.find((item) => item.id === id)
    const pkg = installed.find((item) => item.id === (entry?.sourcePackage ?? id.split('#')[0]))
    const name =
      entry?.displayName ?? entry?.label ?? resolvePluginMetadata(pkg?.metadata, locale)?.displayName
    return { name, version: entry?.version ?? pkg?.version }
  }
  const locked = busy || !canSave
  const move = (id: string, offset: number) => {
    const from = selected.indexOf(id)
    if (from < 0) return
    edit(reorder(selected, from, from + offset))
  }
  const drop = (event: DragEvent, target: string) => {
    event.preventDefault()
    const from = dragging ? selected.indexOf(dragging) : -1
    const to = selected.indexOf(target)
    setDragging(undefined)
    if (from >= 0 && to >= 0 && from !== to) edit(reorder(selected, from, to))
  }
  return (
    <SettingsBlock data-testid="bundles-row">
      <SettingsDrill
        id="bundles"
        data-testid="settings-drill-bundles"
        label={t('bundles.title')}
        hint={t('bundles.scope')}
        value={snapshot ? t('bundles.count', { on: selected.length, total: rows.length }) : undefined}
        description={t('bundles.description')}
      >
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
          <SettingsBlock state={busy && !snapshot ? 'loading' : undefined}>
            {snapshot && rows.length === 0 && (
              <SettingsItem label={t('bundles.empty')} data-testid="bundles-empty">
                <Button size="small" href="/?page=plugins">
                  {t('bundles.install')}
                </Button>
              </SettingsItem>
            )}
            {rows.map(({ id, entry }) => {
              const position = selected.indexOf(id)
              const on = position >= 0
              const { name, version } = describe(id)
              const label = name ?? id
              return (
                <SettingsItem
                  key={id}
                  data-bundle={id}
                  data-selected={on || undefined}
                  data-missing={!entry || undefined}
                  data-dragging={dragging === id || undefined}
                  draggable={on && !locked}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move'
                    setDragging(id)
                  }}
                  onDragEnd={() => setDragging(undefined)}
                  onDragOver={(event) => {
                    if (on && dragging) event.preventDefault()
                  }}
                  onDrop={(event) => drop(event, id)}
                  leading={
                    <>
                      {/* Drag the handle, or move with ↑/↓ while it has focus. */}
                      <IconButton
                        name="grip-vertical"
                        className="agnes-settings-drag"
                        data-testid="bundle-drag"
                        label={t('bundles.move', { name: label })}
                        disabled={locked || !on || selected.length < 2}
                        onKeyDown={(event) => {
                          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                            event.preventDefault()
                            move(id, event.key === 'ArrowUp' ? -1 : 1)
                          }
                        }}
                      />
                      <span className="agnes-settings-logo" data-hue={hue(id)} aria-hidden="true">
                        {(label.replace(/^@[^/]+\//, '').trim()[0] ?? '?').toUpperCase()}
                      </span>
                    </>
                  }
                  label={
                    <>
                      {on && <span className="agnes-settings-order">{position + 1}</span>}
                      {name ? (
                        <span data-testid="bundle-name">{name}</span>
                      ) : (
                        <code className="agnes-settings-id" data-testid="bundle-name">
                          {id}
                        </code>
                      )}
                      {!entry && <SettingsTag tone="warn">{t('bundles.missing')}</SettingsTag>}
                    </>
                  }
                  description={
                    <>
                      {entry ? version : t('bundles.missing-help')}{' '}
                      <SettingsTechnicalDetails title={settingsText('technicalDetails')}>
                        <code>{id}</code>{' '}
                        <CopyButton
                          text={id}
                          label={settingsText('copyId')}
                          copiedLabel={settingsText('copiedId')}
                        />
                      </SettingsTechnicalDetails>
                    </>
                  }
                >
                  <StateSwitch
                    id={`bundle-default-${encodeURIComponent(id)}`}
                    label={label}
                    checked={on}
                    disabled={locked}
                    onToggle={(checked) =>
                      edit(checked ? [...selected, id] : selected.filter((entry) => entry !== id))
                    }
                  />
                </SettingsItem>
              )
            })}
          </SettingsBlock>
          <SettingsBlock>
            <SettingsDrill
              id="bundles-effective"
              data-testid="bundles-technical"
              label={settingsText('technicalDetails')}
              description={settingsText('dumpHelp')}
            >
              <SettingsBlock>
                <SettingsItem label={settingsText('presets')}>
                  <Select<string>
                    aria-label={settingsText('presets')}
                    data-testid="config-dump-preset"
                    value={dumpPreset ?? ''}
                    popupMatchSelectWidth={false}
                    onChange={(value) => setDumpPreset(value || undefined)}
                    options={[
                      { value: '', label: t('defaults.configured') },
                      ...presets.map((entry) => ({
                        value: entry.id,
                        label: choiceName(entry, settingsText),
                      })),
                    ]}
                  />
                  <Button data-testid="config-dump" disabled={!api || busy} onClick={() => void explain()}>
                    {t('bundles.explain-action')}
                  </Button>
                </SettingsItem>
              </SettingsBlock>
              {dump && (
                <>
                  <SettingsBlock label={settingsText('origin')} data-testid="config-choice-sources">
                    {origins.map((origin) => (
                      <SettingsItem key={origin.choice} label={origin.choice}>
                        <span className="agnes-settings-value">
                          {origin.name} · {origin.layer}
                        </span>
                      </SettingsItem>
                    ))}
                  </SettingsBlock>
                  <SettingsCode label={t('bundles.explain')} copy={dump}>
                    {dump}
                  </SettingsCode>
                </>
              )}
              <SessionToolsPanel value={sessionInfo} t={settingsText} />
            </SettingsDrill>
          </SettingsBlock>
          {snapshot && rows.length > 0 && (
            <div className="agnes-settings-apply" data-testid="bundles-footer">
              <span role="status" data-testid="bundles-status">
                {!applied && t('bundles.restart')}
              </span>
              <Button
                appearance="primary"
                data-testid="bundles-save"
                onClick={() => void apply()}
                loading={busy && dirty}
                disabled={!dirty || busy || !canSave}
              >
                {t('bundles.save')}
              </Button>
            </div>
          )}
          <p className="agnes-settings-note">{t('bundles.single')}</p>
        </div>
      </SettingsDrill>
    </SettingsBlock>
  )
}
