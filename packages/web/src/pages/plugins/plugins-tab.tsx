import {
  type PackageCatalogDescriptor,
  type PackageInstalledDescriptor,
  resolvePluginMetadata,
} from '@agnes/protocol'
import { pluginNotice } from '@agnes/web-admin/admin/plugins/admin'
import { KindFilter, pluginFailureMessage } from '@agnes/web-admin/admin/plugins/control-panel'
import { PluginOperationFeedback } from '@agnes/web-admin/admin/plugins/operation-feedback'
import {
  Banner,
  Button,
  Count,
  Icon,
  type MenuItem,
  PluginList,
  Popover,
  pluginOrigin,
  SearchBar,
  SettingsSelect,
  SettingsState,
  terminal,
  usePushStack,
} from '@agnes/web-ui'
import { type ComponentProps, type ReactNode, useId, useState } from 'react'
import { isBusinessAgent as sharedBusinessAgent } from '../business-agents.js'
import type { HomePageData } from '../host.js'
import type { PluginView } from './admin-view.js'
import { CAPABILITIES, openPlugins, pluginPageId } from './route.js'
import type { CapabilitySummaries } from './summaries.js'

type Text = (key: string, vars?: Readonly<Record<string, string | number>>) => string
type Row = PackageInstalledDescriptor | PackageCatalogDescriptor

/** Only explicit launch declarations identify agents across these surfaces. */
export const isBusinessAgent = (item: Row): boolean => sharedBusinessAgent(item as PackageCatalogDescriptor)
/**
 * The installed list is one section: business agents lead, then what is switched on, then by name.
 * Source and capability filters leave the inventory in one list.
 */
export function orderInstalled<T extends PackageInstalledDescriptor>(
  rows: readonly T[],
  nameOf: (item: T) => string,
  locale?: string,
): T[] {
  const rank = (item: T) => (isBusinessAgent(item) ? 0 : 2) + (item.desired === 'enabled' ? 0 : 1)
  return [...rows].sort((a, b) => rank(a) - rank(b) || nameOf(a).localeCompare(nameOf(b), locale))
}

/** What one row of the installed list or the marketplace needs from the controller. */
export function pluginListProps(view: PluginView): Omit<ComponentProps<typeof PluginList>, 'rows' | 'tab'> {
  return {
    loading: view.state.loading,
    inventoryAuthoritative: view.state.inventoryAuthoritative,
    query: view.query,
    filtered: !!view.kind,
    nextCursor: view.state.nextCursor,
    menuOf: (item): readonly MenuItem[] => [
      ...('desired' in item && item.presentation?.rows.some((row) => row.settings)
        ? [{ id: 'settings', label: view.t('ux.settings'), onSelect: () => view.selectItem(item) }]
        : []),
      { id: 'details', label: view.t('ux.details'), onSelect: () => view.selectItem(item) },
      ...('desired' in item
        ? view
            .detailActions(item)
            .filter((action) => !action.href)
            .map((action, index) => ({
              id: `action-${index}`,
              label: action.label,
              disabled: action.disabled ?? false,
              ...(action.title ? { disabledReason: action.title } : {}),
              danger: action.className.includes('danger'),
              onSelect: action.onClick,
            }))
        : []),
    ],
    providesOf: (item) => view.presentationOf(item),
    formatFailure: (message, code) => pluginFailureMessage(message, view.t, code),
    surfaceLinksOf: (packageId) => view.surfaceLinks(packageId),
    highlight:
      view.state.lastOperation?.state === 'completed' &&
      ['install', 'update'].includes(view.state.lastOperation.operation) &&
      view.state.lastOperation.packageId
        ? { key: view.state.lastOperation.operationId, id: view.state.lastOperation.packageId }
        : undefined,
    pendingOf: (item) => view.packageBusy(item.id),
    runtimeOf: (packageId) => view.runtimeState(packageId),
    primaryActionOf: (item) => view.primaryAction(item),
    switchDisabledOf: (installed) =>
      !view.canEffect('packages.activate') ||
      (!installed.trusted && (!view.can('packages.trust') || !installed.capabilityHash)) ||
      view.packageBusy(installed.id),
    onOpen: (item) => view.selectItem(item),
    onToggleDesired: (item, next) => void (next ? view.confirmEnable(item) : view.confirmDisable(item)),
    onLoadMore: () => void view.loadCatalog(view.state.nextCursor ?? undefined),
  }
}

/** Search and the capability filter shared by the installed list and the marketplace. */
export function PluginToolbar({
  view,
  t,
  onQuery,
  leading,
}: {
  view: PluginView
  t: Text
  onQuery(): void
  /** A filter the tab owns, shown before the shared one. */
  leading?: ReactNode
}) {
  return (
    <SearchBar
      data-testid="plugin-toolbar"
      label={view.t('shell.search.aria')}
      placeholder={view.purposeText('search')}
      value={view.queryRaw}
      onChange={(value) => {
        view.queryRaw = value
        view.query = value.trim()
        onQuery()
      }}
      inputProps={{ id: 'plugin-search', disabled: !view.state.context || !view.can('packages.read') }}
      filters={
        <>
          {leading}
          <Popover
            trigger="click"
            placement="bottomRight"
            content={
              <>
                <KindFilter
                  value={view.kind}
                  t={view.t}
                  onChange={(value) => {
                    view.kind = value
                    view.render()
                  }}
                />
              </>
            }
          >
            <Button icon={<Icon name="sliders-horizontal" />} data-testid="plugin-filter">
              {t('filter.label')}
              <Count value={Number(!!view.kind)} label={t('filter.active')} />
            </Button>
          </Popover>
        </>
      }
    />
  )
}

/** Status the whole page shares: recovery mode, held versions, and the controller's one notice line. */
export function PluginStatus({ view, t, data }: { view: PluginView; t: Text; data: HomePageData }) {
  const notice = pluginNotice(view)
  const pages = usePushStack()
  // A check shows on the card that asked for it; everything else running is reachable from here.
  const running = [...view.state.operations.values()].filter(
    (operation) => operation.operation !== 'inspect' && !terminal(operation),
  ).length
  return (
    <>
      <PluginOperationFeedback
        operation={view.state.lastOperation}
        installed={view.state.installed}
        onEnable={(id) => {
          openPlugins('plugins')
          pages.open(pluginPageId({ kind: 'plugin', id }))
        }}
      />
      {running > 0 && (
        <SettingsState data-testid="plugin-operations-indicator">
          {view.t('operations.running', { count: running })}{' '}
          <Button
            appearance="link"
            size="small"
            data-testid="plugin-operations-open"
            onClick={() => view.openOperations()}
          >
            {view.t('operations.open')}
          </Button>
        </SettingsState>
      )}
      {view.state.context?.readOnly && (
        <Banner tone="warning" data-testid="plugin-recovery">
          <strong>{t('recovery.title')}</strong> {t('recovery.description')}
        </Banner>
      )}
      {notice.message &&
        (notice.kind === 'error' ? (
          <Banner tone="error" data-testid="plugin-notice">
            {notice.message}
          </Banner>
        ) : (
          <SettingsState data-testid="plugin-notice">{notice.message}</SettingsState>
        ))}
      {notice.tree && <SettingsState>{notice.tree}</SettingsState>}
    </>
  )
}

export function PluginsTab({
  view,
  t,
  summaries,
}: {
  view: PluginView
  t: Text
  summaries: CapabilitySummaries
}) {
  const [source, setSource] = useState<PluginSource | ''>('')
  const pages = usePushStack()
  const locale = view.locale.getSnapshot()
  const nameOf = (item: PackageInstalledDescriptor) =>
    resolvePluginMetadata(item.metadata, locale)?.displayName ?? item.id
  const rows = orderInstalled(
    view.filteredInstalled().filter((item) => matchesPluginFilters(item, source, view.kind)),
    nameOf,
    locale,
  )
  return (
    <>
      <PluginToolbar
        view={view}
        t={t}
        onQuery={() => view.render()}
        leading={<PluginSourceFilter value={source} onChange={setSource} t={t} />}
      />
      <div className="plugins-page-actions" data-testid="plugin-capability-settings">
        {CAPABILITIES.map((id) => (
          <Button key={id} onClick={() => pages.open(id)}>
            {t(`cap.${id}.name`)}
            {summaries[id] ? ` · ${summaries[id]?.text}` : ''}
          </Button>
        ))}
      </div>
      <div data-testid="plugin-browser">
        <PluginList
          {...pluginListProps(view)}
          filtered={!!source || !!view.kind}
          tab="installed"
          rows={rows}
        />
      </div>
    </>
  )
}

export const PLUGIN_SOURCES = ['official', 'community', 'local'] as const
export type PluginSource = (typeof PLUGIN_SOURCES)[number]
export const pluginSourceValue = (value: string): PluginSource | '' =>
  PLUGIN_SOURCES.find((source) => source === value) ?? ''

export function pluginSource(item: Row): PluginSource {
  const origin = pluginOrigin(item)
  if (origin === 'builtin' || origin === 'official') return 'official'
  return origin === 'local' ||
    origin === 'local-source' ||
    ['file', 'local', 'workspace', 'path'].includes(item.source.type)
    ? 'local'
    : 'community'
}

export function matchesPluginFilters(item: Row, source: PluginSource | '', capability: string): boolean {
  return (
    (!source || pluginSource(item) === source) &&
    (!capability || !!item.provides?.some((value) => value === capability))
  )
}

export function PluginSourceFilter({
  value,
  onChange,
  t,
}: {
  value: PluginSource | ''
  onChange(value: PluginSource | ''): void
  t: Text
}) {
  const id = useId()
  return (
    <label className="plugin-source-filter" htmlFor={id}>
      <span className="visually-hidden">{t('source.label')}</span>
      <SettingsSelect
        id={id}
        aria-label={t('source.label')}
        value={value}
        onChange={(event) => onChange(pluginSourceValue(event.target.value))}
      >
        <option value="">{t('source.all')}</option>
        {PLUGIN_SOURCES.map((id) => (
          <option key={id} value={id}>
            {t(`source.${id}`)}
          </option>
        ))}
      </SettingsSelect>
    </label>
  )
}
