import { homeNavigation } from '@agnes/web-client'

export const PLUGIN_TABS = ['plugins', 'skills', 'mcp', 'review', 'market'] as const
export type PluginTab = (typeof PLUGIN_TABS)[number]
/** Built-in capabilities that are not packages; each opens a detail whose settings tab holds its configuration. */
export const CAPABILITIES = ['search', 'computer-use', 'subagents', 'execution', 'memory', 'context'] as const
export type Capability = (typeof CAPABILITIES)[number]
export type PluginsRoute = Readonly<{ tab: PluginTab; capability?: Capability }>

const CAPABILITY_PREFIX = 'plugins.'

/** `?page=plugins&tab=<tab>`; a built-in capability's detail is `tab=plugins.<capability>`. */
export function pluginsRoute(selection: unknown): PluginsRoute {
  const raw = (selection as { tab?: unknown } | undefined)?.tab
  if (typeof raw !== 'string') return { tab: 'plugins' }
  if (raw.startsWith(CAPABILITY_PREFIX)) {
    const capability = CAPABILITIES.find((id) => id === raw.slice(CAPABILITY_PREFIX.length))
    return capability ? { tab: 'plugins', capability } : { tab: 'plugins' }
  }
  return { tab: PLUGIN_TABS.find((id) => id === raw) ?? 'plugins' }
}

export function openPlugins(tab: PluginTab, capability?: Capability): void {
  homeNavigation.open('plugins', { tab: capability ? `${CAPABILITY_PREFIX}${capability}` : tab })
}
