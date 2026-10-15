import type { ContributionBinding } from '@agnes/protocol'
import type { ModuleIdentity } from './service-contracts.js'
import { type HomeEntry, homeEntries } from './ui-registries.js'

export interface ContributionAvailability {
  getSnapshot(): ContributionBinding | undefined
  subscribe(listener: () => void): () => void
}
const owners = new Map<string, Set<() => void>>()
/** Called before asynchronous fiber teardown, so revocation immediately hides global entries. */
export function revokeContributionOwner(owner: string): void {
  for (const off of [...(owners.get(owner) ?? [])]) off()
  owners.delete(owner)
}
export function scopedHomeEntries(module: ModuleIdentity, effect: (off: () => void) => void) {
  return Object.freeze({
    register(entry: HomeEntry): () => void {
      if (module.binding?.lifetime !== 'profile' || module.binding.availability !== 'active')
        throw new Error('Home entries require an active profile contribution')
      const declared = module.homeEntries?.find((item) => item.id === entry.id)
      if (!declared || declared.placement !== (entry.placement ?? 'secondary'))
        throw new Error('Undeclared home entry placement')
      const owner = module.binding.owner
      const dispose = homeEntries.register(entry)
      const set = owners.get(owner) ?? new Set<() => void>()
      const off = () => {
        dispose()
        set.delete(off)
      }
      set.add(off)
      owners.set(owner, set)
      effect(off)
      return off
    },
  })
}
