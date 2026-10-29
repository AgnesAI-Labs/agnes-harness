import { homeNavigation } from '@agnes/web-client'

export const PLUGIN_TABS = ['plugins', 'skills', 'mcp', 'review', 'market'] as const
export type PluginTab = (typeof PLUGIN_TABS)[number]
/** Built-in capabilities that are not packages; each opens a detail whose settings tab holds its configuration. */
export const CAPABILITIES = ['search', 'computer-use', 'subagents'] as const
export type Capability = (typeof CAPABILITIES)[number]
export type PluginsRoute = Readonly<{ tab: PluginTab; capability?: Capability; settings?: string }>

const CAPABILITY_PREFIX = 'plugins.'
/**
 * Capabilities that had a detail here and are configured in settings now, by the settings page
 * that holds them: the execution mode is a new-session default in run configuration; memory and
 * the custom instructions are the reader's own, on General.
 */
const MOVED_TO_SETTINGS: Readonly<Record<string, string>> = {
  execution: 'models',
  memory: 'general',
  context: 'general',
}

/**
 * `?page=plugins&tab=<tab>`. An older link names a built-in as `tab=plugins.<capability>`; the page
 * opens it as a pushed page (`view=<capability>`).
 */
export function pluginsRoute(selection: unknown): PluginsRoute {
  const raw = (selection as { tab?: unknown } | undefined)?.tab
  if (typeof raw !== 'string') return { tab: 'plugins' }
  if (raw.startsWith(CAPABILITY_PREFIX)) {
    const id = raw.slice(CAPABILITY_PREFIX.length)
    const capability = CAPABILITIES.find((known) => known === id)
    if (capability) return { tab: 'plugins', capability }
    const settings = Object.hasOwn(MOVED_TO_SETTINGS, id) ? MOVED_TO_SETTINGS[id] : undefined
    return settings ? { tab: 'plugins', settings } : { tab: 'plugins' }
  }
  return { tab: PLUGIN_TABS.find((id) => id === raw) ?? 'plugins' }
}

export function openPlugins(tab: PluginTab): void {
  homeNavigation.open('plugins', { tab })
}

/** The address parameter that names the pages pushed over the plugins page. */
export const PLUGIN_VIEW_PARAM = 'view'

/**
 * A page pushed over the plugins page: a built-in's detail, an installed plugin, a marketplace
 * entry, a skill or MCP server, a review item, running a skill in a new session (`run:<skill>`), the
 * review of a checked install or update (`install:<id>`), or one of the add forms (a plugin, an MCP
 * server, a search service under Web search). `operations` lists running operations, on request.
 */
export type PluginPage =
  | Readonly<{ kind: 'capability'; id: Capability }>
  | Readonly<{ kind: 'plugin' | 'market' | 'skill' | 'mcp' | 'review' | 'run' | 'install'; id: string }>
  | Readonly<{ kind: 'add-plugin' | 'add-mcp' | 'operations' | 'search-engine' }>

const ITEM_KINDS = ['plugin', 'market', 'skill', 'mcp', 'review', 'run', 'install'] as const
const FORM_KINDS = ['add-plugin', 'add-mcp', 'operations', 'search-engine'] as const

/** The route segment for a page: `search`, `plugin:<id>`, `add-plugin`. */
export function pluginPageId(page: PluginPage): string {
  if (page.kind === 'capability') return page.id
  return 'id' in page ? `${page.kind}:${page.id}` : page.kind
}

/** The page a route segment names, or undefined for one this page does not know. */
export function pluginPage(segment: string): PluginPage | undefined {
  const capability = CAPABILITIES.find((id) => id === segment)
  if (capability) return { kind: 'capability', id: capability }
  const form = FORM_KINDS.find((kind) => kind === segment)
  if (form) return { kind: form }
  const colon = segment.indexOf(':')
  if (colon < 1 || colon === segment.length - 1) return undefined
  const kind = ITEM_KINDS.find((known) => known === segment.slice(0, colon))
  return kind ? { kind, id: segment.slice(colon + 1) } : undefined
}

/** The tab a page is opened from; its list stays under it. Undefined keeps the current tab. */
export function pluginPageTab(page: PluginPage): PluginTab | undefined {
  switch (page.kind) {
    case 'capability':
    case 'plugin':
      return 'plugins'
    case 'market':
      return 'market'
    case 'skill':
    case 'run':
      return 'skills'
    case 'mcp':
    case 'add-mcp':
      return 'mcp'
    case 'review':
      return 'review'
    default:
      return undefined
  }
}

/**
 * An address written before details were pages names a built-in by its tab
 * (`tab=plugins.<capability>`). Its page is pushed now: this is the plain plugins address to put in
 * its place, after which the page opens over it, so back returns to the list.
 */
export function plainPluginsAddress(href: string): string {
  const url = new URL(href)
  url.searchParams.set('tab', 'plugins')
  url.searchParams.delete(PLUGIN_VIEW_PARAM)
  return `${url.pathname}${url.search}${url.hash}`
}
