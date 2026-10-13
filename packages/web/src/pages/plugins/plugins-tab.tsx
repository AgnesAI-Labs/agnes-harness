import type { PackageCatalogDescriptor, PackageInstalledDescriptor } from '@agnes/protocol'
import { pluginNotice } from '@agnes/web-admin/admin/plugins/admin'
import { KindFilter, PluginBadges, pluginFailureMessage } from '@agnes/web-admin/admin/plugins/control-panel'
import { PluginOperationFeedback } from '@agnes/web-admin/admin/plugins/operation-feedback'
import { homeNavigation } from '@agnes/web-client'
import {
  Badge,
  Banner,
  Button,
  Count,
  Field,
  Icon,
  IconTile,
  ListRow,
  type MenuItem,
  PLUGIN_CATEGORIES,
  PluginList,
  Popover,
  SearchBar,
  SettingsList,
  SettingsSelect,
  SettingsState,
  Tag,
  useAdvancedSettings,
} from '@agnes/web-ui'
import type { ComponentProps } from 'react'
import { isBusinessAgent as sharedBusinessAgent } from '../business-agents.js'
import type { HomePageData } from '../host.js'
import { HomePageSection } from '../page-frame.js'
import type { PluginView } from './admin-view.js'
import { CAPABILITY_ICONS } from './capabilities.js'
import { CAPABILITIES, openPlugins } from './route.js'
import type { CapabilitySummaries } from './summaries.js'

type Text = (key: string, vars?: Readonly<Record<string, string | number>>) => string
type Row = PackageInstalledDescriptor | PackageCatalogDescriptor
const BUSINESS = 'business-agent'

const flag = (item: Row, name: string): unknown =>
  (item.metadata as Record<string, unknown> | undefined)?.[name]
/** One rule for what counts as a business agent, shared with the gallery and the empty state. */
export const isBusinessAgent = (item: Row): boolean => sharedBusinessAgent(item as PackageCatalogDescriptor)
export const isExperimental = (item: Row): boolean => flag(item, 'experimental') === true

/** What one row of the installed list or the marketplace needs from the controller. */
export function pluginListProps(view: PluginView): Omit<ComponentProps<typeof PluginList>, 'rows' | 'tab'> {
  return {
    loading: view.state.loading,
    inventoryAuthoritative: view.state.inventoryAuthoritative,
    query: view.query,
    filtered: !!view.kind || !!view.category,
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
    metadataOf: (item) => (
      <PluginBadges
        item={item}
        runtime={view.runtimeState(item.id)}
        status={view.state.generations}
        t={view.t}
      />
    ),
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
export function PluginToolbar({ view, t, onQuery }: { view: PluginView; t: Text; onQuery(): void }) {
  const advanced = useAdvancedSettings()
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
        <Popover
          trigger="click"
          content={
            <>
              <Field label={t('filter.category')} htmlFor="plugin-category">
                <SettingsSelect
                  id="plugin-category"
                  data-testid="plugin-category-filter"
                  value={view.category}
                  onChange={(event) => {
                    view.category = event.target.value
                    view.render()
                  }}
                >
                  <option value="">{t('filter.all')}</option>
                  {PLUGIN_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {view.purposeText(`category.${category}`)}
                    </option>
                  ))}
                  <option value="unclassified">{view.purposeText('unclassified')}</option>
                </SettingsSelect>
              </Field>
              {(advanced || !!view.kind) && (
                <KindFilter
                  value={view.kind}
                  t={view.t}
                  onChange={(value) => {
                    view.kind = value
                    view.render()
                  }}
                />
              )}
            </>
          }
        >
          <Button icon={<Icon name="sliders-horizontal" />} data-testid="plugin-filter">
            {t('filter.label')}
            <Count value={Number(!!view.category) + Number(!!view.kind)} label={t('filter.active')} />
          </Button>
        </Popover>
      }
    />
  )
}

/** Status the whole page shares: recovery mode, held versions, and the controller's one notice line. */
export function PluginStatus({ view, t, data }: { view: PluginView; t: Text; data: HomePageData }) {
  const notice = pluginNotice(view)
  return (
    <>
      <PluginOperationFeedback operation={view.state.lastOperation} installed={view.state.installed} />
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
  hostT,
  summaries,
}: {
  view: PluginView
  t: Text
  hostT: Text
  summaries: CapabilitySummaries
}) {
  const props = pluginListProps(view)
  const rows = view
    .filteredInstalled()
    .filter(
      (item) =>
        (!view.kind || item.kinds?.includes(view.kind)) &&
        (!view.category || (item.metadata?.category ?? 'unclassified') === view.category),
    )
  const stable = rows.filter((item) => !isExperimental(item))
  const experimental = rows.filter(isExperimental)
  const groups = new Map<string, PackageInstalledDescriptor[]>()
  for (const item of stable) {
    const key = isBusinessAgent(item) ? BUSINESS : (item.metadata?.category ?? 'unclassified')
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  const order = [BUSINESS, ...PLUGIN_CATEGORIES, 'unclassified'] as readonly string[]
  const ordered = [...groups].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
  const categoryName = (key: string) =>
    key === BUSINESS
      ? hostT('home.entry.agents')
      : key === 'unclassified'
        ? view.purposeText('unclassified')
        : view.purposeText(`category.${key}`)
  return (
    <>
      <HomePageSection title={t('builtin.title')} actions={<small>{t('builtin.note')}</small>}>
        <SettingsList data-testid="builtin-capabilities">
          {CAPABILITIES.map((id) => {
            const name = t(`cap.${id}.name`)
            const summary = summaries[id]
            return (
              <ListRow
                key={id}
                className="plugins-page-capability"
                data-capability={id}
                data-testid={`builtin-${id}`}
                icon={<IconTile name={CAPABILITY_ICONS[id]} />}
                title={name}
                titleLabel={t('builtin.open', { name })}
                status={<Badge>{t('builtin.badge')}</Badge>}
                description={t(`cap.${id}.desc`)}
                onOpen={() => openPlugins('plugins', id)}
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
        </SettingsList>
      </HomePageSection>
      <PluginToolbar view={view} t={t} onQuery={() => view.render()} />
      {ordered.length === 0 && experimental.length === 0 ? (
        <PluginList
          {...props}
          tab="installed"
          rows={[]}
          emptyActions={
            <Button onClick={() => homeNavigation.open('agents')}>{t('installed.empty.action')}</Button>
          }
        />
      ) : (
        ordered.map(([key, items]) => (
          <HomePageSection
            key={key}
            title={t('installed.title', { category: categoryName(key) })}
            actions={<small>{t('installed.count', { count: items.length })}</small>}
          >
            <div data-testid="plugin-browser" data-plugin-group={key}>
              <PluginList {...props} tab="installed" rows={items} />
            </div>
          </HomePageSection>
        ))
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
