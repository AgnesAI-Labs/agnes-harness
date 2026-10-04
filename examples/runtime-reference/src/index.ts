import { discoverContracts, providerFileForContract } from '@agnes/extension-api/testkit'

export interface ReferenceProvider {
  readonly id: string
  readonly contract: string
}

export interface ReferenceSlot {
  readonly contract: string
  readonly major: number
  readonly methods: readonly string[]
  readonly providerFile: string
  readonly provider: ReferenceProvider | null
}

export function createReferenceRegistry(
  providers: readonly ReferenceProvider[] = [],
): readonly ReferenceSlot[] {
  const byContract = new Map<string, ReferenceProvider>()
  for (const provider of providers) {
    if (byContract.has(provider.contract)) {
      throw new Error(`provider already registered for ${provider.contract}`)
    }
    byContract.set(provider.contract, provider)
  }
  const slots = discoverContracts().map((item) => ({
    contract: item.contract,
    major: item.major,
    methods: item.methods,
    providerFile: providerFileForContract(item.contract),
    provider: byContract.get(item.contract) ?? null,
  }))
  for (const provider of byContract.values()) {
    if (!slots.some((slot) => slot.contract === provider.contract)) {
      throw new Error(`provider contract is not in the catalog: ${provider.contract}`)
    }
  }
  return slots
}

export type {
  ReferencePriceRule,
  ReferencePricingOptions,
  ReferencePricingOwner,
} from './providers/pricing.js'
export { createReferencePricingFactory } from './providers/pricing.js'
