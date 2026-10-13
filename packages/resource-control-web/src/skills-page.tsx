import {
  Button,
  Count,
  Icon,
  IconButton,
  Menu,
  Popover,
  RESOURCE_LIST_LOCALE_NAMESPACE,
  resourceListLocaleCatalog,
  SearchBar,
  SettingsDetails,
  SettingsPageHeader,
  SettingsState,
  Tabs,
  Toast,
  useUiText,
} from '@agnes/web-ui'
import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react'

export type SkillPagePanels = {
  review(onPendingCount: (count: number) => void): ReactNode
  feedback: ReactNode
}
let panels: SkillPagePanels | undefined
const listeners = new Set<() => void>()
/** Host-owned authoring panels. Only presentation crosses this boundary; resource operations stay here. */
export function registerSkillPagePanels(value: SkillPagePanels): () => void {
  panels = value
  for (const listener of listeners) listener()
  return () => {
    if (panels !== value) return
    panels = undefined
    for (const listener of listeners) listener()
  }
}
function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function SkillsPage({
  children,
  query,
  onQuery,
  onRefresh,
  busy,
  writable,
  locations,
  successMessage,
}: {
  children(onImport: () => void): ReactNode
  query: string
  onQuery(query: string): void
  onRefresh(): void
  busy: boolean
  writable: boolean
  locations: ReactNode
  successMessage: string
}) {
  const { t } = useUiText(RESOURCE_LIST_LOCALE_NAMESPACE, resourceListLocaleCatalog)
  const extra = useSyncExternalStore(subscribe, () => panels)
  const [tab, setTab] = useState('mine')
  const [pending, setPending] = useState(0)
  const [importing, setImporting] = useState(false)
  const [success, setSuccess] = useState('')
  useEffect(() => {
    if (successMessage) setSuccess(successMessage)
  }, [successMessage])
  const createUrl = `/?${new URLSearchParams({ new: '1', prompt: t('skills.creatorPrompt') })}`
  return (
    <>
      <Toast open={!!success} onDismiss={() => setSuccess('')}>
        {success}
      </Toast>
      <SettingsPageHeader
        title={t('skills.title')}
        description={t('skills.description')}
        actions={
          tab === 'mine' ? (
            <Menu
              label={t('skills.new')}
              trigger={
                <Button appearance="primary" icon={<Icon name="plus" />}>
                  {t('skills.new')}
                </Button>
              }
              items={[
                { id: 'create', label: t('skills.create'), onSelect: () => location.assign(createUrl) },
                { id: 'import', label: t('skills.import'), onSelect: () => setImporting(true) },
                { id: 'other', label: t('skills.importOther'), onSelect: () => setImporting(true) },
              ]}
            />
          ) : undefined
        }
      />
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'mine',
            label: t('skills.mine'),
            children: (
              <>
                <SearchBar
                  label={t('skills.search')}
                  placeholder={t('skills.search')}
                  value={query}
                  onChange={onQuery}
                  inputProps={{ id: 'skill-search' }}
                  actions={
                    <IconButton
                      name="refresh-cw"
                      label={t('skills.refresh')}
                      data-testid="skill-refresh-action"
                      aria-busy={busy}
                      disabled={!writable || busy}
                      disabledReason={!writable ? t('skills.readOnly') : t('loading')}
                      onClick={onRefresh}
                    />
                  }
                />
                {children(() => setImporting(true))}
                <Popover trigger="click" content={locations}>
                  <Button appearance="link" data-testid="skill-locations">
                    {t('skills.where')}
                  </Button>
                </Popover>
              </>
            ),
          },
          {
            key: 'review',
            label: (
              <>
                {t('skills.review')}
                <Count value={pending} label={t('skills.pending', { count: pending })} />
              </>
            ),
            forceRender: true,
            children: extra ? (
              extra.review(setPending)
            ) : (
              <SettingsState>{t('skills.reviewUnavailable')}</SettingsState>
            ),
          },
          {
            key: 'feedback',
            label: t('skills.feedback'),
            children: extra?.feedback ?? <SettingsState>{t('skills.reviewUnavailable')}</SettingsState>,
          },
        ]}
      />
      {importing && (
        <SettingsDetails open title={t('skills.import')} data-testid="skill-import-help">
          <p>{t('skills.importHelp')}</p>
          {locations}
          <p>
            <a
              href="https://github.com/AgnesAI-Labs/agnes-harness/blob/main/docs/guide/skills.md"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('skills.otherHelp')}
            </a>
          </p>
          <Button disabled={!writable || busy} disabledReason={t('skills.readOnly')} onClick={onRefresh}>
            {t('skills.scan')}
          </Button>
          <Button appearance="ghost" onClick={() => setImporting(false)}>
            {t('skills.close')}
          </Button>
        </SettingsDetails>
      )}
    </>
  )
}
