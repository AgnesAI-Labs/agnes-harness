import type { PackageCatalogPage } from '@agnes/protocol'
import { Button, Drawer, IconTile, MetaText, Tag } from '@agnes/web-ui'
import { useEffect } from 'react'
import type { PluginView } from './admin-view.js'

type Snapshot = NonNullable<PackageCatalogPage['community']>
export type CommunityRepository = Snapshot['items'][number]
type Text = (key: string, vars?: Readonly<Record<string, string | number>>) => string
const repositoryUrl = (row: CommunityRepository) =>
  `https://github.com/${row.fullName.split('/').map(encodeURIComponent).join('/')}`

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
  return (
    <article className="plugins-page-card community-market-card" data-testid="community-card">
      <header>
        <IconTile name="puzzle" />
        <div>
          <h3>
            <Button
              appearance="ghost"
              className="plugins-page-card-title"
              title={row.fullName}
              onClick={(event) => onView(row, event.currentTarget)}
            >
              {row.fullName}
            </Button>
          </h3>
          <MetaText>{t('source.community')}</MetaText>
        </div>
      </header>
      <p className="community-market-summary">{row.description || t('community.noDescription')}</p>
      <MetaText>
        {t('community.cardMetrics', { stars: row.stars.toLocaleString(), language: row.language || '—' })}
      </MetaText>
      <footer>
        <MetaText>{row.ecosystem.toUpperCase()}</MetaText>
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
  const url = row ? repositoryUrl(row) : ''
  return (
    <Drawer
      open={!!row}
      title={row?.fullName ?? ''}
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
            {row.ecosystem === 'agh' && (
              <Button
                disabled={!view.canEffect('packages.install')}
                disabledReason={t('add.forbidden')}
                onClick={(event) => {
                  onClose()
                  void view.inspect({ type: 'git', ref: `git:${url}.git` }, 'install', event.currentTarget)
                }}
              >
                {t('community.check')}
              </Button>
            )}
            {row.ecosystem !== 'agh' &&
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
          <MetaText>
            {t('source.community')} · {row.ecosystem.toUpperCase()}
          </MetaText>
          <h3>{t('community.about')}</h3>
          <p className="community-market-description">{row.description || t('community.noDescription')}</p>
          <dl className="community-market-facts">
            {[
              [t('community.author'), row.fullName.split('/')[0]],
              ['Stars', row.stars.toLocaleString()],
              ['Forks', row.forks.toLocaleString()],
              [t('community.issues'), row.issues.toLocaleString()],
              [t('community.language'), row.language || '—'],
              [t('community.license'), row.license || '—'],
              [t('community.pushed'), row.pushedAt ? new Date(row.pushedAt).toLocaleString() : '—'],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {row.topics.length > 0 && (
            <>
              <h3>{t('community.topics')}</h3>
              <div className="community-market-topics">
                {row.topics.map((topic) => (
                  <a
                    key={topic}
                    href={`https://github.com/topics/${encodeURIComponent(topic)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {topic}
                  </a>
                ))}
              </div>
            </>
          )}
          <div className="community-market-compatibility">
            <Tag tone="info">{t('community.unverified')}</Tag>
            <p>{t('community.reviewRequired')}</p>
          </div>
        </div>
      )}
    </Drawer>
  )
}
