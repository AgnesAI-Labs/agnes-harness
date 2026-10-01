import { createReferenceRegistry, type ReferenceProvider, type ReferenceSlot } from './index.js'

export function loadReferencePlugin(providers: readonly ReferenceProvider[] = []): readonly ReferenceSlot[] {
  return createReferenceRegistry(providers)
}
