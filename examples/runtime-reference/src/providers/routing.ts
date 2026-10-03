import type { ProviderFactory, RoutingDeployment, ServiceProvider } from '@agnes/extension-api/runtime'
import { createRoutingStrategyFactory, defineRoutingStrategy } from '@agnes/extension-api/runtime'

/** Independent policy: deterministic model/id order over the supplied authorized snapshot. */
export function createReferenceRoutingFactory<C, B, M>(
  deployment: RoutingDeployment<C, B, M>,
): ProviderFactory<ServiceProvider> {
  return createRoutingStrategyFactory(
    defineRoutingStrategy<C>({
      id: 'reference-routing',
      select(input) {
        const required = input.requiredFeatures
        const candidates = input.allowedRoutes.filter(
          (route) =>
            route.catalogRevision === input.catalogRevision &&
            required.input.every((kind) => route.features.input.includes(kind)) &&
            required.output.every((kind) => route.features.output.includes(kind)) &&
            (!required.tools || route.features.tools) &&
            (!required.structuredOutput || route.features.structuredOutput) &&
            (!required.streaming || route.features.streaming),
        )
        const route = candidates.sort(
          (a, b) => a.model.localeCompare(b.model) || a.routeId.localeCompare(b.routeId),
        )[0]
        if (!route) throw new Error('No compatible candidate')
        return { route, reason: 'Deterministic reference rule' }
      },
    }),
    deployment,
  )
}
