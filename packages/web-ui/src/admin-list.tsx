import { resolvePluginMetadata } from '@agnes/protocol'
import type { PackageCatalogDescriptor, PackageInstalledDescriptor, PackageSource } from '@agnes/protocol'
import { type JSX, type ReactNode, useState } from 'react'
import { ADMIN_LOCALE_NAMESPACE, contributionText, type RuntimeStateView, sourceLabel } from './admin-text.js'
import { adminLocaleCatalog } from './locales/admin.js'
import { ADMIN_LIST_LOCALE_NAMESPACE, adminListLocaleCatalog } from './locales/admin-list.js'
import { PluginPurposeBadges, PluginProvidesChips } from './plugin-purpose.js'
import type { PluginPresentation } from './plugin-presentation.js'
import { PLUGIN_PRESENTATION_NAMESPACE, pluginPresentationCatalog } from './locales/plugin-presentation.js'
import { SettingsDetails } from './settings-layout.js'
import { Badge } from './ui/badge.js'
import { Select } from './ui/select.js'
import { StateSwitch } from './ui/state-lights.js'
import { useUiText } from './ui-locale.js'

export type AdminTab = 'installed' | 'discover'

export type SurfaceLinkItem = Readonly<{
  packageId: string
  surfaceId: string
  mount: string
}>

/** 行内主动作。label/disabled 由壳按权限与忙碌态推导，run 是壳的确认流程入口。 */
export type RowAction = Readonly<{
  label: string
  disabled: boolean
  run: () => Promise<void> | void
}>

function SurfaceLinks({
  links,
  packageId,
  t,
}: {
  links: readonly SurfaceLinkItem[]
  packageId: string
  t: (key: string, vars?: Readonly<Record<string, string | number>>) => string
}): JSX.Element | undefined {
  if (!links.length) return undefined
  return (
    <div className="plugin-surface-links">
      {links.map((surface) => (
        <a
          key={surface.surfaceId}
          className="secondary-button compact plugin-surface-link"
          href={surface.mount}
          target="_blank"
          rel="noopener"
          onClick={(event) => event.stopPropagation()}
          aria-label={t('surface.open-aria', {
            packageId,
            surfaceId: surface.surfaceId,
            mount: surface.mount,
          })}
        >
          {links.length === 1
            ? t('surface.open-page', { mount: surface.mount })
            : `${surface.surfaceId} · ${surface.mount}`}
        </a>
      ))}
    </div>
  )
}

export type OrphanPinItem = Readonly<{
  pinId: string
  packageId: string
  version: string
  purpose: string
  snapshotId: string
}>

/** 孤儿运行时 pin 区：逐条释放或一键全释放，逐条错误就地显示。整块替换骨架 section 的子节点。 */
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
        <button
          type="button"
          id="orphan-pins-release-all"
          className="secondary-button compact"
          disabled={!canRelease || pins.length === 0}
          onClick={(event) =>
            onRelease(
              pins.map((pin) => pin.pinId),
              event.currentTarget,
            )
          }
        >
          {t('orphan.release-all')}
        </button>
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
            <button
              type="button"
              className="secondary-button compact"
              disabled={!canRelease}
              onClick={(event) => onRelease([pin.pinId], event.currentTarget)}
            >
              {t('orphan.release')}
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}

/** 目录页保留兼容性提示；已安装页不再显示内部状态灯。 */
function CatalogCompatibility({ item }: { item: PackageCatalogDescriptor }): JSX.Element {
  const { t } = useUiText(ADMIN_LIST_LOCALE_NAMESPACE, adminListLocaleCatalog)
  const unsupported = item.compatibility === 'unsupported'
  return (
    <span
      className="plugin-compatibility"
      title={t(unsupported ? 'compatibility.unsupportedHelp' : 'compatibility.supportedHelp')}
    >
      <Badge tone={unsupported ? 'bad' : 'ok'}>
        {t(unsupported ? 'compatibility.unsupported' : 'compatibility.supported')}
      </Badge>
    </span>
  )
}

function RowControl({
  tab,
  item,
  runtime,
  primaryAction,
  switchDisabled,
  onToggleDesired,
  t,
}: {
  tab: AdminTab
  item: PackageInstalledDescriptor | PackageCatalogDescriptor
  runtime: RuntimeStateView | undefined
  primaryAction: RowAction
  switchDisabled: boolean
  t: (key: string, vars?: Readonly<Record<string, string | number>>) => string
  onToggleDesired(item: PackageInstalledDescriptor, next: boolean): void
}): JSX.Element {
  const actionButton = (extraClass?: string): JSX.Element => (
    <button
      type="button"
      className={`secondary-button compact${extraClass ? ` ${extraClass}` : ''}`}
      disabled={primaryAction.disabled}
      onClick={(event) => {
        event.stopPropagation()
        void primaryAction.run()
      }}
    >
      {primaryAction.label}
    </button>
  )
  if (tab === 'installed') {
    const installed = item as PackageInstalledDescriptor
    const enabled = installed.actual === 'running'
    if (runtime?.phase === 'failed') {
      return (
        <div className="plugin-row-actions">
          <StateSwitch
            label={t(enabled ? 'switch.disable' : 'switch.enable', { id: installed.id })}
            checked={enabled}
            disabled={switchDisabled}
            onToggle={(next) => onToggleDesired(installed, next)}
          />
          {actionButton('plugin-row-retry')}
        </div>
      )
    }
    return (
      <StateSwitch
        label={t(enabled ? 'switch.disable' : 'switch.enable', { id: installed.id })}
        checked={enabled}
        disabled={switchDisabled}
        onToggle={(next) => onToggleDesired(installed, next)}
      />
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
  surfaceLinksOf,
  runtimeOf,
  primaryActionOf,
  switchDisabledOf,
  onOpen,
  onToggleDesired,
  onLoadMore,
  metadataOf,
  formatFailure,
  providesOf,
}: {
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
  metadataOf?(item: PackageInstalledDescriptor | PackageCatalogDescriptor): ReactNode
}): JSX.Element {
  const { t } = useUiText(ADMIN_LIST_LOCALE_NAMESPACE, adminListLocaleCatalog)
  const { t: adminText } = useUiText(ADMIN_LOCALE_NAMESPACE, adminLocaleCatalog)
  const { t: purposeText, locale } = useUiText(PLUGIN_PRESENTATION_NAMESPACE, pluginPresentationCatalog)
  const [versions, setVersions] = useState<Record<string, string>>({})
  const groups = new Map<string, (PackageInstalledDescriptor | PackageCatalogDescriptor)[]>()
  for (const row of rows) {
    const key = tab === 'discover' ? row.id : `${row.id}@${row.version}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  if (loading && !rows.length) {
    return <p className="plugin-empty">{t('empty.loading')}</p>
  }
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
      <div className="plugin-empty admin-empty-state">
        <span className="agnes-mark admin-empty-state-mark" aria-hidden="true" />
        <h2>{title}</h2>
        <p>{copy}</p>
      </div>
    )
  }
  return (
    <>
      {tab === 'installed' && !inventoryAuthoritative && (
        <p className="plugin-inventory-status">{t('inventory.stale')}</p>
      )}
      {[...groups.values()].map((group) => {
        const item = group.find((row) => row.version === versions[row.id]) ?? group[0]!
        const alternatives = group.filter(
          (row, index) => group.findIndex((entry) => entry.version === row.version) === index,
        )
        const runtime = runtimeOf(item.id)
        const purpose = resolvePluginMetadata(item.metadata, locale)
        const displayName = purpose?.displayName ?? item.id
        const description = purpose?.summary ?? purposeText('noDescription')
        const failureReason =
          tab === 'installed'
            ? (runtime?.error?.message ??
              ((item as PackageInstalledDescriptor).actual === 'running'
                ? undefined
                : (item as PackageInstalledDescriptor).actualReason))
            : undefined
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: The heading button provides the same keyboard action; the row adds a pointer hit area without nesting interactive roles.
          <article
            key={tab === 'discover' ? item.id : `${item.id}@${item.version}`}
            className="plugin-row"
            data-plugin-id={item.id}
            data-plugin-version={item.version}
            data-tab={tab}
            onClick={(event) => {
              // 行内 Switch / 动作按钮自己处理点击；置灰控件在部分浏览器里不发 click，
              // 事件会落到行上，所以这里再挡一次，避免「拨开关顺带打开详情」。
              if (
                event.target instanceof Element &&
                event.target.closest('.switch, button, a, details, select, label')
              )
                return
              onOpen(item)
            }}
          >
            <div className="plugin-row-content">
              <h2>
                <button
                  type="button"
                  className="plugin-details-button"
                  aria-label={t('row.details', { id: displayName })}
                  onClick={() => onOpen(item)}
                >
                  {displayName}
                </button>
              </h2>
              <p data-testid="plugin-summary">{description}</p>
              <PluginPurposeBadges item={item} />
              {metadataOf?.(item)}
              <PluginProvidesChips value={providesOf?.(item)} />
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
              {alternatives.length === 1 && <p className="plugin-source">{item.version}</p>}
              <SettingsDetails title={t('row.technicalDetails')}>
                <p>
                  <code>{item.id}</code>
                </p>
                <p>{sourceLabel(item.source as PackageSource, adminText)}</p>
                <p>{contributionText(item, adminText)}</p>
                {tab === 'discover' && (
                  <p>
                    {t(
                      (item as PackageCatalogDescriptor).compatibility === 'unsupported'
                        ? 'compatibility.unsupportedHelp'
                        : 'compatibility.supportedHelp',
                    )}
                  </p>
                )}
              </SettingsDetails>
              {tab === 'installed' && (
                <SurfaceLinks links={surfaceLinksOf(item.id)} packageId={item.id} t={t} />
              )}
              {failureReason && (
                <p className="resource-safe-error">
                  {formatFailure?.(failureReason, runtime?.error?.code) ?? t('list.failure')}
                </p>
              )}
            </div>
            {tab === 'discover' && <CatalogCompatibility item={item as PackageCatalogDescriptor} />}
            <RowControl
              tab={tab}
              item={item}
              runtime={runtime}
              primaryAction={primaryActionOf(item)}
              switchDisabled={
                tab === 'installed' ? switchDisabledOf(item as PackageInstalledDescriptor) : true
              }
              t={t}
              onToggleDesired={onToggleDesired}
            />
          </article>
        )
      })}
      {tab === 'discover' && nextCursor && (
        <button type="button" className="secondary-button plugin-more" onClick={onLoadMore}>
          {t('load-more')}
        </button>
      )}
    </>
  )
}
