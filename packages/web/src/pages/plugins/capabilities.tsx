import type { AdminLoop } from '@agnes/protocol'
import { defaultLoop, resolvePluginMetadata } from '@agnes/protocol'
import { ChildEnginesPanel } from '@agnes/web-admin/settings/child-engines'
import { SETTINGS_NAMESPACE, settingsCatalog } from '@agnes/web-admin/settings/locales'
import { MemoryPanel } from '@agnes/web-admin/settings/memory'
import { sessionStartUrl } from '@agnes/web-admin/settings/runtime-panels'
import { SearchPanel } from '@agnes/web-admin/settings/search'
import { homeNavigation } from '@agnes/web-client'
import {
  Badge,
  Button,
  type IconName,
  IconTile,
  ListRow,
  SettingsList,
  SettingsState,
  Tag,
  useUiText,
} from '@agnes/web-ui'
import { type ReactNode, useEffect, useState } from 'react'
import { HomePageFrame, HomePageSection } from '../page-frame.js'
import type { PluginView } from './admin-view.js'
import { CustomInstructions } from './custom-instructions.js'
import { type Capability, openPlugins } from './route.js'

type Text = (key: string, vars?: Readonly<Record<string, string | number>>) => string

export const CAPABILITY_ICONS: Readonly<Record<Capability, IconName>> = {
  search: 'globe',
  'computer-use': 'eye',
  subagents: 'git-branch',
  execution: 'bot',
  memory: 'history',
  context: 'list',
}

/** The execution modes a new session can use, and which plugin each one comes from. */
function ExecutionModes({ view, t }: { view: PluginView | undefined; t: Text }) {
  const { locale } = useUiText(SETTINGS_NAMESPACE, settingsCatalog)
  const api = view?.api
  const [loops, setLoops] = useState<readonly AdminLoop[]>()
  const [chosen, setChosen] = useState<{ id: string; version: string }>()
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    void revision
    if (!api) return
    let alive = true
    setFailed(false)
    void api.loops().then(
      (value) => {
        if (!alive) return
        setLoops(value.loops)
        setChosen(defaultLoop(value.defaults))
      },
      () => {
        if (alive) setFailed(true)
      },
    )
    return () => {
      alive = false
    }
  }, [api, revision])
  const installed = view?.state.installed ?? []
  const sourceName = (loop: AdminLoop) => {
    const source = installed.find((item) => item.id === loop.sourcePackage)
    return resolvePluginMetadata(source?.metadata, locale)?.displayName
  }
  return (
    <>
      <HomePageSection
        title={t('exec.available')}
        actions={loops?.length ? <small>{t('exec.count', { count: loops.length })}</small> : undefined}
      >
        {failed ? (
          <SettingsState tone="error">
            {t('exec.failed')}
            <Button onClick={() => setRevision((value) => value + 1)}>{t('exec.retry')}</Button>
          </SettingsState>
        ) : !loops ? (
          <SettingsState tone="loading">{t('exec.loading')}</SettingsState>
        ) : (
          <SettingsList data-testid="execution-modes">
            {loops.map((loop) => {
              const isDefault = loop.id === chosen?.id && loop.version === chosen.version
              const from = sourceName(loop)
              const source = installed.find((item) => item.id === loop.sourcePackage)
              const stopped = !!source && source.actual !== 'running'
              return (
                <ListRow
                  key={`${loop.id}@${loop.version}`}
                  data-loop-id={loop.id}
                  icon={<IconTile name="bot" />}
                  title={loop.label ?? loop.id}
                  status={
                    stopped ? (
                      <Tag tone="warn">{t('exec.unavailable')}</Tag>
                    ) : isDefault ? (
                      <Tag tone="info">{t('exec.default')}</Tag>
                    ) : undefined
                  }
                  description={
                    <span translate="no">
                      {loop.id} {loop.version} · {from ?? (source ? loop.sourcePackage : t('exec.builtin'))}
                    </span>
                  }
                  actions={
                    stopped ? undefined : (
                      <Button
                        size="small"
                        data-testid="execution-start"
                        onClick={() =>
                          location.assign(
                            sessionStartUrl(undefined, undefined, [], { id: loop.id, version: loop.version }),
                          )
                        }
                      >
                        {t('exec.start')}
                      </Button>
                    )
                  }
                />
              )
            })}
          </SettingsList>
        )}
      </HomePageSection>
      <p className="plugins-page-note">
        {t('exec.hint')}{' '}
        <Button appearance="link" onClick={() => homeNavigation.open('agents')}>
          {t('exec.agents')}
        </Button>
      </p>
    </>
  )
}

/** One built-in capability's page: where it sits, what it does, then its current state and settings. */
export function CapabilityPage({
  capability,
  view,
  t,
  computerUse,
}: {
  capability: Capability
  view: PluginView | undefined
  t: Text
  /** The computer-use panel is composed by the page: its state lives with the conversation package. */
  computerUse: ReactNode
}) {
  const { t: settingsText } = useUiText(SETTINGS_NAMESPACE, settingsCatalog)
  const canSave = view?.canEffect('packages.activate') ?? false
  const name = t(`cap.${capability}.name`)
  return (
    <HomePageFrame
      id={`plugins-${capability}`}
      breadcrumb={
        <span>
          <Button appearance="link" data-testid="plugins-crumb" onClick={() => openPlugins('plugins')}>
            {t('back')}
          </Button>
          <span aria-hidden="true"> › </span>
          <span aria-current="page">{name}</span>
        </span>
      }
      title={
        <>
          {name}
          {capability === 'execution' && (
            <small className="plugins-page-alias" translate="no">
              {t('cap.execution.alias')}
            </small>
          )}{' '}
          <Badge>{t('builtin.badge')}</Badge>
        </>
      }
      description={t(`cap.${capability}.page`)}
    >
      {capability === 'search' && <SearchPanel canSave={canSave} t={settingsText} />}
      {capability === 'computer-use' && computerUse}
      {capability === 'subagents' && (
        <>
          <SettingsList>
            <ListRow
              icon={<IconTile name="git-branch" />}
              title={t('sub.builtin')}
              description={t('sub.builtinHelp')}
              actions={<Badge tone="ok">{t('sub.available')}</Badge>}
            />
          </SettingsList>
          <HomePageSection title={t('sub.external')} actions={<small>{t('sub.externalNote')}</small>}>
            <ChildEnginesPanel api={view?.api} canSave={canSave} t={settingsText} />
          </HomePageSection>
        </>
      )}
      {capability === 'execution' && <ExecutionModes view={view} t={t} />}
      {capability === 'memory' && <MemoryPanel canSave={canSave} />}
      {capability === 'context' && <CustomInstructions canSave={canSave} t={t} />}
    </HomePageFrame>
  )
}
