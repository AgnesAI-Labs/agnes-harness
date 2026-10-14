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

/** `?page=plugins&tab=<tab>`; a built-in capability's detail is `tab=plugins.<capability>`. */
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

export function openPlugins(tab: PluginTab, capability?: Capability): void {
  homeNavigation.open('plugins', { tab: capability ? `${CAPABILITY_PREFIX}${capability}` : tab })
}
