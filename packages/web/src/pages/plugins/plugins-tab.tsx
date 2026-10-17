import {
  type PackageCatalogDescriptor,
  type PackageInstalledDescriptor,
  resolvePluginMetadata,
} from '@agnes/protocol'
import { pluginNotice } from '@agnes/web-admin/admin/plugins/admin'
import { KindFilter, pluginFailureMessage } from '@agnes/web-admin/admin/plugins/control-panel'
import { PluginOperationFeedback } from '@agnes/web-admin/admin/plugins/operation-feedback'
import { homeNavigation } from '@agnes/web-client'
import {
  Badge,
  Banner,
  Button,
  Count,
  Field,
  Icon,
  isBuiltinPlugin,
  ListRow,
  type MenuItem,
  PluginList,
  Popover,
  SearchBar,
  SettingsSelect,
  SettingsState,
  Tag,
  terminal,
  useAdvancedSettings,
  usePushStack,
} from '@agnes/web-ui'
import type { ComponentProps, ReactNode } from 'react'
import { isBusinessAgent as sharedBusinessAgent } from '../business-agents.js'
import type { HomePageData } from '../host.js'
import { HomePageSection } from '../page-frame.js'
import type { PluginView } from './admin-view.js'
import { CAPABILITY_ICONS } from './capabilities.js'
import { CAPABILITIES, openPlugins, pluginPageId } from './route.js'
import type { CapabilitySummaries } from './summaries.js'

type Text = (key: string, vars?: Readonly<Record<string, string | number>>) => string
type Row = PackageInstalledDescriptor | PackageCatalogDescriptor

const flag = (item: Row, name: string): unknown =>
  (item.metadata as Record<string, unknown> | undefined)?.[name]
/** One rule for what counts as a business agent, shared with the gallery and the empty state. */
export const isBusinessAgent = (item: Row): boolean => sharedBusinessAgent(item as PackageCatalogDescriptor)
/**
 * The installed list is one section: business agents lead, then what is switched on, then by name.
 * Category is a filter and a line on the row, never a heading.
 */
export function orderInstalled<T extends PackageInstalledDescriptor>(
  rows: readonly T[],
  nameOf: (item: T) => string,
  locale?: string,
): T[] {
  const rank = (item: T) => (isBusinessAgent(item) ? 0 : 2) + (item.desired === 'enabled' ? 0 : 1)
  return [...rows].sort((a, b) => rank(a) - rank(b) || nameOf(a).localeCompare(nameOf(b), locale))
}
export const isExperimental = (item: Row): boolean => flag(item, 'experimental') === true

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

/** Search and the category filter shared by the installed list and the marketplace. */
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
      {(view.orphanPinList.length > 0 || !!view.orphanPinFetchError) && (
        <Banner
          tone="warning"
          data-testid="plugin-held-versions"
          action={<Button onClick={() => data.openSettings('diagnostics')}>{t('pins.open')}</Button>}
        >
          {t('pins.title')}
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
  const props = pluginListProps(view)
  const pages = usePushStack()
  const locale = view.locale.getSnapshot()
  const nameOf = (item: PackageInstalledDescriptor) =>
    resolvePluginMetadata(item.metadata, locale)?.displayName ?? item.id
  const rows = view
    .filteredInstalled()
    .filter((item) => !item.metadata?.exampleOf && (!view.kind || item.provides?.includes(view.kind)))
  const stable = rows.filter((item) => !isExperimental(item))
  const builtin = orderInstalled(stable.filter(isBuiltinPlugin), nameOf, locale)
  const others = orderInstalled(
    stable.filter((item) => !isBuiltinPlugin(item)),
    nameOf,
    locale,
  )
  const experimental = rows.filter(isExperimental)
  // Capabilities are not packages: a capability filter cannot match them, a search by name can.
  const needle = view.query.toLocaleLowerCase(locale)
  const capabilities = view.kind
    ? []
    : CAPABILITIES.filter((id) =>
        `${t(`cap.${id}.name`)} ${t(`cap.${id}.desc`)}`.toLocaleLowerCase(locale).includes(needle),
      )
  const searching = !!view.query || !!view.kind
  return (
    <>
      <PluginToolbar view={view} t={t} onQuery={() => view.render()} />
      {(capabilities.length > 0 || builtin.length > 0) && (
        <HomePageSection title={t('builtin.title')} actions={<small>{t('builtin.note')}</small>}>
          <div data-testid="plugin-builtin">
            <PluginList
              {...props}
              tab="installed"
              rows={builtin}
              leading={capabilities.map((id) => {
                const name = t(`cap.${id}.name`)
                const summary = summaries[id]
                return (
                  <ListRow
                    key={id}
                    className="plugin-row plugins-page-capability"
                    data-capability={id}
                    data-testid={`builtin-${id}`}
                    icon={<Icon name={CAPABILITY_ICONS[id]} size={20} />}
                    title={name}
                    titleLabel={t('builtin.open', { name })}
                    status={<Badge>{t('builtin.badge')}</Badge>}
                    description={t(`cap.${id}.desc`)}
                    onOpen={() => pages.open(id)}
                    actions={
                      <>
                        {summary &&
                          (summary.attention ? (
                            <Tag tone="warn">{summary.text}</Tag>
                          ) : (
                            <span className="plugins-page-summary">{summary.text}</span>
                          ))}
                        <Icon name="chevron-right" size={16} />
                      </>
                    }
                  />
                )
              })}
            />
          </div>
        </HomePageSection>
      )}
      {(others.length > 0 ||
        !searching ||
        (!capabilities.length && !builtin.length && !experimental.length)) && (
        <HomePageSection
          title={t('installed.others')}
          actions={
            others.length ? <small>{t('installed.count', { count: others.length })}</small> : undefined
          }
        >
          <div data-testid="plugin-browser">
            <PluginList
              {...props}
              tab="installed"
              rows={others}
              emptyActions={
                <Button onClick={() => homeNavigation.open('agents')}>{t('installed.empty.action')}</Button>
              }
            />
          </div>
        </HomePageSection>
      )}
      {experimental.length > 0 && (
        <HomePageSection title={t('experimental.title')} actions={<small>{t('experimental.note')}</small>}>
          <div data-testid="plugin-experimental">
            <PluginList {...props} tab="installed" rows={experimental} />
          </div>
        </HomePageSection>
      )}
    </>
  )
}
