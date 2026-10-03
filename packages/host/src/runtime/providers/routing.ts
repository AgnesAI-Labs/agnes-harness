import type { ProviderFactory, RoutingDeployment, ServiceProvider } from '@agnes/extension-api/runtime'
import {
  createRoutingStrategyFactory,
  defineRoutingStrategy,
  routeSupports,
} from '@agnes/extension-api/runtime'

/** Fixed installation priority; the supplied snapshot already bounds authorized candidates. */
export type DefaultRoutingDeployment<C, B, M> = RoutingDeployment<C, B, M> & {
  readonly priority: readonly string[]
}

export function createDefaultRoutingFactory<C, B, M>(
  deployment: DefaultRoutingDeployment<C, B, M>,
): ProviderFactory<ServiceProvider> {
  const priority = [...deployment.priority]
  if (new Set(priority).size !== priority.length) throw new TypeError('Duplicate routing priority')
  return createRoutingStrategyFactory(
    defineRoutingStrategy<C>({
      id: 'default-routing',
      select(input) {
        const eligible = input.allowedRoutes.filter((route) => routeSupports(route, input))
        for (const id of priority) {
          const route = eligible.find((candidate) => candidate.routeId === id)
          if (route) return { route, reason: 'Fixed configured priority' }
        }
        throw new Error('No configured compatible route')
      },
    }),
    deployment,
  )
}
