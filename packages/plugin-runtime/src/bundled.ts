import {
  type Disposer,
  ExtensionError,
  PLUGIN_FACET_NAMES,
  type PluginContextFacets,
  type PluginFacetName,
} from '@agnes/extension-api'
import type { ExtensionAPI, ExtensionFactory } from '@agnes/extension-api/host'

/**
 * The part of an `AgnesPlugin` a bundled package is mounted through. The Host calls `apply` with
 * the facets named in `inject`; there is no Cordis fiber, so nothing else is on the context.
 */
export type BundledPlugin = Readonly<{
  inject?: readonly string[] | Readonly<{ required?: readonly string[]; optional?: readonly string[] }>
  // biome-ignore lint/suspicious/noConfusingVoidType: a plugin may return nothing, a Disposer, or a promise of either
  apply(ctx: never, config?: never): void | Disposer | Promise<void | Disposer>
}>

export function isBundledPlugin(value: unknown): value is BundledPlugin {
  return (
    typeof value === 'object' && value !== null && typeof (value as { apply?: unknown }).apply === 'function'
  )
}

function injected(plugin: BundledPlugin): readonly string[] {
  const { inject } = plugin
  if (inject === undefined) return []
  if (Array.isArray(inject)) return inject as readonly string[]
  const lists = inject as { required?: readonly string[]; optional?: readonly string[] }
  return [...(lists.required ?? []), ...(lists.optional ?? [])]
}

function facetsOver(api: ExtensionAPI): PluginContextFacets {
  const refuse = (what: string): never => {
    throw new ExtensionError('E_CAPABILITY_UNDECLARED', `${what} is not open to bundled plugins`, {
      extId: api.ctx.extId,
    })
  }
  // Each facet is built on first use, so a plugin that injects nothing never touches the backend.
  const facets: { [K in PluginFacetName]: () => PluginContextFacets[K] } = {
    tools: () => ({ register: (def) => api.registerTool(def) }),
    hooks: () => ({ register: (event, handler) => api.registerHook(event, handler) }),
    projections: () => ({ register: (def) => api.registerProjection(def) }),
    services: () => ({ register: (def) => api.registerService(def) }),
    slots: () => ({ register: (slot, fill) => api.registerSlot(slot, fill) }),
    resources: () => ({ register: (entry) => api.registerResource(entry) }),
    eventLog: () => ({ append: (name, data) => api.events.append(name, data) }),
    providers: () => ({
      register: (kind, provider) => api.providers.register(kind as never, provider as never) as never,
      bindOwn: (kind) => api.providers.bindOwn(kind),
      catalog: () => refuse('provider catalog'),
      resolve: () => refuse('provider resolution'),
    }),
    profileRuntime: () => refuse('profile runtime'),
    self: () => api.ctx,
  }
  return new Proxy({} as PluginContextFacets, {
    get: (_target, name) => facets[name as PluginFacetName]?.(),
  })
}

/** Runs a bundled plugin over the backend API. The same `apply` body runs for any package. */
export function extensionFactoryOf(plugin: BundledPlugin): ExtensionFactory {
  const names = injected(plugin)
  const unknown = names.filter((name) => !(PLUGIN_FACET_NAMES as readonly string[]).includes(name))
  return (api) => {
    if (unknown.length > 0)
      throw new ExtensionError('E_CAPABILITY_UNDECLARED', `unknown plugin facet: ${unknown.join(', ')}`, {
        extId: api.ctx.extId,
      })
    const all = facetsOver(api)
    const ctx: Record<string, unknown> = {}
    for (const name of names)
      Object.defineProperty(ctx, name, { enumerable: true, get: () => all[name as PluginFacetName] })
    return (plugin.apply as (ctx: object) => ReturnType<ExtensionFactory>)(Object.freeze(ctx))
  }
}
