import { usePushStack } from '@agnes/web-ui'
import { type ReactNode, useEffect } from 'react'
import type { PluginView } from './admin-view.js'
import { CapabilityDetail } from './capabilities.js'
import { InstallReviewPage } from './install-page.js'
import { PluginPages } from './plugin-pages.js'
import {
  CAPABILITIES,
  openPlugins,
  type PluginsRoute,
  plainPluginsAddress,
  pluginPage,
  pluginPageTab,
} from './route.js'
import type { CapabilitySummaries } from './summaries.js'

type Text = (key: string, vars?: Readonly<Record<string, string | number>>) => string

/**
 * The pages pushed over the plugins page: the built-ins' details, the controller's detail and add
 * form, and the review of a checked install (skills, MCP and drafts declare theirs in their own tabs). It also keeps the address honest:
 * an older built-in link opens its page, a page shows under the tab it belongs to, and a page this
 * one does not know is left.
 */
export function PluginsPushPages({
  route,
  view,
  t,
  summaries,
  computerUse,
}: {
  route: PluginsRoute
  view: PluginView | undefined
  t: Text
  summaries: CapabilitySummaries
  /** Drawn only while the computer-use page is open. */
  computerUse(): ReactNode
}) {
  const pages = usePushStack()
  // An older link names a built-in by its tab: put the list's address in its place and open the
  // built-in over it, so back returns to the list.
  const linked = route.capability
  const openPage = pages.open
  useEffect(() => {
    if (!linked) return
    history.replaceState(history.state, '', plainPluginsAddress(location.href))
    openPlugins('plugins')
    openPage(linked)
  }, [linked, openPage])
  const top = pages.stack.at(-1)
  const topPage = top ? pluginPage(top) : undefined
  const topTab = topPage ? pluginPageTab(topPage) : undefined
  const leave = pages.back
  useEffect(() => {
    if (top && !topPage) leave()
    else if (topTab && topTab !== route.tab) {
      const url = new URL(location.href)
      url.searchParams.set('tab', topTab)
      history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`)
      openPlugins(topTab)
    }
  }, [top, topPage, topTab, route.tab, leave])
  return (
    <>
      {CAPABILITIES.map((capability) => (
        <CapabilityDetail
          key={capability}
          capability={capability}
          view={view}
          t={t}
          summary={summaries[capability]}
          computerUse={
            capability === 'computer-use' && pages.stack.includes(capability) ? computerUse() : null
          }
        />
      ))}
      <PluginPages view={view} />
      <InstallReviewPage view={view} />
    </>
  )
}
