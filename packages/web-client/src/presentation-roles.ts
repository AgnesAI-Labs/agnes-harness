import type { ApplicationRoleTarget, PresentationRole } from '@agnes/protocol'
import { notifyListeners } from '@agnes/sdk/browser'
import type { ClientContext } from './client-module.js'
import { ownContribution } from './contribution-scope.js'
import type { ModuleIdentity } from './service-contracts.js'

export type PresentationProvider = Readonly<{
  role: string
  /** Lower wins, as for single slots. Equal priorities are rejected. */
  priority?: number
  /** Register the complete experience; cleanup must synchronously revoke every registration. */
  mount(ctx: ClientContext): () => void
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
  navigation: '@agnes/navigation-ui',
  conversation: '@agnes/conversation-ui',
  composer: '@agnes/conversation-ui',
  goal: '@agnes/goal-ui',
  interaction: '@agnes/interaction-ui',
  deliverables: '@agnes/deliverables-ui',
}
type HostPresentationProvider = Omit<PresentationProvider, 'mount'> & { mount(): () => void }
type Candidate = { owner: string; provider: HostPresentationProvider; module?: ModuleIdentity }
export class PresentationRoleRegistry {
  private readonly entries = new Set<Candidate>()
  private readonly failed = new Set<Candidate>()
  private readonly listeners = new Set<() => void>()
  private diagnostics: readonly Readonly<{
    role: string
    owners: readonly string[]
    reason: 'conflict' | 'mount-failed'
  }>[] = []
  getSnapshot = () => this.diagnostics
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private diagnose(role: string, owners: string[], reason: 'conflict' | 'mount-failed') {
    this.diagnostics = [...this.diagnostics.filter((item) => item.role !== role), { role, owners, reason }]
    notifyListeners(this.listeners, 'presentation diagnostics')
  }
  private readonly active = new Map<string, { entry: Candidate; stop: () => void }>()
  private selection: Partial<Record<PresentationRole, ApplicationRoleTarget>> = {}
  private overrides: Partial<Record<PresentationRole, ApplicationRoleTarget>> = {}
  /** Host presentation policy is applied before priority, independently of execution selection. */
  select(selection: typeof this.selection = {}, overrides: typeof this.overrides = this.overrides): void {
    this.selection = structuredClone(selection)
    this.overrides = structuredClone(overrides)
    for (const role of new Set([...this.entries].map((e) => e.provider.role))) {
      try {
        this.reconcile(role)
      } catch {
        /* Diagnostics retain the rejected selection and source. */
      }
    }
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
      .filter(
        (e) =>
          e.provider.role === role &&
          !this.failed.has(e) &&
          (this.admitted(e) || defaults[role as PresentationRole] === e.module?.packageId),
      )
      .sort(
        (a, b) =>
          Number(!this.admitted(a)) - Number(!this.admitted(b)) ||
          (a.provider.priority ?? 0) - (b.provider.priority ?? 0),
      )
    if (
      entries.some(
        (e, i) =>
          i > 0 &&
          this.admitted(e) === this.admitted(entries[i - 1]!) &&
          (entries[i - 1]!.provider.priority ?? 0) === (e.provider.priority ?? 0),
      )
    ) {
      this.diagnose(
        role,
        entries.map((e) => e.owner),
        'conflict',
      )
      throw new Error(
        `Presentation role already has an entry at this priority: ${role}: ${entries.map((e) => e.owner).join(', ')}`,
      )
    }
    const next = entries[0],
      previous = this.active.get(role)
    if (previous?.entry === next) return
    try {
      previous?.stop()
    } catch {
      this.diagnose(role, previous ? [previous.entry.owner] : [], 'mount-failed')
    }
    this.active.delete(role)
    if (next) {
      try {
        this.active.set(role, { entry: next, stop: next.provider.mount() })
      } catch (error) {
        this.failed.add(next)
        this.diagnose(role, [next.owner], 'mount-failed')
        this.reconcile(role)
        throw error
      }
    }
  }
  register(owner: string, provider: HostPresentationProvider, module?: ModuleIdentity): () => void {
    const { role } = provider
    if (!/^[a-z][a-z0-9.-]{0,127}$/.test(role)) throw new Error('Invalid presentation role')
    const entry: Candidate = { owner, provider, ...(module ? { module } : {}) }
    this.entries.add(entry)
    try {
      this.reconcile(role)
    } catch (error) {
      this.entries.delete(entry)
      this.failed.delete(entry)
      this.reconcile(role)
      throw error
    }
    let live = true
    return () => {
      if (!live) return
      live = false
      this.entries.delete(entry)
      this.failed.delete(entry)
      this.reconcile(role)
    }
  }
}

export const presentationRoles = new PresentationRoleRegistry()
export function scopedPresentationRoles(
  module: ModuleIdentity,
  effect: (off: () => void) => void,
  prepare?: (provider: PresentationProvider) => HostPresentationProvider,
) {
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
      return ownContribution(
        owner,
        presentationRoles.register(
          owner,
          prepare
            ? prepare(provider)
            : {
                ...provider,
                mount: () => {
                  if (provider.mount.length) throw new Error('Role mount requires a client context')
                  return Reflect.apply(provider.mount, undefined, [])
                },
              },
          module,
        ),
        effect,
      )
    },
  })
}
