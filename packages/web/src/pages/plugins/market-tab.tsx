import { type PackageCatalogDescriptor, resolvePluginMetadata } from '@agnes/protocol'
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
  pluginPresentationCatalog,
  Select,
  SettingsDetails,
  SettingsSelect,
  SettingsState,
  Tag,
  useUiText,
} from '@agnes/web-ui'
import { useState } from 'react'
import { HomePageSection } from '../page-frame.js'
import type { PluginView } from './admin-view.js'
import { isBusinessAgent, PluginToolbar } from './plugins-tab.js'

type Text = (key: string, vars?: Readonly<Record<string, string | number>>) => string

export const MARKET_TYPES = ['agent', 'tool', 'skills', 'mcp', 'ui', 'runtime'] as const
export type MarketType = (typeof MARKET_TYPES)[number]
/**
 * The marketplace types a package belongs to. The package says which kinds it includes; an entry
 * from an older source without that falls back to the kinds its author declared.
 */
export function marketTypes(item: PackageCatalogDescriptor): readonly MarketType[] {
  const kinds: readonly string[] = item.presentation?.includes?.kinds ?? item.kinds ?? []
  return MARKET_TYPES.filter((type) =>
    type === 'agent'
      ? kinds.includes('bundle') || isBusinessAgent(item)
      : type === 'runtime'
        ? kinds.includes('loop') || kinds.includes('model-adapter')
        : kinds.includes(type),
  )
}

const official = (item: PackageCatalogDescriptor) =>
  ['official', 'example'].includes(item.presentation?.origin ?? '')

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
  const [type, setType] = useState<MarketType | ''>('')
  const rows = view.state.catalog.filter(
    (item) =>
      (!type || marketTypes(item).includes(type)) &&
      (!view.kind || item.kinds?.includes(view.kind)) &&
      (!view.category || (item.metadata?.category ?? 'unclassified') === view.category),
  )
  const grouped = new Map<string, PackageCatalogDescriptor[]>()
  for (const row of rows) grouped.set(row.id, [...(grouped.get(row.id) ?? []), row])
  const groups = [...grouped.values()]
  // The controller keeps one list; until it has switched to the catalog there is nothing to show.
  const ready = view.tab === 'discover'
  const sections = [
    ['official', groups.filter((group) => official(group[0]!))],
    ['community', groups.filter((group) => !official(group[0]!))],
  ] as const
  return (
    <>
      <PluginToolbar
        view={view}
        t={t}
        onQuery={() => void view.loadCatalog()}
        leading={
          <SettingsSelect
            aria-label={t('market.type')}
            data-testid="market-type"
            value={type}
            onChange={(event) => setType(MARKET_TYPES.find((id) => id === event.target.value) ?? '')}
          >
            <option value="">{t('market.type.all')}</option>
            {MARKET_TYPES.map((id) => (
              <option key={id} value={id}>
                {t(`market.type.${id}`)}
              </option>
            ))}
          </SettingsSelect>
        }
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
          icon={<Icon name="plug" size={48} />}
          title={view.query || view.kind || view.category || type ? t('market.none') : t('market.empty')}
          description={t('market.emptyHelp')}
        />
      ) : (
        sections.map(
          ([key, items]) =>
            items.length > 0 && (
              <HomePageSection key={key} title={t(`market.${key}`)}>
                <div className="plugins-page-gallery" data-testid={`market-${key}`}>
                  {items.map((group) => (
                    <MarketCard key={group[0]!.id} group={group} view={view} t={t} />
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
