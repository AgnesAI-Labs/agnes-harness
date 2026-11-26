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
import { useEffect, useRef, useState } from 'react'
import type { PluginView } from './admin-view.js'
import {
  CommunityCard,
  CommunityDetails,
  type CommunityRepository,
  communityText,
  useCommunityDiscovery,
} from './community-market.js'
import { matchesPluginFilters, type PluginSource, PluginSourceFilter, PluginToolbar } from './plugins-tab.js'
import { SkillInstallDialog } from './skill-import.js'

type Text = (key: string, vars?: Readonly<Record<string, string | number>>) => string
const BATCH_SIZE = 12

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
  const { locale } = useUiText(PLUGIN_PRESENTATION_NAMESPACE, pluginPresentationCatalog)
  const [importSource, setImportSource] = useState<string | null>(null)
  const [source, setSource] = useState<PluginSource | ''>('')
  const { snapshot, failed } = useCommunityDiscovery(view)
  const [selectedId, setSelectedId] = useState<CommunityRepository['id'] | null>(null)
  const selected = snapshot?.items.find((row) => row.id === selectedId) ?? null
  const canFilterUnknown = view.state.communityVersion === 3
  const [filterUnknown, setFilterUnknown] = useState(false)
  const unknown = canFilterUnknown && filterUnknown
  if (!canFilterUnknown && filterUnknown) setFilterUnknown(false)
  const detailTrigger = useRef<HTMLElement | null>(null)
  const tail = useRef<HTMLDivElement>(null)
  const listKey = JSON.stringify([source, view.query, view.kind, unknown])
  const [display, setDisplay] = useState({ key: listKey, count: BATCH_SIZE })
  const count = display.key === listKey ? display.count : BATCH_SIZE
  if (display.key !== listKey) setDisplay({ key: listKey, count })
  const rows = unknown
    ? []
    : view.state.catalog.filter(
        (item) =>
          !item.metadata?.exampleOf &&
          discoverableAgent(item, view.state.installed) &&
          matchesPluginFilters(item, source, view.kind),
      )
  const grouped = new Map<string, PackageCatalogDescriptor[]>()
  for (const row of rows) grouped.set(row.id, [...(grouped.get(row.id) ?? []), row])
  const groups = [...grouped.values()]
  const keyword = view.query.toLowerCase()
  const community =
    !source || source === 'community'
      ? (snapshot?.items ?? []).filter((row) => {
          const version = row.versions?.[0]
          const provides = version && 'compatibility' in version ? version.provides : undefined
          if (unknown ? provides !== undefined : view.kind && !provides?.includes(view.kind)) return false
          return `${row.name ?? ''} ${communityText(row.title, locale)} ${communityText(row.summary, locale)} ${row.fullName} ${row.description} ${row.author ?? ''}`
            .toLowerCase()
            .includes(keyword)
        })
      : []
  const entries = [
    ...groups.map((group) => ({ kind: 'package' as const, group })),
    ...community.map((row) => ({ kind: 'community' as const, row })),
  ]
  const closeDetail = () => {
    setSelectedId(null)
    requestAnimationFrame(() => {
      if (detailTrigger.current?.isConnected) detailTrigger.current.focus()
    })
  }
  // The controller keeps one list; until it has switched to the catalog there is nothing to show.
  const ready = view.tab === 'discover'
  const moreEntries = count < entries.length
  const { loading, error, nextCursor } = view.state
  const cursor = nextCursor && !loading && !error && view.can('packages.read') ? nextCursor : null
  const hasMore = ready && (moreEntries || !!cursor)
  useEffect(() => {
    const target = tail.current
    if (!hasMore || !target || typeof IntersectionObserver !== 'function') return
    let active = true
    // Rearm after each batch or cursor change so a short page can fill the pane.
    const observer = new IntersectionObserver((entries) => {
      if (!active || view.tab !== 'discover' || !entries.some((entry) => entry.isIntersecting)) return
      if (!moreEntries) {
        // The live controller can start a read before its new state reaches this effect.
        const { loading, error, nextCursor } = view.state
        if (!cursor || loading || error || nextCursor !== cursor) return
      }
      active = false
      setDisplay({ key: listKey, count: count + BATCH_SIZE })
      if (!moreEntries && cursor) void view.loadCatalog(cursor)
    })
    observer.observe(target)
    return () => {
      active = false
      observer.disconnect()
    }
  }, [count, cursor, hasMore, listKey, moreEntries, view])
  return (
    <>
      <PluginToolbar
        view={view}
        t={t}
        onQuery={() => void view.loadCatalog()}
        leading={<PluginSourceFilter value={source} onChange={setSource} t={t} />}
        unknownKind={
          canFilterUnknown
            ? { label: t('community.typeUnknown'), selected: unknown, setSelected: setFilterUnknown }
            : undefined
        }
      />
      {importSource !== null && (
        <SkillInstallDialog
          key={importSource}
          view={view}
          initialSource={importSource}
          t={t}
          onClose={() => {
            setImportSource(null)
            requestAnimationFrame(() => detailTrigger.current?.focus())
          }}
        />
      )}
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
      {!ready ||
      (view.state.loading && !entries.length) ||
      (source === 'community' &&
        !entries.length &&
        !snapshot?.lastSuccessAt &&
        (snapshot?.state === 'pending' || snapshot?.state === 'syncing')) ? (
        <SettingsState tone="loading">{t('market.loading')}</SettingsState>
      ) : !entries.length ? (
        <EmptyState
          className="plugin-empty"
          icon={<Icon name="puzzle" size={48} />}
          title={view.query || view.kind || unknown || source ? t('market.none') : t('market.empty')}
          description={t(
            source === 'community' && (failed || snapshot?.error)
              ? 'community.loadFailed'
              : 'market.emptyHelp',
          )}
        />
      ) : (
        <div className="plugins-page-gallery" data-testid="market-list">
          {entries.slice(0, count).map((entry) =>
            entry.kind === 'package' ? (
              <MarketCard key={`package:${entry.group[0]!.id}`} group={entry.group} view={view} t={t} />
            ) : (
              <CommunityCard
                key={`community:${entry.row.id}`}
                row={entry.row}
                t={t}
                onView={(row, trigger) => {
                  detailTrigger.current = trigger
                  setSelectedId(row.id)
                }}
              />
            ),
          )}
        </div>
      )}
      {hasMore && <div ref={tail} className="plugins-page-gallery-tail" aria-hidden="true" />}
      <CommunityDetails
        row={selected}
        view={view}
        t={t}
        onClose={closeDetail}
        onSkillImport={(url) => {
          setSelectedId(null)
          setImportSource(`git:${url}.git`)
        }}
      />
    </>
  )
}
