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

/** What a model's adapter has to tell a conversation entry point: which API it serves and what it takes. */
type ServingAdapter = Readonly<{ wireApi: string; capabilities: Readonly<{ payloadOnly?: boolean }> }>

/**
 * Whether a model on `api` answers payload requests only. A payload-only adapter takes a payload
 * instead of messages, so a conversation that selected one of its models would fail at the adapter.
 * When several registered adapters serve the same API the model stays selectable: any of them may
 * be the one that takes messages.
 */
export function isPayloadOnlyApi(adapters: readonly ServingAdapter[], api: string): boolean {
  const serving = adapters.filter((adapter) => adapter.wireApi === api)
  return serving.length > 0 && serving.every((adapter) => adapter.capabilities.payloadOnly === true)
}

/**
 * The registered adapters with the models each one offers for conversations. A payload-only adapter
 * stays in the list, so an administrator sees it and what it takes, but it offers no model: every
 * picker and every check that reads these models then leaves it out.
 */
export function conversationModelAdapters(
  adapters: readonly ModelAdapterCatalogEntry[],
  models: readonly Pick<ModelRecord, 'id' | 'route' | 'api'>[],
): AdminModelAdapter[] {
  return adapters.map((entry) => ({
    ...entry,
    models:
      entry.capabilities.payloadOnly === true
        ? []
        : models
            .filter((model) => model.api === entry.wireApi)
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
