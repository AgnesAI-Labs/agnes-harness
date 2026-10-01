import type {
  BoundService,
  CallContext,
  ProviderFactory,
  ServiceProvider,
  TrustedIngressContext,
} from '@agnes/extension-api/runtime'
import type { ServiceOperation, ServiceQuery } from '@agnes/protocol/runtime'
import {
  createIdentityProviderFactory,
  type IdentityDeploymentPorts,
} from '../../src/runtime/providers/identity.js'

export function identityConsumer(ports: IdentityDeploymentPorts): ProviderFactory<ServiceProvider> {
  return createIdentityProviderFactory(ports)
}
export function identityBoundary(
  provider: ServiceProvider,
  ordinary: BoundService,
  request: ServiceOperation,
  query: ServiceQuery,
  call: CallContext,
  ingress: TrustedIngressContext,
): void {
  void provider.ingress?.(request, ingress)
  void provider.query?.(query, call)
  // @ts-expect-error Bootstrap accepts trusted ingress, not an already authenticated business context.
  void provider.ingress?.(request, call)
  // @ts-expect-error A transport envelope cannot authorize current business reads.
  void provider.query?.(query, ingress)
  // @ts-expect-error Ordinary service bindings do not expose Identity ingress authority.
  void ordinary.ingress(request, ingress)
}
