import { resolvePluginMetadata } from '@agnes/protocol'
import { sessionStartUrl } from '@agnes/web-admin/settings/runtime-panels'
import type { UiExtensionContext } from '@agnes/web-client'
import { createComputerUsePaneController } from '@agnes/web-conversation/computer-use-pane'
import { Button, Count, Icon, IconButton, Menu, Tabs, useUiText } from '@agnes/web-ui'
import { useEffect, useMemo, useState } from 'react'
import type { HomePageData } from './host.js'
import { HomePageFrame } from './page-frame.js'
import {
  type PluginView,
  useCandidateSources,
  usePageProgress,
  usePluginAdmin,
} from './plugins/admin-view.js'
import { MarketTab } from './plugins/market-tab.js'
import { PLUGINS_PAGE_NAMESPACE, pluginsPageCatalog } from './plugins/page-locale.js'
import { PluginStatus, PluginsTab } from './plugins/plugins-tab.js'
import { PluginsPushPages } from './plugins/push-pages.js'
import { ResourcesTab } from './plugins/resources-tab.js'
import { ReviewTab } from './plugins/review-tab.js'
import { openPlugins, PLUGIN_TABS, type PluginTab, pluginsRoute } from './plugins/route.js'
import { useCapabilitySummaries } from './plugins/summaries.js'

/** Drafts waiting for review, for the tab's number while another tab is showing. */
function usePendingReviews(api: PluginView['api']) {
  const [count, setCount] = useState(0)
  useEffect(() => {
    setCount(0)
    if (!api) return
    let alive = true
    let epoch = 0
    let checkedAt = Number.NEGATIVE_INFINITY
    let dirty = false
    let pending: Promise<void> | undefined
    const visible = () => document.visibilityState !== 'hidden'
    const read = () => {
      if (!alive || !visible() || pending) return
      pending = Promise.resolve().then(async () => {
        try {
          if (!alive || !visible()) return
          do {
            dirty = false
            const requested = epoch
            try {
              const value = await api.candidatesList()
              if (alive && requested === epoch) {
                checkedAt = Date.now()
                setCount(value.candidates.filter((item) => item.state === 'review').length)
              }
            } catch {
              checkedAt = Number.NEGATIVE_INFINITY
              // Retain the last confirmed count; a later invalidation can retry.
            }
          } while (alive && dirty && visible())
        } finally {
          pending = undefined
        }
      })
    }
    const invalidate = () => {
      epoch++
      dirty = true
      read()
    }
    const wake = () => {
      if (dirty || Date.now() - checkedAt >= 30_000) read()
    }
    read()
    window.addEventListener('agnes:plugins-invalidated', invalidate)
    window.addEventListener('agnes:candidate-count-changed', invalidate)
    window.addEventListener('agnes:candidates-changed', invalidate)
    window.addEventListener('focus', wake)
    document.addEventListener('visibilitychange', wake)
    return () => {
      alive = false
      window.removeEventListener('agnes:plugins-invalidated', invalidate)
      window.removeEventListener('agnes:candidate-count-changed', invalidate)
      window.removeEventListener('agnes:candidates-changed', invalidate)
      window.removeEventListener('focus', wake)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [api])
  return count
}

/**
 * Plugins, skills, MCP servers, drafts to review and the catalog: everything that extends Agnes.
 * Opening one thing (a plugin, a skill, a built-in, an add form) pushes its page in place of the
 * list, named in the address as `view=<page>`.
 */
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
  usePageProgress(!!view && view.state.loading && view.state.connection === 'loading')
  // A capability that moved to settings: its old link opens the page there, once. A link the app
  // starts with mounts this page before the workbench has finished starting, so wait for that.
  const moved = route.settings
  useEffect(() => {
    if (!moved) return
    const timer = setTimeout(() => {
      openPlugins('plugins')
      data.openSettings(moved)
    })
    return () => clearTimeout(timer)
  }, [moved, data])
  const pending = usePendingReviews(view?.api)
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
      <ResourcesTab
        tab={tab}
        t={t}
        workspaceId={data.plugins?.workspaceId?.()}
        canSave={view?.canEffect('packages.activate') ?? false}
        packageName={(id) => {
          const item = view?.state.installed.find((entry) => entry.id === id)
          return item
            ? resolvePluginMetadata(item.metadata, view?.locale.getSnapshot() ?? 'en')?.displayName
            : undefined
        }}
      />
    ) : !view ? null : tab === 'plugins' ? (
      <PluginsTab view={view} t={t} summaries={summaries} />
    ) : tab === 'review' ? (
      <ReviewTab view={view} t={t} pending={pending} sources={sources} />
    ) : (
      <MarketTab view={view} t={t} />
    )
  return (
    <>
      {/* The controller draws nothing here; it needs a connected node to own while it lives. */}
      <div ref={host} hidden />
      {
        <HomePageFrame
          id="plugins"
          pushTitle={context.t('home.entry.plugins')}
          title={context.t('home.entry.plugins')}
          description={context.t('home.plugins.description')}
          actions={
            <>
              {/* Skills and MCP refresh from their own toolbars. */}
              {route.tab === 'skills' || route.tab === 'mcp' ? null : (
                <IconButton
                  name="refresh-cw"
                  label={t('refresh')}
                  data-testid="plugins-refresh"
                  disabled={!view || view.state.loading}
                  onClick={() => {
                    void view?.refresh()
                    window.dispatchEvent(new Event('agnes:candidates-changed'))
                  }}
                />
              )}
              {route.tab === 'plugins' || route.tab === 'market' ? add : null}
            </>
          }
        >
          <PluginsPushPages
            route={route}
            view={view}
            t={t}
            summaries={summaries}
            computerUse={() => computerUse.renderCapability()}
          />
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
      }
    </>
  )
}
