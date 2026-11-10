import type { PackageCatalogPage } from '@agnes/protocol'
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

type Snapshot = NonNullable<PackageCatalogPage['community']>
export type CommunityRepository = Snapshot['items'][number]
type Text = (key: string, vars?: Readonly<Record<string, string | number>>) => string
const repositoryUrl = (row: CommunityRepository) =>
  `https://github.com/${row.fullName.split('/').map(encodeURIComponent).join('/')}`

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
  const [choice, setChoice] = useState({ id: '', version: '' })
  const selected =
    row?.versions?.find((entry) => choice.id === row.name && choice.version === entry.version) ??
    row?.versions?.[0]
  const url = row ? repositoryUrl(row) : ''
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
            {(row.versions || row.ecosystem === 'agh') && (
              <Button
                disabled={!view.canEffect('packages.install')}
                disabledReason={t('add.forbidden')}
                onClick={(event) => {
                  onClose()
                  void view.inspect(
                    { type: 'git', ref: selected?.source.ref ?? `git:${url}.git` },
                    'install',
                    event.currentTarget,
                  )
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
            {[[t('community.author'), row.author || row.fullName.split('/')[0]]].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {row.versions && (
            <label htmlFor="community-version">
              {t('community.version')}
              <Select<string>
                id="community-version"
                data-testid="community-version-picker"
                virtual={false}
                value={selected?.version ?? null}
                options={row.versions.map((entry) => ({ value: entry.version, label: entry.version }))}
                getPopupContainer={(trigger) => trigger.parentElement ?? trigger}
                onChange={(version) => {
                  if (version) setChoice({ id: row.name ?? '', version })
                }}
              />
            </label>
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
