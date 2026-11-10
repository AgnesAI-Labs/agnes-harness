import { type Provider, setChildModelScope } from '@agnes/core'
import type { ModelAdapterCatalogEntry } from '@agnes/extension-api'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { payloadOnlyRoutes } from '@agnes/host-infrastructure/admin-session-selection'

/**
 * A child agent holds a conversation, so it cannot run on a route a payload-only adapter serves, and
 * it cannot run on a route that was fitted without a credential: its first request would
 * answer AUTH. Only its choice is limited: the provider still publishes the model, so a side call
 * can target it and a client can still configure the route. Every input is read per call, because a
 * model-profile update swaps the profile, the routes under it and the credentials that resolved.
 */
export function limitChildModels(
  provider: Provider,
  adapters: () => readonly ModelAdapterCatalogEntry[],
  profile: () => ResolvedProfile,
  uncredentialedRoutes: () => readonly string[],
): void {
  setChildModelScope(provider, (model) => {
    if (payloadOnlyRoutes(adapters(), profile().provider.routes ?? []).has(model.route)) return false
    return uncredentialedRoutes().includes(model.route) ? 'no-credential' : true
  })
}
