import type { ContributionBinding } from '@agnes/protocol'
import { notifyListeners } from '@agnes/sdk/browser'
import { claimHomeEntry, registerOwnedHomeEntry } from './declared-home-entries.js'
import type { ModuleIdentity } from './service-contracts.js'
import type { HomeEntry } from './ui-registries.js'

export interface ContributionAvailability {
  getSnapshot(): ContributionBinding | undefined
  subscribe(listener: () => void): () => void
}
const availability = new Map<string, Set<{ revoke(): void; update(binding: ContributionBinding): void }>>()
export function contributionAvailability(
  module: ModuleIdentity,
  effect: (off: () => void) => void,
): ContributionAvailability {
  let binding = module.binding
  const listeners = new Set<() => void>()
  const owner = binding?.owner ?? module.rowId ?? module.packageId
  const stores =
    availability.get(owner) ?? new Set<{ revoke(): void; update(binding: ContributionBinding): void }>()
  const store = {
    update(next: ContributionBinding) {
      binding = next
      notifyListeners(listeners, 'contribution availability')
    },
    revoke() {
      if (binding)
        binding = { ...binding, availability: binding.lifetime === 'session' ? 'history-only' : 'disabled' }
      notifyListeners(listeners, 'contribution availability')
    },
  }
  stores.add(store)
  availability.set(owner, stores)
  effect(() => {
    store.revoke()
    stores.delete(store)
    if (!stores.size) availability.delete(owner)
  })
  return Object.freeze({
    getSnapshot: () => binding,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  })
}
/** Host roster projection, applied before asynchronous imports or teardown. */
export function updateContributionAvailability(owner: string, binding: ContributionBinding): void {
  if (binding.owner !== owner) throw new Error('Contribution owner mismatch')
  if (binding.availability !== 'active') revokeContributionOwner(owner)
  for (const store of availability.get(owner) ?? []) store.update(binding)
}
export function ownContribution(
  owner: string,
  off: () => void,
  effect: (off: () => void) => void,
): () => void {
  const set = owners.get(owner) ?? new Set<() => void>()
  let live = true
  const dispose = () => {
    if (!live) return
    live = false
    set.delete(dispose)
    if (!set.size && owners.get(owner) === set) owners.delete(owner)
    off()
  }
  set.add(dispose)
  owners.set(owner, set)
  effect(dispose)
  return dispose
}
const owners = new Map<string, Set<() => void>>()
/** Called before asynchronous fiber teardown, so revocation immediately hides global entries. */
export function revokeContributionOwner(owner: string): void {
  for (const off of [...(owners.get(owner) ?? [])]) {
    try {
      off()
    } catch {
      console.warn('[client-modules] contribution cleanup failed')
    }
  }
  owners.delete(owner)
  for (const store of availability.get(owner) ?? []) store.revoke()
}
export function scopedHomeEntries(module: ModuleIdentity, effect: (off: () => void) => void) {
  let live = true
  const owner = module.binding?.owner ?? module.rowId ?? module.packageId
  ownContribution(
    owner,
    () => {
      live = false
    },
    effect,
  )
  return Object.freeze({
    register(entry: HomeEntry): () => void {
      if (!live || module.binding?.lifetime !== 'profile' || module.binding.availability !== 'active')
        throw new Error('Home entries require an active profile contribution')
      const declared = module.homeEntries?.find((item) => item.id === entry.id)
      if (!declared || declared.placement !== (entry.placement ?? 'secondary'))
        throw new Error('Undeclared home entry placement')
      claimHomeEntry(module.binding.owner, entry.id)
      return ownContribution(module.binding.owner, registerOwnedHomeEntry(module.packageId, entry), effect)
    },
  })
}
