import type { PluginAdminSources } from '@agnes/web-admin/admin/plugins/admin'
import {
  homeEntries,
  homeNavigation,
  type LocaleService,
  resolveHomeEntry,
  type UiExtensionContext,
} from '@agnes/web-client'
import {
  createDocumentLocaleSource,
  createRegionRenderer,
  preserveRouteParams,
  RegionErrorBoundary,
  UiLocaleProvider,
  type UiLocaleSource,
} from '@agnes/web-ui'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useWorkLaunchQuiet, workLaunch } from './work-launch.js'

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
  /** The selected workspace's path when it is available; agent launches start there instead of the launcher's. */
  selectedWorkspace?(): string | undefined
  /** Start a new session draft with this text in the composer. */
  startDraft(prompt?: string): void
  /** What this browser has loaded of each plugin, for the plugins page's run state. */
  plugins?: Pick<PluginAdminSources, 'actualSlots' | 'runtime'> & {
    /** The workspace whose skills and MCP servers the page lists. */
    workspaceId?(): string | undefined
  }
}>

/** The entry the user asked for and that is still registered, showing or not. */
function requestedHomeEntry() {
  const requested = homeNavigation.getSnapshot()
  return requested?.pageRef
    ? resolveHomeEntry(requested.pageRef)
    : requested
      ? homeEntries.get(requested.id)
      : undefined
}

/** The entry whose page is showing; a quiet launch keeps its page mounted but out of sight. */
export const activeHomeEntry = () => (workLaunch.quiet() ? undefined : requestedHomeEntry())

/** Calls `listener` whenever `activeHomeEntry` can change: a navigation, or a launch surfacing or ending. */
export function watchActiveHomeEntry(listener: () => void): () => void {
  const stops = [homeNavigation.subscribe(listener), workLaunch.subscribe(listener)]
  return () => {
    for (const stop of stops) stop()
  }
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
  const entry = requestedHomeEntry()
  // A synchronous unload/reload can be batched into one render. A new registration owns a new
  // component lifetime even when it reuses the same ID and component function.
  const mounted = useRef({ entry, version: 0 })
  if (mounted.current.entry !== entry) mounted.current = { entry, version: mounted.current.version + 1 }
  const quiet = useWorkLaunchQuiet()
  const active = quiet ? undefined : entry?.id
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

const LEGACY_PAGES: Readonly<Record<string, string>> = {
  'business-agents': 'agents',
  'business-agent': 'agents',
  'agent-fde': 'agents',
  fde: 'agents',
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
        const owner = params.get('pagePackage')
        const destination = !owner && Object.hasOwn(LEGACY_PAGES, page) ? (LEGACY_PAGES[page] ?? page) : page
        if (destination !== page) {
          const url = new URL(location.href)
          url.searchParams.set('page', destination)
          history.replaceState(history.state, '', preserveRouteParams(url))
        }
        if (owner) homeNavigation.openRef(`${owner}#${destination}`, tab ? { tab } : undefined)
        else homeNavigation.open(destination, tab ? { tab } : undefined)
      } else homeNavigation.close()
    } finally {
      restoring = false
    }
  }
  readLocation()
  const stop = homeNavigation.subscribe(() => {
    if (restoring) return
    const requested = homeNavigation.getSnapshot()
    // App defaults are transient presentation, not explicit URL/user choices.
    if ((requested?.selection as { applicationDefault?: string } | undefined)?.applicationDefault) return
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
    if (requested?.pageRef)
      url.searchParams.set('pagePackage', requested.pageRef.slice(0, requested.pageRef.indexOf('#')))
    else url.searchParams.delete('pagePackage')
    if (requested && typeof tab === 'string') url.searchParams.set('tab', tab)
    else url.searchParams.delete('tab')
    const address = preserveRouteParams(url)
    if (new URL(address, location.href).href !== before) history.pushState(null, '', address)
  })
  window.addEventListener('popstate', readLocation)
  return () => {
    stop()
    window.removeEventListener('popstate', readLocation)
  }
}
