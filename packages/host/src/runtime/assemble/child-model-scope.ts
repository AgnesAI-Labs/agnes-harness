import { type Provider, setChildModelScope } from '@agnes/core'
import type { ModelAdapterCatalogEntry } from '@agnes/extension-api'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { payloadOnlyRoutes } from '@agnes/host-infrastructure/admin-session-selection'

/**
 * A child agent holds a conversation, so it cannot run on a route a payload-only adapter serves.
 * Only its choice is limited: the provider still publishes the model, so a side call can target it.
 * Both inputs are read per call, because a model-profile update swaps the profile and the routes
 * under it.
 */
export function limitChildModels(
  provider: Provider,
  adapters: () => readonly ModelAdapterCatalogEntry[],
  profile: () => ResolvedProfile,
): void {
  setChildModelScope(
    provider,
    (model) => !payloadOnlyRoutes(adapters(), profile().provider.routes ?? []).has(model.route),
  )
}
