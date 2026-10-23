import type { PackageCatalogDescriptor, PackageInstalledDescriptor } from '@agnes/protocol'
import { resolvePluginMetadata } from '@agnes/protocol'
import { type JSX, type ReactNode, useEffect, useRef, useState } from 'react'
import type { RuntimeStateView } from './admin-text.js'
import { ADMIN_LIST_LOCALE_NAMESPACE, adminListLocaleCatalog } from './locales/admin-list.js'
import { PLUGIN_PRESENTATION_NAMESPACE, pluginPresentationCatalog } from './locales/plugin-presentation.js'
import type { PluginPresentation } from './plugin-presentation.js'
import { PluginPrimaryStatus } from './plugin-primary-status.js'
import { PluginPurposeBadges, PluginSourceBadge, pluginIconName } from './plugin-purpose.js'
import { SettingsDetails, SettingsList, SettingsState } from './settings-layout.js'
import { Button } from './ui/button.js'
import { EmptyState } from './ui/empty-state.js'
import { Icon } from './ui/icon.js'
import { IconButton } from './ui/icon-button.js'
import { ListRow } from './ui/list-row.js'
import { Menu, type MenuItem } from './ui/menu.js'
import { Select } from './ui/select.js'
import { StateSwitch } from './ui/state-lights.js'
import { Tag } from './ui/tag.js'
import { useUiText } from './ui-locale.js'

export type AdminTab = 'installed' | 'discover'

export type SurfaceLinkItem = Readonly<{
  packageId: string
  surfaceId: string
  mount: string
}>

/** Inline primary action. The shell derives label/disabled from permissions and busy state; run enters its confirmation flow. */
export type RowAction = Readonly<{
  label: string
  disabled: boolean
  run: () => Promise<void> | void
}>

export type OrphanPinItem = Readonly<{
  pinId: string
  packageId: string
  version: string
  purpose: string
  snapshotId: string
}>

/** Orphan runtime pins: release individually or all at once, with per-item errors inline. Replaces the skeleton section children. */
export function OrphanPins({
  pins,
  errors,
  notice,
  fetchError,
  canRelease,
  onRelease,
}: {
  pins: readonly OrphanPinItem[]
  errors: ReadonlyMap<string, string>
  notice: string | undefined
  fetchError: string | undefined
  canRelease: boolean
  onRelease(pinIds: readonly string[], trigger: HTMLElement): void
}): JSX.Element {
  const { t } = useUiText(ADMIN_LIST_LOCALE_NAMESPACE, adminListLocaleCatalog)
  return (
    <>
      <div className="orphan-pins-heading">
        <strong>{t('orphan.title')}</strong>
        <Button
          htmlType="button"
          id="orphan-pins-release-all"
          size="small"
          disabled={!canRelease || pins.length === 0}
          onClick={(event) =>
            onRelease(
              pins.map((pin) => pin.pinId),
              event.currentTarget,
            )
          }
        >
          {t('orphan.release-all')}
        </Button>
      </div>
      <p id="orphan-pins-status" className="orphan-pins-status" hidden={!fetchError && !notice}>
        {fetchError ?? notice ?? ''}
      </p>
      <ul id="orphan-pins-list" className="orphan-pins-list">
        {pins.map((pin) => (
          <li key={pin.pinId} className="orphan-pin-row" data-pin-id={pin.pinId}>
            <div className="orphan-pin-content">
              <p>
                {pin.packageId}@{pin.version} · {pin.purpose}
              </p>
              <p className="orphan-pin-meta">
                pin {pin.pinId} · {t('orphan.snapshot')} {pin.snapshotId}
              </p>
              {errors.get(pin.pinId) && <p className="orphan-pin-error">{errors.get(pin.pinId)}</p>}
            </div>
            <Button
              htmlType="button"
              size="small"
              disabled={!canRelease}
              onClick={(event) => onRelease([pin.pinId], event.currentTarget)}
            >
              {t('orphan.release')}
            </Button>
          </li>
        ))}
      </ul>
    </>
  )
}

/** Keep compatibility hints on the catalog page; the installed page no longer shows internal status lights. */
function CatalogCompatibility({ item }: { item: PackageCatalogDescriptor }): JSX.Element {
  const { t } = useUiText(ADMIN_LIST_LOCALE_NAMESPACE, adminListLocaleCatalog)
  const unsupported = item.compatibility === 'unsupported'
  if (!unsupported) return <span className="plugin-compatibility" />
  return (
    <Tag tone="bad" className="plugin-compatibility" title={t('compatibility.unsupportedHelp')}>
      {t('compatibility.unsupported')}
    </Tag>
  )
}

function RowControl({
  tab,
  item,
  runtime,
  primaryAction,
  switchDisabled,
  busy,
  onToggleDesired,
  t,
}: {
  tab: AdminTab
  item: PackageInstalledDescriptor | PackageCatalogDescriptor
  runtime: RuntimeStateView | undefined
  primaryAction: RowAction
  switchDisabled: boolean
  busy: boolean
  t: (key: string, vars?: Readonly<Record<string, string | number>>) => string
  onToggleDesired(item: PackageInstalledDescriptor, next: boolean): void
}): JSX.Element {
  const actionButton = (extraClass?: string): JSX.Element => (
    <Button
      htmlType="button"
      size="small"
      {...(extraClass ? { className: extraClass } : {})}
      disabled={primaryAction.disabled}
      onClick={(event) => {
        event.stopPropagation()
        void primaryAction.run()
      }}
    >
      {primaryAction.label}
    </Button>
  )
  if (tab === 'installed') {
    const installed = item as PackageInstalledDescriptor
    const enabled = installed.desired === 'enabled'
    return (
      <div className="plugin-row-actions">
        <StateSwitch
          label={t(enabled ? 'switch.disable' : 'switch.enable', { id: installed.id })}
          checked={enabled}
          busy={busy}
          disabled={switchDisabled}
          onToggle={(next) => onToggleDesired(installed, next)}
        />
        {runtime?.phase === 'failed' &&
          installed.trusted &&
          (!installed.primaryStatus || installed.primaryStatus.nextAction === 'none') &&
          actionButton('plugin-row-retry')}
      </div>
    )
  }
  return actionButton()
}

export function PluginList({
  tab,
  rows,
  loading,
  inventoryAuthoritative,
  query,
  filtered = false,
  nextCursor,
  runtimeOf,
  primaryActionOf,
  switchDisabledOf,
  onOpen,
  onToggleDesired,
  onLoadMore,
  providesOf,
  menuOf,
  emptyActions,
  pendingOf,
  highlight,
  leading,
}: {
  /** Rows the host puts at the top of the same list, such as built-in capabilities. */
  leading?: ReactNode
  tab: AdminTab
  rows: readonly (PackageInstalledDescriptor | PackageCatalogDescriptor)[]
  loading: boolean
  inventoryAuthoritative: boolean
  query: string
  filtered?: boolean
  nextCursor: string | null
  surfaceLinksOf(packageId: string): readonly SurfaceLinkItem[]
  runtimeOf(packageId: string): RuntimeStateView | undefined
  primaryActionOf(item: PackageInstalledDescriptor | PackageCatalogDescriptor): RowAction
  switchDisabledOf(item: PackageInstalledDescriptor): boolean
  onOpen(item: PackageInstalledDescriptor | PackageCatalogDescriptor): void
  onToggleDesired(item: PackageInstalledDescriptor, next: boolean): void
  onLoadMore(): void
  formatFailure?(message: string, code?: string): string
  providesOf?(item: PackageInstalledDescriptor | PackageCatalogDescriptor): PluginPresentation | undefined
  menuOf?(item: PackageInstalledDescriptor | PackageCatalogDescriptor): readonly MenuItem[]
  highlight?: Readonly<{ key: string; id: string }> | undefined
  pendingOf?(item: PackageInstalledDescriptor | PackageCatalogDescriptor): boolean
  emptyActions?: ReactNode
}): JSX.Element {
  const { t } = useUiText(ADMIN_LIST_LOCALE_NAMESPACE, adminListLocaleCatalog)
  const { locale } = useUiText(PLUGIN_PRESENTATION_NAMESPACE, pluginPresentationCatalog)
  const [versions, setVersions] = useState<Record<string, string>>({})
  const [highlighted, setHighlighted] = useState<string>()
  const reveal = useRef<HTMLElement>()
  const highlightKey = highlight?.key
  const highlightId = highlight?.id
  useEffect(() => {
    if (!highlightKey || !highlightId) return
    setHighlighted(highlightId)
    const timer = setTimeout(() => setHighlighted(undefined), 2000)
    return () => clearTimeout(timer)
  }, [highlightKey, highlightId])
  useEffect(() => {
    if (!highlighted || !rows.some((item) => item.id === highlighted)) return
    const row = [...document.querySelectorAll<HTMLElement>('.plugin-row[data-highlighted="true"]')].find(
      (node) => node.dataset.pluginId === highlighted,
    )
    if (row && reveal.current !== row) {
      reveal.current = row
      row.scrollIntoView?.({ block: 'nearest' })
    }
  }, [highlighted, rows])
  const groups = new Map<string, (PackageInstalledDescriptor | PackageCatalogDescriptor)[]>()
  for (const row of rows) {
    const key = tab === 'discover' ? row.id : `${row.id}@${row.version}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  if (loading && !rows.length) {
    return (
      <SettingsState tone="loading" aria-busy="true">
        {t('empty.loading')}
      </SettingsState>
    )
  }
  if (!rows.length && leading) return <SettingsList>{leading}</SettingsList>
  if (!rows.length) {
    const title =
      query || filtered
        ? t('empty.query')
        : tab === 'installed'
          ? inventoryAuthoritative
            ? t('empty.installed')
            : t('empty.installed-unknown')
          : query
            ? t('empty.query')
            : t('empty.catalog')
    const copy =
      tab === 'installed'
        ? inventoryAuthoritative
          ? t('empty.installed-help')
          : t('empty.installed-recovery')
        : t('empty.catalog-help')
    return (
      <EmptyState
        className="plugin-empty admin-empty-state"
        icon={<Icon name="puzzle" size={48} />}
        title={title}
        description={copy}
        actions={emptyActions}
      />
    )
  }
  return (
    <>
      {tab === 'installed' && !inventoryAuthoritative && (
        <p className="plugin-inventory-status">{t('inventory.stale')}</p>
      )}
      <SettingsList>
        {leading}
        {[...groups.values()].map((group) => {
          const item = group.find((row) => row.version === versions[row.id]) ?? group[0]!
          const alternatives = group.filter(
            (row, index) => group.findIndex((entry) => entry.version === row.version) === index,
          )
          const purpose = resolvePluginMetadata(item.metadata, locale)
          const displayName = purpose?.displayName ?? item.id
          const description = purpose?.summary
          return (
            <ListRow
              key={tab === 'discover' ? item.id : `${item.id}@${item.version}`}
              className="plugin-row"
              data-plugin-id={item.id}
              data-plugin-version={item.version}
              data-tab={tab}
              data-highlighted={highlighted === item.id || undefined}
              icon={<Icon name={pluginIconName(item.id)} size={20} />}
              titleClassName="plugin-details-button"
              title={displayName}
              titleLabel={t('row.details', { id: displayName })}
              description={description ? <span data-testid="plugin-summary">{description}</span> : undefined}
              meta={<PluginPurposeBadges item={item} value={providesOf?.(item)} />}
              status={
                <>
                  <PluginSourceBadge item={item} />
                  {tab === 'discover' ? (
                    <CatalogCompatibility item={item as PackageCatalogDescriptor} />
                  ) : (
                    <PluginPrimaryStatus
                      status={(item as PackageInstalledDescriptor).primaryStatus}
                      action={primaryActionOf(item)}
                    />
                  )}
                </>
              }
              onOpen={() => onOpen(item)}
              actions={
                <>
                  <RowControl
                    tab={tab}
                    item={item}
                    runtime={runtimeOf(item.id)}
                    primaryAction={primaryActionOf(item)}
                    busy={pendingOf?.(item) ?? false}
                    switchDisabled={
                      tab === 'installed' ? switchDisabledOf(item as PackageInstalledDescriptor) : true
                    }
                    t={t}
                    onToggleDesired={onToggleDesired}
                  />
                  <Menu
                    label={t('row.actions')}
                    trigger={<IconButton name="ellipsis" label={t('row.actions')} />}
                    items={
                      menuOf?.(item) ?? [
                        {
                          id: 'details',
                          label: t('row.details', { id: displayName }),
                          onSelect: () => onOpen(item),
                        },
                      ]
                    }
                  />
                </>
              }
            >
              {alternatives.length > 1 ? (
                <SettingsDetails
                  title={t('row.versions', { version: item.version })}
                  data-testid="plugin-other-versions"
                >
                  <label htmlFor={`plugin-version-${encodeURIComponent(item.id)}`}>
                    {t('row.version')}
                    <Select<string>
                      id={`plugin-version-${encodeURIComponent(item.id)}`}
                      data-testid="plugin-version-picker"
                      className="plugin-version-picker"
                      virtual={false}
                      aria-label={t('row.version')}
                      value={item.version}
                      options={alternatives.map((entry) => ({ value: entry.version, label: entry.version }))}
                      getPopupContainer={(trigger) => trigger.parentElement ?? trigger}
                      onChange={(value) => setVersions((prior) => ({ ...prior, [item.id]: value }))}
                    />
                  </label>
                </SettingsDetails>
              ) : null}
            </ListRow>
          )
        })}
      </SettingsList>
      {tab === 'discover' && nextCursor && (
        <Button htmlType="button" className="plugin-more" onClick={onLoadMore}>
          {t('load-more')}
        </Button>
      )}
    </>
  )
}
