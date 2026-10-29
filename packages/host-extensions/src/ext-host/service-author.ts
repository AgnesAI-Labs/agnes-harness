import {
  type BindableKind,
  ExtensionError,
  type ProjectionReader,
  type ServiceAuthorPort,
  type ServiceInstance,
  type ServicePorts,
  type ServiceProvider,
} from '@agnes/extension-api'
import type { KernelPorts } from './ports.js'

/** The embedding facade stamps its owner/package and uses Host's current admission factory. */
export function serviceAuthor(input: {
  owner: string
  packageId: string
  packageVersion: string
  trust: 'builtin' | 'trusted'
  projections: ProjectionReader
  alive(): void
  registering(): void
  ports(): KernelPorts | undefined
  checkGrants(
    grants:
      | {
          events: boolean
          projections: readonly string[]
          services?: readonly import('@agnes/extension-api').ServiceCapability[]
        }
      | undefined,
  ): void
  install(name: string, create: (ports: KernelPorts) => () => Promise<void>): () => Promise<void>
}): ServiceAuthorPort {
  const granted = (ports: KernelPorts | undefined) => {
    if (!ports?.serviceProviders)
      throw new ExtensionError('E_CAPABILITY_UNDECLARED', 'providers not granted', { extId: input.owner })
    return ports.serviceProviders
  }
  return Object.freeze({
    register<S extends ServiceInstance, P extends ServicePorts>(
      kind: BindableKind<S, P>,
      provider: NoInfer<ServiceProvider<S, P>>,
    ) {
      input.registering()
      return input.install(kind.kind, (ports) => {
        const services = granted(ports)
        input.checkGrants(services.grants?.(kind))
        return services.register(kind, provider, { owner: input.owner, packageId: input.packageId })
      })
    },
    bindOwn<S extends ServiceInstance, P extends ServicePorts>(kind: BindableKind<S, P>): Promise<S> {
      input.alive()
      const services = granted(input.ports())
      const recheck = () => {
        input.alive()
        input.checkGrants(services.grants?.(kind))
      }
      recheck()
      return services.bindOwn(kind, {
        owner: input.owner,
        packageId: input.packageId,
        packageVersion: input.packageVersion,
        trust: input.trust,
        projections: input.projections,
        recheck,
      })
    },
  })
}
