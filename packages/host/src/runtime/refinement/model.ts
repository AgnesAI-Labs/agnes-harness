import { createRefinementProvider, REFINEMENT_MODEL } from '@agnes/distribution'
import type { RefinementSettingsStore } from '@agnes/host-infrastructure/refinement-settings'
import type { Provider } from '@agnes/protocol'

export function refinementModel(store: RefinementSettingsStore, clock: () => number) {
  const { route, modelId } = REFINEMENT_MODEL
  const target = { route, model: modelId }
  let cached: { revision: string; provider: Provider } | undefined
  return {
    target,
    provider(): Provider | undefined {
      const { settings, revision } = store.current()
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
      const provider = createRefinementProvider(clock, key)
      cached = { revision, provider }
      return provider
    },
  }
}
