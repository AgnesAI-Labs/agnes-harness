import type { LoopCatalogEntry } from '@agnes/extension-api'
import type { AdminSessionCatalog, AdminSessionSelection } from '@agnes/protocol'
import { isSessionDefaultsSnapshot } from '@agnes/protocol'
import { ConfigurationError, type SessionDefaultsConfigurationService } from './configuration.js'

export interface HostAdminSessionCatalog extends AdminSessionCatalog {
  loops(): Promise<readonly LoopCatalogEntry[]>
}

/** Compose real host catalogs with the existing locked, revisioned configuration storage. */
export function createAdminSessionSelection(
  catalog: HostAdminSessionCatalog,
  configuration: SessionDefaultsConfigurationService,
): AdminSessionSelection {
  return {
    loops: () => catalog.loops(),
    modelAdapters: () => catalog.modelAdapters(),
    getDefaults: () => configuration.sessionDefaults(),
    async saveDefaults(input) {
      if (!isSessionDefaultsSnapshot(input)) throw new ConfigurationError('CONFIG_INVALID_INPUT')
      const { loop, modelAdapter } = input.defaults
      const [loops, adapters] = await Promise.all([catalog.loops(), catalog.modelAdapters()])
      if (loop && !loops.some((entry) => entry.id === loop.id && entry.version === loop.version))
        throw new ConfigurationError('CONFIG_INVALID_INPUT')
      if (
        modelAdapter &&
        !adapters.some(
          (entry) =>
            entry.id === modelAdapter.id &&
            entry.version === modelAdapter.version &&
            entry.models.some((model) => model.id === modelAdapter.model),
        )
      )
        throw new ConfigurationError('CONFIG_MODEL_UNAVAILABLE')
      return configuration.saveSessionDefaults(input)
    },
  }
}
