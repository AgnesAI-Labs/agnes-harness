import type { ProviderFactory, ServiceProvider } from '@agnes/extension-api/runtime'
import { createReferenceIdentityProviderFactory, type ReferenceIdentityPorts } from './providers/identity.js'

export function independentIdentityConsumer(ports: ReferenceIdentityPorts): ProviderFactory<ServiceProvider> {
  return createReferenceIdentityProviderFactory(ports)
}
