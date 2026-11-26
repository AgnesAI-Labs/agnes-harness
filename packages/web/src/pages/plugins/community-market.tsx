import type { PackageCatalogPage, PackageCommunityVersionV3, PackageSource } from '@agnes/protocol'
import {
  Button,
  Drawer,
  IconTile,
  MetaText,
  PLUGIN_PRESENTATION_NAMESPACE,
  pluginPresentationCatalog,
  Select,
  Tag,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import type { PluginView } from './admin-view.js'

type Snapshot = NonNullable<PackageCatalogPage['communityIndex']>
export type CommunityRepository = Snapshot['items'][number]
type Text = (key: string, vars?: Readonly<Record<string, string | number>>) => string
const repositoryUrl = (row: CommunityRepository) =>
  `https://github.com/${row.fullName.split('/').map(encodeURIComponent).join('/')}`

function pinnedCommit(source: PackageSource, repository: string): string | undefined {
  const prefix = `git:${repository}.git#`
  if (source.type !== 'git' || !source.ref.startsWith(prefix)) return undefined
  const commit = source.ref.slice(prefix.length)
  return /^[a-f0-9]{40}$/.test(commit) ? commit : undefined
}

export function communityText(value: CommunityRepository['summary'], locale: string): string {
  if (typeof value === 'string') return value
  if (!value) return ''
  return value[locale.toLowerCase()] ?? value[locale] ?? value.en ?? Object.values(value)[0] ?? ''
}

/** The market has one list. This hook only refreshes its local discovery data. */
export function useCommunityDiscovery(view: PluginView) {
  const api = view.api
  const refresh = view.refreshCommunity
  useEffect(() => {
    if (!api) return
    const read = async () => {
      if (document.visibilityState !== 'hidden') await refresh()
    }
    const timer = setInterval(() => {
      void read()
    }, 60_000)
    window.addEventListener('focus', read)
    document.addEventListener('visibilitychange', read)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', read)
      document.removeEventListener('visibilitychange', read)
    }
  }, [api, refresh])
  return { snapshot: view.state.community, failed: view.state.communityReadFailed ?? false }
}

export function CommunityCard({
  row,
  t,
  onView,
}: {
  row: CommunityRepository
  t: Text
  onView(row: CommunityRepository, trigger: HTMLElement): void
}) {
  const { locale } = useUiText(PLUGIN_PRESENTATION_NAMESPACE, pluginPresentationCatalog)
  const name = communityText(row.title, locale) || row.name || row.fullName
  return (
    <article className="plugins-page-card community-market-card" data-testid="community-card">
      <header>
        <IconTile name="puzzle" />
        <div>
          <h3>
            <Button
              appearance="ghost"
              className="plugins-page-card-title"
              title={row.name || row.fullName}
              onClick={(event) => onView(row, event.currentTarget)}
            >
              {name}
            </Button>
          </h3>
          <MetaText>{row.author || row.fullName.split('/')[0]}</MetaText>
        </div>
      </header>
      <p className="community-market-summary">
        {communityText(row.summary, locale) || row.description || t('community.noDescription')}
      </p>
      <footer>
        <MetaText>{row.versions?.[0]?.version || '—'}</MetaText>
        <Button
          size="small"
          data-testid="community-view"
          onClick={(event) => onView(row, event.currentTarget)}
        >
          {t('community.view')}
        </Button>
      </footer>
    </article>
  )
}

/** Read-only marketplace detail is the deliberately scoped drawer exception. */
export function CommunityDetails({
  row,
  view,
  t,
  onClose,
  onSkillImport,
}: {
  row: CommunityRepository | null
  view: PluginView
  t: Text
  onClose(): void
  onSkillImport?(url: string): void
}) {
  const { locale } = useUiText(PLUGIN_PRESENTATION_NAMESPACE, pluginPresentationCatalog)
  const [choice, setChoice] = useState<{ id: CommunityRepository['id']; version: string }>()
  const selected =
    (row && choice && row.id === choice.id
      ? row.versions?.find((entry) => entry.version === choice.version)
      : undefined) ?? row?.versions?.[0]
  const url = row ? repositoryUrl(row) : ''
  const commit = selected && pinnedCommit(selected.source, url)
  const inspection: PackageSource | undefined =
    selected && commit
      ? selected.source
      : !row?.versions && row?.ecosystem === 'agh'
        ? { type: 'git', ref: `git:${url}.git` }
        : undefined
  const metadata =
    selected && 'compatibility' in selected ? (selected as PackageCommunityVersionV3) : undefined
  const { connection, communityReadFailed } = view.state
  const compatibility =
    communityReadFailed || connection === 'offline' || connection === 'forbidden'
      ? undefined
      : metadata?.compatibility
  const range = compatibility && 'range' in compatibility ? compatibility.range : undefined
  const committedAt =
    metadata?.publishTimestamp === undefined ? null : new Date(metadata.publishTimestamp * 1000)
  return (
    <Drawer
      open={!!row}
      title={row ? communityText(row.title, locale) || row.name || row.fullName : ''}
      onClose={onClose}
      closeLabel={t('community.close')}
      className="community-market-details"
      footer={
        row && (
          <div className="community-market-actions">
            <a href={url} target="_blank" rel="noopener noreferrer">
              {t('community.repository')}
            </a>
            <a href={`${url}/releases`} target="_blank" rel="noopener noreferrer">
              {t('community.releases')}
            </a>
            {inspection && (
              <Button
                disabled={!view.canEffect('packages.install')}
                disabledReason={t('add.forbidden')}
                onClick={(event) => {
                  onClose()
                  void view.inspect(inspection, 'install', event.currentTarget)
                }}
              >
                {t('community.check')}
              </Button>
            )}
            {!row.versions &&
              row.ecosystem !== 'agh' &&
              onSkillImport &&
              view.state.context?.features?.includes('packages.skill-import.v1') && (
                <Button disabled={!view.canEffect('packages.install')} onClick={() => onSkillImport(url)}>
                  {t('skill.import.check')}
                </Button>
              )}
          </div>
        )
      }
    >
      {row && (
        <div data-testid="community-details">
          <MetaText>{t('source.community')}</MetaText>
          <h3>{t('community.about')}</h3>
          <p className="community-market-description">
            {communityText(row.summary, locale) || row.description || t('community.noDescription')}
          </p>
          <dl className="community-market-facts">
            <div>
              <dt>{t('community.author')}</dt>
              <dd>{row.author || row.fullName.split('/')[0]}</dd>
            </div>
          </dl>
          {row.versions && (
            <label htmlFor="community-version">
              {t('community.version')}
              <Select<string>
                id="community-version"
                data-testid="community-version-picker"
                aria-label={t('community.version')}
                virtual={false}
                value={selected?.version ?? null}
                options={row.versions.map((entry) => ({ value: entry.version, label: entry.version }))}
                getPopupContainer={(trigger) => trigger.parentElement ?? trigger}
                onChange={(version) => {
                  if (version) setChoice({ id: row.id, version })
                }}
              />
            </label>
          )}
          {selected && (
            <dl className="community-market-facts">
              {metadata && (
                <>
                  <div>
                    <dt>{t('market.type')}</dt>
                    <dd>
                      {metadata.provides?.map((kind) => view.t(`kind.${kind}`)).join(' · ') ??
                        t('community.typeUnknown')}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('community.compatibility')}</dt>
                    <dd className="community-market-verdict">
                      <Tag tone={compatibility?.kind === 'incompatible' ? 'bad' : 'info'}>
                        {t(`community.compatibility.${compatibility?.kind ?? 'unknown'}`)}
                      </Tag>
                      {range && <code>{range}</code>}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('community.commitTime')}</dt>
                    <dd>
                      {committedAt ? (
                        <time dateTime={committedAt.toISOString()}>
                          {new Intl.DateTimeFormat(locale, {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          }).format(committedAt)}
                        </time>
                      ) : (
                        t('community.notRecorded')
                      )}
                    </dd>
                  </div>
                </>
              )}
              <div>
                <dt>{t('community.repository')}</dt>
                <dd>{row.fullName}</dd>
              </div>
              {commit && (
                <div>
                  <dt>{t('community.commit')}</dt>
                  <dd>
                    <a href={`${url}/commit/${commit}`} target="_blank" rel="noopener noreferrer">
                      <code>{commit}</code>
                    </a>
                  </dd>
                </div>
              )}
            </dl>
          )}
          <div className="community-market-compatibility">
            {metadata ? (
              <>
                <p>{t('community.compatibilityNotice')}</p>
                <p>{t('community.commitTimeNotice')}</p>
              </>
            ) : (
              <Tag tone="info">{t('community.unverified')}</Tag>
            )}
            <p>{t('community.reviewRequired')}</p>
          </div>
        </div>
      )}
    </Drawer>
  )
}
