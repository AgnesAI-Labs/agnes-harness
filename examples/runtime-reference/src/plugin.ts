import { createReferenceRegistry, type ReferenceProvider, type ReferenceSlot } from './index.js'
import { registeredReferenceProviders } from './register.js'

export function loadReferencePlugin(
  providers: readonly ReferenceProvider[] = registeredReferenceProviders,
): readonly ReferenceSlot[] {
  return createReferenceRegistry(providers)
}
