import type { LoopCatalogEntry, ModelAdapterCatalogEntry } from '@agnes/extension-api'
import type { AdminModelAdapter, AdminSessionSelection, ModelRecord } from '@agnes/protocol'
import { isSessionDefaultsSnapshot } from '@agnes/protocol'
import { ConfigurationError, type SessionDefaultsConfigurationService } from './configuration.js'

export interface HostAdminSessionCatalog {
  presets?(): Promise<readonly string[]>
  loops(): Promise<readonly LoopCatalogEntry[]>
  modelAdapters(): Promise<readonly ModelAdapterCatalogEntry[]>
  /** Models from configured runtime routes, never invented from adapter registration metadata. */
  models(adapter: ModelAdapterCatalogEntry): Promise<AdminModelAdapter['models']>
}

/** What a route's adapter has to tell a conversation entry point: its id and what it takes. */
type ServingAdapter = Readonly<{ id: string; capabilities: Readonly<{ payloadOnly?: boolean }> }>

/**
 * The declared routes whose adapter answers payload requests only. A route is served by the
 * registration whose id is the route's `api`, so that is the one asked, whatever wire API its models
 * name. A payload-only adapter takes a payload instead of messages: a conversation or a child agent
 * that selected one of these routes' models would fail at the adapter.
 */
export function payloadOnlyRoutes(
  adapters: readonly ServingAdapter[],
  routes: readonly Readonly<{ route: string; api: string }>[],
): ReadonlySet<string> {
  const payloadOnly = new Set(
    adapters.filter((adapter) => adapter.capabilities.payloadOnly === true).map((adapter) => adapter.id),
  )
  return new Set(routes.filter((route) => payloadOnly.has(route.api)).map((route) => route.route))
}

/**
 * The registered adapters with the models each one offers for conversations. A payload-only adapter
 * stays in the list, so an administrator sees it and what it takes, but it offers no model, and no
 * adapter lists a model of a route a payload-only adapter serves: every picker and every check that
 * reads these models then leaves them out.
 */
export function conversationModelAdapters(
  adapters: readonly ModelAdapterCatalogEntry[],
  models: readonly Pick<ModelRecord, 'id' | 'route' | 'api'>[],
  routes: readonly Readonly<{ route: string; api: string }>[],
): AdminModelAdapter[] {
  const blocked = payloadOnlyRoutes(adapters, routes)
  return adapters.map((entry) => ({
    ...entry,
    models:
      entry.capabilities.payloadOnly === true
        ? []
        : models
            .filter((model) => model.api === entry.wireApi && !blocked.has(model.route))
            .map((model) => ({ id: model.id, route: model.route })),
  }))
}

/** Compose real host catalogs with the existing locked, revisioned configuration storage. */
export function createAdminSessionSelection(
  catalog: HostAdminSessionCatalog,
  configuration: SessionDefaultsConfigurationService,
): AdminSessionSelection {
  const modelAdapters = async (): Promise<readonly AdminModelAdapter[]> =>
    Promise.all(
      (await catalog.modelAdapters()).map(async (entry) => ({
        ...entry,
        models: await catalog.models(entry),
      })),
    )
  return {
    ...(catalog.presets ? { presets: () => catalog.presets?.() ?? Promise.resolve([]) } : {}),
    loops: () => catalog.loops(),
    modelAdapters,
    getDefaults: () => configuration.sessionDefaults(),
    async saveDefaults(input) {
      if (!isSessionDefaultsSnapshot(input)) throw new ConfigurationError('CONFIG_INVALID_INPUT')
      const { preset, providers, model } = input.defaults
      const loop = providers?.loop
      const modelAdapter = providers?.['model-adapter']
      if (preset && !(await catalog.presets?.())?.includes(preset))
        throw new ConfigurationError('CONFIG_INVALID_INPUT')
      const [loops, adapters] = await Promise.all([catalog.loops(), modelAdapters()])
      if (loop && !loops.some((entry) => entry.id === loop.provider && entry.version === loop.version))
        throw new ConfigurationError('CONFIG_INVALID_INPUT')
      if (
        modelAdapter &&
        !adapters.some(
          (entry) =>
            entry.id === modelAdapter.provider &&
            entry.version === modelAdapter.version &&
            entry.models.some((candidate) => candidate.id === model),
        )
      )
        throw new ConfigurationError('CONFIG_MODEL_UNAVAILABLE')
      return configuration.saveSessionDefaults(input)
    },
  }
}
