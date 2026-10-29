import { type PackageCatalogDescriptor, resolvePluginMetadata } from '@agnes/protocol'
import { discoverableAgent } from '@agnes/web-admin/agents'
import { homeNavigation } from '@agnes/web-client'
import {
  ADMIN_LIST_LOCALE_NAMESPACE,
  adminListLocaleCatalog,
  Badge,
  Button,
  EmptyState,
  Icon,
  IconTile,
  MetaText,
  PLUGIN_PRESENTATION_NAMESPACE,
  pluginIconName,
  pluginPresentationCatalog,
  Select,
  SettingsDetails,
  SettingsState,
  Tag,
  useUiText,
} from '@agnes/web-ui'
import { useState } from 'react'
import type { PluginView } from './admin-view.js'
import { matchesPluginFilters, type PluginSource, PluginSourceFilter, PluginToolbar } from './plugins-tab.js'

type Text = (key: string, vars?: Readonly<Record<string, string | number>>) => string

function MarketCard({
  group,
  view,
  t,
}: {
  group: readonly PackageCatalogDescriptor[]
  view: PluginView
  t: Text
}) {
  const [version, setVersion] = useState<string>()
  const item = group.find((row) => row.version === version) ?? group[0]!
  const alternatives = group.filter(
    (row, index) => group.findIndex((entry) => entry.version === row.version) === index,
  )
  const { t: listText } = useUiText(ADMIN_LIST_LOCALE_NAMESPACE, adminListLocaleCatalog)
  const { t: purposeText, locale } = useUiText(PLUGIN_PRESENTATION_NAMESPACE, pluginPresentationCatalog)
  const purpose = resolvePluginMetadata(item.metadata, locale)
  const name = purpose?.displayName ?? item.id
  const installed = view.state.installed.find((row) => row.id === item.id)
  const action = view.primaryAction(item)
  // The check runs on the card; its result opens as a page, its failure stays under the card.
  const checking = view.inspecting(item.id)
  const failure = view.inspectFailure(item.id)
  const origin =
    item.presentation?.origin ??
    (['file', 'local', 'workspace', 'path'].includes(item.source.type) ? 'local-source' : 'third-party')
  return (
    <article
      className="plugins-page-card"
      data-plugin-id={item.id}
      data-plugin-version={item.version}
      data-testid="market-card"
    >
      <header>
        <IconTile name={pluginIconName(item.id)} />
        <div>
          <h3>
            <Button
              appearance="ghost"
              className="plugins-page-card-title"
              aria-label={t('market.details', { name })}
              onClick={() => view.selectItem(item)}
            >
              {name}
            </Button>
          </h3>
          <MetaText>{purposeText(`origin.${origin}`)}</MetaText>
        </div>
      </header>
      <p data-testid="plugin-summary">{purpose?.summary ?? t('market.noPurpose')}</p>
      {alternatives.length > 1 && (
        <SettingsDetails
          title={listText('row.versions', { version: item.version })}
          data-testid="plugin-other-versions"
        >
          <label htmlFor={`market-version-${encodeURIComponent(item.id)}`}>
            {listText('row.version')}
            <Select<string>
              id={`market-version-${encodeURIComponent(item.id)}`}
              data-testid="plugin-version-picker"
              className="plugin-version-picker"
              virtual={false}
              aria-label={listText('row.version')}
              value={item.version}
              options={alternatives.map((entry) => ({ value: entry.version, label: entry.version }))}
              getPopupContainer={(trigger) => trigger.parentElement ?? trigger}
              onChange={setVersion}
            />
          </label>
        </SettingsDetails>
      )}
      <footer>
        {item.compatibility === 'unsupported' ? (
          <Tag tone="bad">{view.t('state.unsupported')}</Tag>
        ) : item.metadata ? (
          <MetaText>
            {item.provides
              ?.map((kind) => purposeText(`provide.${kind === 'skills' ? 'skill' : kind}`))
              .join(' · ')}
          </MetaText>
        ) : (
          <span />
        )}
        {installed && installed.version === item.version ? (
          <Badge tone="ok">{t('market.installed')}</Badge>
        ) : (
          <Button
            size="small"
            data-testid="market-install"
            loading={checking}
            disabled={action.disabled || checking}
            {...(view.canEffect('packages.install') ? {} : { disabledReason: t('add.forbidden') })}
            onClick={() => void action.run()}
          >
            {checking ? view.t('review.checking') : installed ? t('market.update') : t('market.install')}
          </Button>
        )}
      </footer>
      {failure && !checking && (
        <div className="plugins-page-card-error" role="alert" data-testid="market-install-error">
          <span>
            {view.t('review.check-failed', { reason: failure.message || view.errorMessage(failure) })}
          </span>
          <Button
            appearance="link"
            size="small"
            data-testid="market-install-retry"
            disabled={action.disabled}
            onClick={() => void action.run()}
          >
            {view.t('review.retry')}
          </Button>
        </div>
      )}
    </article>
  )
}

/** Today's plugin catalog; a real marketplace later replaces the data source, not the page. */
export function MarketTab({ view, t }: { view: PluginView; t: Text }) {
  const [source, setSource] = useState<PluginSource | ''>('')
  const rows = view.state.catalog.filter(
    (item) =>
      !item.metadata?.exampleOf &&
      discoverableAgent(item, view.state.installed) &&
      matchesPluginFilters(item, source, view.kind),
  )
  const grouped = new Map<string, PackageCatalogDescriptor[]>()
  for (const row of rows) grouped.set(row.id, [...(grouped.get(row.id) ?? []), row])
  const groups = [...grouped.values()]
  // The controller keeps one list; until it has switched to the catalog there is nothing to show.
  const ready = view.tab === 'discover'
  return (
    <>
      <PluginToolbar
        view={view}
        t={t}
        onQuery={() => void view.loadCatalog()}
        leading={<PluginSourceFilter value={source} onChange={setSource} t={t} />}
      />
      <div className="plugins-page-callout">
        <IconTile name="bot" />
        <div>
          <strong>{t('market.agents.title')}</strong>
          <span>{t('market.agents.desc')}</span>
        </div>
        <Button size="small" data-testid="market-agents" onClick={() => homeNavigation.open('agents')}>
          {t('market.agents.open')}
        </Button>
      </div>
      {!ready || (view.state.loading && !rows.length) ? (
        <SettingsState tone="loading">{t('market.loading')}</SettingsState>
      ) : !rows.length ? (
        <EmptyState
          className="plugin-empty"
          icon={<Icon name="puzzle" size={48} />}
          title={view.query || view.kind || source ? t('market.none') : t('market.empty')}
          description={t('market.emptyHelp')}
        />
      ) : (
        <div className="plugins-page-gallery" data-testid="market-list">
          {groups.map((group) => (
            <MarketCard key={group[0]!.id} group={group} view={view} t={t} />
          ))}
        </div>
      )}
      {ready && view.state.nextCursor && (
        <Button
          className="plugin-more"
          appearance="ghost"
          onClick={() => void view.loadCatalog(view.state.nextCursor ?? undefined)}
        >
          {t('market.more')}
        </Button>
      )}
    </>
  )
}
