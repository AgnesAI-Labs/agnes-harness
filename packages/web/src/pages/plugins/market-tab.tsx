import { type PackageCatalogDescriptor, resolvePluginMetadata } from '@agnes/protocol'
import { homeNavigation } from '@agnes/web-client'
import {
  Badge,
  Button,
  EmptyState,
  Icon,
  IconTile,
  MetaText,
  PLUGIN_PRESENTATION_NAMESPACE,
  pluginPresentationCatalog,
  SettingsState,
  Tag,
  useUiText,
} from '@agnes/web-ui'
import { HomePageSection } from '../page-frame.js'
import type { PluginView } from './admin-view.js'
import { isBusinessAgent, PluginToolbar } from './plugins-tab.js'

type Text = (key: string, vars?: Readonly<Record<string, string | number>>) => string

const official = (item: PackageCatalogDescriptor) =>
  ['official', 'example'].includes(item.presentation?.origin ?? '')

function MarketCard({ item, view, t }: { item: PackageCatalogDescriptor; view: PluginView; t: Text }) {
  const { t: purposeText, locale } = useUiText(PLUGIN_PRESENTATION_NAMESPACE, pluginPresentationCatalog)
  const purpose = resolvePluginMetadata(item.metadata, locale)
  const name = purpose?.displayName ?? item.id
  const installed = view.state.installed.find((row) => row.id === item.id)
  const action = view.primaryAction(item)
  const origin =
    item.presentation?.origin ??
    (['file', 'local', 'workspace', 'path'].includes(item.source.type) ? 'local-source' : 'third-party')
  return (
    <article className="plugins-page-card" data-plugin-id={item.id} data-testid="market-card">
      <header>
        <IconTile name="plug" />
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
      <footer>
        {item.compatibility === 'unsupported' ? (
          <Tag tone="bad">{view.t('state.unsupported')}</Tag>
        ) : item.metadata ? (
          <MetaText>{purposeText(`category.${item.metadata.category}`)}</MetaText>
        ) : (
          <span />
        )}
        {installed && installed.version === item.version ? (
          <Badge tone="ok">{t('market.installed')}</Badge>
        ) : (
          <Button
            size="small"
            data-testid="market-install"
            disabled={action.disabled}
            {...(view.canEffect('packages.install') ? {} : { disabledReason: t('add.forbidden') })}
            onClick={() => void action.run()}
          >
            {installed ? t('market.update') : t('market.install')}
          </Button>
        )}
      </footer>
    </article>
  )
}

/** Today's plugin catalog; a real marketplace later replaces the data source, not the page. */
export function MarketTab({ view, t }: { view: PluginView; t: Text }) {
  const rows = view.state.catalog.filter(
    (item) =>
      !isBusinessAgent(item) &&
      (!view.kind || item.kinds?.includes(view.kind)) &&
      (!view.category || (item.metadata?.category ?? 'unclassified') === view.category),
  )
  // The controller keeps one list; until it has switched to the catalog there is nothing to show.
  const ready = view.tab === 'discover'
  const sections = [
    ['official', rows.filter(official)],
    ['community', rows.filter((item) => !official(item))],
  ] as const
  return (
    <>
      <PluginToolbar view={view} t={t} onQuery={() => void view.loadCatalog()} />
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
          icon={<Icon name="plug" size={48} />}
          title={view.query || view.kind || view.category ? t('market.none') : t('market.empty')}
          description={t('market.emptyHelp')}
        />
      ) : (
        sections.map(
          ([key, items]) =>
            items.length > 0 && (
              <HomePageSection key={key} title={t(`market.${key}`)}>
                <div className="plugins-page-gallery" data-testid={`market-${key}`}>
                  {items.map((item) => (
                    <MarketCard key={item.id} item={item} view={view} t={t} />
                  ))}
                </div>
              </HomePageSection>
            ),
        )
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
