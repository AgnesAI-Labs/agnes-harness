import { createRefinementProvider, REFINEMENT_SERVICE } from '@agnes/distribution'
import type { RefinementSettingsStore } from '@agnes/host-infrastructure/refinement-settings'
import type { Provider } from '@agnes/protocol'

export function refinementModel(store: RefinementSettingsStore, clock: () => number) {
  let cached: { revision: string; provider: Provider } | undefined
  return {
    target() {
      const { settings } = store.current()
      return settings.enabled ? { route: REFINEMENT_SERVICE.route, model: settings.model } : undefined
    },
    provider(): Provider | undefined {
      const { settings, revision, modelOption } = store.current()
      if (!settings.enabled) return undefined
      if (cached?.revision === revision) return cached.provider
      // Re-read at dispatch, including for a provider acquired before rotation or deletion.
      const key = () => {
        const now = store.current()
        const value =
          now.settings.enabled && now.revision === revision && store.serviceKey(settings.credentialRef)
        if (!value) throw new Error('Task experience service key unavailable')
        return value
      }
      const provider = createRefinementProvider(clock, key, settings.baseUrl, {
        ...modelOption,
        modelId: settings.model,
      })
      cached = { revision, provider }
      return provider
    },
  }
}
