import { sessionStartUrl } from '@agnes/web-admin/settings/runtime-panels'
import type { UiExtensionContext } from '@agnes/web-client'
import { createComputerUsePaneController } from '@agnes/web-conversation/computer-use-pane'
import { Button, Count, Icon, IconButton, Menu, Tabs, useUiText } from '@agnes/web-ui'
import { useEffect, useMemo, useState } from 'react'
import type { HomePageData } from './host.js'
import { HomePageFrame } from './page-frame.js'
import { type PluginView, useCandidateSources, usePluginAdmin } from './plugins/admin-view.js'
import { CapabilityPage } from './plugins/capabilities.js'
import { MarketTab } from './plugins/market-tab.js'
import { PLUGINS_PAGE_NAMESPACE, pluginsPageCatalog } from './plugins/page-locale.js'
import { PluginStatus, PluginsTab } from './plugins/plugins-tab.js'
import { ResourcesTab } from './plugins/resources-tab.js'
import { ReviewTab } from './plugins/review-tab.js'
import { openPlugins, PLUGIN_TABS, type PluginTab, pluginsRoute } from './plugins/route.js'
import { useCapabilitySummaries } from './plugins/summaries.js'

/** Drafts waiting for review, for the tab's number while another tab is showing. */
function usePendingReviews(api: PluginView['api']) {
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (!api) return
    let alive = true
    const read = () =>
      void api.candidatesList().then(
        (value) => {
          if (alive) setCount(value.candidates.filter((item) => item.state === 'review').length)
        },
        () => undefined,
      )
    read()
    const timer = setInterval(read, 20_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [api])
  return [count, setCount] as const
}

/** Plugins, skills, MCP servers, drafts to review and the catalog: everything that extends Agnes. */
export function PluginsPage({ context }: { context: UiExtensionContext }) {
  const data = context.data as HomePageData
  const { t } = useUiText(PLUGINS_PAGE_NAMESPACE, pluginsPageCatalog)
  const route = pluginsRoute(context.selection)
  const sources = useCandidateSources(data)
  const { host, view } = usePluginAdmin({
    ...data.plugins,
    candidateSessionTitle: sources.sessionTitle,
    candidateSessionTurnTime: sources.sessionTurnTime,
  })
  const summaries = useCapabilitySummaries(view?.api, data, t)
  const [pending, setPending] = usePendingReviews(view?.api)
  const computerUse = useMemo(() => createComputerUsePaneController({ call: data.call }), [data])
  useEffect(() => () => computerUse.dispose(), [computerUse])
  // The controller keeps one list: the installed inventory, or the catalog behind the marketplace.
  const listed = view?.tab
  const wanted = route.tab === 'market' ? 'discover' : 'installed'
  const selectTab = view?.selectTab
  useEffect(() => {
    if (!selectTab || !listed || listed === wanted) return
    let current = true
    // Switching lists makes the controller commit; let this commit finish first.
    queueMicrotask(() => {
      if (current) void selectTab(wanted)
    })
    return () => {
      current = false
    }
  }, [selectTab, listed, wanted])
  const canInstall = view?.canEffect('packages.install') ?? false
  const creatorPrompt = view?.settingsText('creatorPrompt')
  const add = (
    <span className="plugins-page-split">
      <Button
        id="install-source"
        appearance="primary"
        icon={<Icon name="plus" />}
        data-testid="plugin-install-source"
        disabled={!canInstall}
        disabledReason={t('add.forbidden')}
        onClick={() => view?.openSourceDialog('install')}
      >
        {t('add.label')}
      </Button>
      <Menu
        label={t('add.more')}
        trigger={
          <Button
            appearance="primary"
            aria-label={t('add.more')}
            data-testid="plugin-add-more"
            icon={<Icon name="chevron-down" />}
          />
        }
        items={[
          {
            id: 'source',
            label: t('add.source'),
            title: t('add.sourceHelp'),
            disabled: !canInstall,
            disabledReason: t('add.forbidden'),
            onSelect: () => view?.openSourceDialog('install'),
          },
          {
            id: 'creator',
            testId: 'plugin-creator',
            label: t('add.agent'),
            title: t('add.agentHelp'),
            onSelect: () => location.assign(sessionStartUrl(undefined, creatorPrompt)),
          },
        ]}
      />
    </span>
  )
  const body = (tab: PluginTab) =>
    tab !== route.tab ? null : tab === 'skills' || tab === 'mcp' ? (
      <ResourcesTab tab={tab} t={t} workspaceId={data.plugins?.workspaceId?.()} />
    ) : !view ? null : tab === 'plugins' ? (
      <PluginsTab view={view} t={t} hostT={context.t} summaries={summaries} />
    ) : tab === 'review' ? (
      <ReviewTab view={view} t={t} pending={pending} sources={sources} onPendingCount={setPending} />
    ) : (
      <MarketTab view={view} t={t} />
    )
  return (
    <>
      {/* The controller draws nothing here; it needs a connected node to own while it lives. */}
      <div ref={host} hidden />
      {route.capability ? (
        <CapabilityPage
          capability={route.capability}
          view={view}
          t={t}
          computerUse={computerUse.renderCapability()}
        />
      ) : (
        <HomePageFrame
          id="plugins"
          title={context.t('home.entry.plugins')}
          description={context.t('home.plugins.description')}
          actions={
            <>
              <IconButton
                name="refresh-cw"
                label={t('refresh')}
                data-testid="plugins-refresh"
                disabled={!view || view.state.loading}
                onClick={() => void view?.refresh()}
              />
              {route.tab === 'plugins' || route.tab === 'market' ? add : null}
            </>
          }
        >
          {view && <PluginStatus view={view} t={t} data={data} />}
          <Tabs
            className="plugins-page-tabs"
            aria-label={t('tabs.aria')}
            activeKey={route.tab}
            destroyOnHidden
            onChange={(key) => openPlugins(PLUGIN_TABS.find((id) => id === key) ?? 'plugins')}
            items={PLUGIN_TABS.map((id) => ({
              key: id,
              label:
                id === 'review' ? (
                  <span data-testid="plugins-tab-review">
                    {t('tab.review')}
                    <Count value={pending} label={t('tab.reviewCount', { count: pending })} />
                  </span>
                ) : (
                  <span data-testid={`plugins-tab-${id}`}>{t(`tab.${id}`)}</span>
                ),
              children: <div className="plugins-page-panel">{body(id)}</div>,
            }))}
          />
        </HomePageFrame>
      )}
    </>
  )
}
