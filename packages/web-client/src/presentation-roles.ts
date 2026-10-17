import { SlotCore } from '@agnes/web-slots'
import { ownContribution } from './contribution-scope.js'
import type { ModuleIdentity } from './service-contracts.js'

export type PresentationProvider = Readonly<{
  role: string
  /** Lower wins, as for single slots. Equal priorities are rejected. */
  priority?: number
  /** Register the complete experience; cleanup must synchronously revoke every registration. */
  mount(): () => void
}>

/** One active owner across all placements of a presentation, using the single-slot election. */
export class PresentationRoleRegistry {
  private readonly core = new SlotCore()
  private readonly active = new Map<string, { entry: unknown; stop: () => void }>()
  register(owner: string, provider: PresentationProvider): () => void {
    const { role } = provider
    if (!/^[a-z][a-z0-9.-]{0,127}$/.test(role)) throw new Error('Invalid presentation role')
    if (!this.core.spec(role))
      this.core.declare(role, { kind: 'single', scope: 'root' }, 'presentation roles')
    const remove = this.core.register({ name: role, owner, priority: provider.priority ?? 0 }, provider)
    const reconcile = () => {
      const next = this.core.entriesOfSlot(role)[0]
      const previous = this.active.get(role)
      if (previous?.entry === next) return
      previous?.stop()
      this.active.delete(role)
      if (next) {
        const stop = (next.component as PresentationProvider).mount()
        this.active.set(role, { entry: next, stop })
      }
    }
    try {
      reconcile()
    } catch (error) {
      remove()
      reconcile()
      throw error
    }
    let live = true
    return () => {
      if (!live) return
      live = false
      remove()
      reconcile()
    }
  }
}

export const presentationRoles = new PresentationRoleRegistry()
export function scopedPresentationRoles(module: ModuleIdentity, effect: (off: () => void) => void) {
  const owner = module.binding?.owner ?? module.rowId ?? module.packageId
  let live = true
  ownContribution(
    owner,
    () => {
      live = false
    },
    effect,
  )
  return Object.freeze({
    register(provider: PresentationProvider) {
      if (!live || module.binding?.lifetime !== 'profile' || module.binding.availability !== 'active')
        throw new Error('Presentation roles require an active profile contribution')
      return ownContribution(owner, presentationRoles.register(owner, provider), effect)
    },
  })
}
