import type { PluginAdminSources } from '@agnes/web-admin/admin/plugins/admin'
import { homeEntries, homeNavigation, type LocaleService, type UiExtensionContext } from '@agnes/web-client'
import {
  createDocumentLocaleSource,
  createRegionRenderer,
  RegionErrorBoundary,
  UiLocaleProvider,
  type UiLocaleSource,
} from '@agnes/web-ui'
import { useEffect, useRef, useSyncExternalStore } from 'react'

/**
 * What the workbench hands a built-in home page as `context.data`. Plugin pages receive it too but
 * should use their own client services; this shape is not part of the public contract.
 */
export type HomePageData = Readonly<{
  /** A daemon RPC through the page's connection. */
  call<T = unknown>(method: string, params: unknown): Promise<T>
  /** The selected session, for panels scoped to it. */
  sessionId(): string | undefined
  /** Open the settings dialog at one of its sections. */
  openSettings(section: string): void
  /** Start a new session draft with this text in the composer. */
  startDraft(prompt?: string): void
  /** What this browser has loaded of each plugin, for the plugins page's run state. */
  plugins?: Pick<PluginAdminSources, 'actualSlots' | 'runtime'> & {
    /** The workspace whose skills and MCP servers the page lists. */
    workspaceId?(): string | undefined
  }
}>

/** The entry whose page is showing: requested and still registered. */
export function activeHomeEntry() {
  const requested = homeNavigation.getSnapshot()
  return requested ? homeEntries.get(requested.id) : undefined
}

export function HomePageHost({
  locale,
  source,
  data,
  onActive,
}: {
  locale: LocaleService
  /** Panels written for the admin surfaces read their own catalogs in the document's language. */
  source: UiLocaleSource
  data: HomePageData
  onActive(id: string | undefined): void
}) {
  useSyncExternalStore(homeEntries.subscribe, homeEntries.getSnapshot)
  const requested = useSyncExternalStore(homeNavigation.subscribe, homeNavigation.getSnapshot)
  const entry = requested ? homeEntries.get(requested.id) : undefined
  // A synchronous unload/reload can be batched into one render. A new registration owns a new
  // component lifetime even when it reuses the same ID and component function.
  const mounted = useRef({ entry, version: 0 })
  if (mounted.current.entry !== entry) mounted.current = { entry, version: mounted.current.version + 1 }
  const active = entry?.id
  useEffect(() => onActive(active), [active, onActive])
  if (!entry) return null
  const Page = entry.component
  const context: UiExtensionContext = {
    t: (key, vars) => locale.t(key, vars),
    data,
    ...(requested?.selection === undefined ? {} : { selection: requested.selection }),
  }
  return (
    <UiLocaleProvider source={source}>
      <RegionErrorBoundary key={`${entry.id}:${mounted.current.version}`} region={`home-page-${entry.id}`}>
        <Page context={context} />
      </RegionErrorBoundary>
    </UiLocaleProvider>
  )
}

/**
 * Show the selected home entry's page in `container`. While a page shows, `main` carries
 * `data-home-page="<id>"`: the stylesheet hides the conversation, docks and composer behind it.
 */
export function mountHomePages(
  container: HTMLElement,
  options: { locale: LocaleService; data: HomePageData; onChange?(id: string | undefined): void },
): { dispose(): void } {
  const main = container.closest('main')
  const onActive = (id: string | undefined) => {
    container.hidden = !id
    if (id) main?.setAttribute('data-home-page', id)
    else main?.removeAttribute('data-home-page')
    options.onChange?.(id)
  }
  const root = createRegionRenderer(container)
  const documentLocale = createDocumentLocaleSource({})
  const render = () =>
    root.render(
      <HomePageHost
        locale={options.locale}
        source={documentLocale.source}
        data={options.data}
        onActive={onActive}
      />,
    )
  render()
  const stopLocale = options.locale.subscribe(render)
  return {
    dispose() {
      stopLocale()
      documentLocale.dispose()
      root.unmount()
      onActive(undefined)
    },
  }
}

const PAGE_ID = /^[a-z][a-z0-9.-]*$/

/**
 * Keep `?page=<id>` (and `&tab=<name>` when the selection names a tab) in step with the requested
 * page. A link that names a page opens it once its entry registers.
 */
export function bindHomeRouting(): () => void {
  let restoring = false
  const readLocation = () => {
    const params = new URLSearchParams(location.search)
    const page = params.get('page')
    restoring = true
    try {
      if (page && PAGE_ID.test(page)) {
        const tab = params.get('tab')
        homeNavigation.open(page, tab ? { tab } : undefined)
      } else homeNavigation.close()
    } finally {
      restoring = false
    }
  }
  readLocation()
  const stop = homeNavigation.subscribe(() => {
    if (restoring) return
    const requested = homeNavigation.getSnapshot()
    const url = new URL(location.href)
    const before = url.href
    const tab = (requested?.selection as { tab?: unknown } | undefined)?.tab
    // A page opened inside a page (`view=…`) belongs to that page and tab; another one starts at its top.
    if (
      url.searchParams.get('page') !== (requested?.id ?? null) ||
      url.searchParams.get('tab') !== (typeof tab === 'string' ? tab : null)
    )
      url.searchParams.delete('view')
    if (requested) url.searchParams.set('page', requested.id)
    else url.searchParams.delete('page')
    if (requested && typeof tab === 'string') url.searchParams.set('tab', tab)
    else url.searchParams.delete('tab')
    if (url.href !== before) history.pushState(history.state, '', `${url.pathname}${url.search}${url.hash}`)
  })
  window.addEventListener('popstate', readLocation)
  return () => {
    stop()
    window.removeEventListener('popstate', readLocation)
  }
}
