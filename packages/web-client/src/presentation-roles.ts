import type { ApplicationRoleTarget, PresentationRole } from '@agnes/protocol'
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
export const STANDARD_PRESENTATION_ROLES = [
  'navigation',
  'conversation',
  'composer',
  'goal',
  'interaction',
  'deliverables',
] as const
const defaults: Partial<Record<PresentationRole, string>> = {
  goal: '@agnes/goal-ui',
  interaction: '@agnes/interaction-ui',
  deliverables: '@agnes/deliverables-ui',
}
type Candidate = { owner: string; provider: PresentationProvider; module?: ModuleIdentity }
export class PresentationRoleRegistry {
  private readonly entries = new Set<Candidate>()
  private readonly active = new Map<string, { entry: Candidate; stop: () => void }>()
  private selection: Partial<Record<PresentationRole, ApplicationRoleTarget>> = {}
  private overrides: Partial<Record<PresentationRole, ApplicationRoleTarget>> = {}
  /** Host presentation policy is applied before priority, independently of execution selection. */
  select(selection: typeof this.selection = {}, overrides: typeof this.overrides = this.overrides): void {
    this.selection = structuredClone(selection)
    this.overrides = structuredClone(overrides)
    for (const role of new Set([...this.entries].map((e) => e.provider.role))) this.reconcile(role)
  }
  private admitted(entry: Candidate): boolean {
    const { role } = entry.provider
    if (!STANDARD_PRESENTATION_ROLES.some((r) => r === role) || !entry.module) return true
    const selected = this.overrides[role as PresentationRole] ?? this.selection[role as PresentationRole]
    return selected
      ? selected.packageId === entry.module.packageId && selected.clientId === entry.module.clientId
      : defaults[role as PresentationRole] === entry.module.packageId
  }
  private reconcile(role: string): void {
    const entries = [...this.entries]
      .filter((e) => e.provider.role === role && this.admitted(e))
      .sort((a, b) => (a.provider.priority ?? 0) - (b.provider.priority ?? 0))
    if (
      entries.some((e, i) => i > 0 && (entries[i - 1]!.provider.priority ?? 0) === (e.provider.priority ?? 0))
    )
      throw new Error('Presentation role already has an entry at this priority')
    const next = entries[0],
      previous = this.active.get(role)
    if (previous?.entry === next) return
    previous?.stop()
    this.active.delete(role)
    if (next) this.active.set(role, { entry: next, stop: next.provider.mount() })
  }
  register(owner: string, provider: PresentationProvider, module?: ModuleIdentity): () => void {
    const { role } = provider
    if (!/^[a-z][a-z0-9.-]{0,127}$/.test(role)) throw new Error('Invalid presentation role')
    const entry: Candidate = { owner, provider, ...(module ? { module } : {}) }
    this.entries.add(entry)
    try {
      this.reconcile(role)
    } catch (error) {
      this.entries.delete(entry)
      this.reconcile(role)
      throw error
    }
    let live = true
    return () => {
      if (!live) return
      live = false
      this.entries.delete(entry)
      this.reconcile(role)
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
      if (
        STANDARD_PRESENTATION_ROLES.some((role) => role === provider.role) &&
        !module.presentationRoles?.some((role) => role === provider.role)
      )
        throw new Error('Undeclared presentation role')
      return ownContribution(owner, presentationRoles.register(owner, provider, module), effect)
    },
  })
}
