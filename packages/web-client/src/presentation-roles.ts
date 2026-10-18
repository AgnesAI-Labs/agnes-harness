import type { ApplicationRoleTarget, ApplicationState, PresentationRole } from '@agnes/protocol'
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
type ConsentedRoleTarget = ApplicationRoleTarget & { integrity: string; bindingDigest: string }
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
    failure?: Readonly<{ code: string; packageId?: string; phase: 'mount' | 'dispose'; summary: string }>
  }>[] = []
  getSnapshot = () => this.diagnostics
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private diagnose(
    role: string,
    owners: string[],
    reason: 'conflict' | 'mount-failed',
    source?: Candidate,
    phase: 'mount' | 'dispose' = 'mount',
  ) {
    // Only host-authored summaries cross this boundary; plugin exceptions may contain secrets.
    const failure =
      reason === 'mount-failed'
        ? {
            code: phase === 'mount' ? 'PRESENTATION_MOUNT_FAILED' : 'PRESENTATION_DISPOSE_FAILED',
            ...(source?.module ? { packageId: source.module.packageId } : {}),
            phase,
            summary: 'The presentation failed. Saved results may still exist.',
          }
        : undefined
    this.diagnostics = [
      ...this.diagnostics.filter((item) => item.role !== role),
      {
        role,
        owners,
        reason,
        ...(failure ? { failure } : {}),
      },
    ]
    notifyListeners(this.listeners, 'presentation diagnostics')
  }
  private readonly active = new Map<string, { entry: Candidate; stop: () => void }>()
  private selection: Partial<Record<PresentationRole, ApplicationRoleTarget>> = {}
  private overrides: Partial<Record<PresentationRole, ConsentedRoleTarget>> = {}
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
  private rank(entry: Candidate): number {
    const role = entry.provider.role as PresentationRole
    if (!STANDARD_PRESENTATION_ROLES.includes(role)) return 0
    if (!entry.module) return this.overrides[role] ? Infinity : 0
    const matches = (target: ApplicationRoleTarget | undefined) =>
      target && target.packageId === entry.module?.packageId && target.clientId === entry.module?.clientId
    if (matches(this.overrides[role])) {
      if (this.consented(entry, role)) return 0
      // A name-matched but unconsented version cannot re-enter through the app fallback.
      return defaults[role] === entry.module.packageId ? 2 : Infinity
    }
    if (matches(this.selection[role])) return 1
    return defaults[role] === entry.module.packageId ? 2 : Infinity
  }
  private consented(entry: Candidate | undefined, role: PresentationRole): boolean {
    const target = this.overrides[role],
      module = entry?.module
    return !!(
      target &&
      module?.packageId === target.packageId &&
      module.clientId === target.clientId &&
      target.integrity &&
      target.bindingDigest &&
      module.revision === target.integrity &&
      module.binding?.packageId === target.packageId &&
      module.binding.integrity === target.integrity &&
      module.binding.lifetime === 'profile' &&
      module.binding.availability === 'active' &&
      module.presentationRoleBindings?.[role] === target.bindingDigest
    )
  }
  /** Actual mounted owner, including local module/mount failures unavailable to the backend. */
  resolution(role: PresentationRole): { effective: ApplicationRoleTarget | null; reason?: string } {
    const entry = this.active.get(role)?.entry
    const effective = entry?.module?.clientId
      ? { packageId: entry.module.packageId, clientId: entry.module.clientId }
      : null
    const requested = this.overrides[role]
    return {
      effective,
      ...(requested && !this.consented(entry, role)
        ? {
            reason: [...this.entries].some(
              (candidate) =>
                candidate.provider.role === role &&
                candidate.module?.packageId === requested.packageId &&
                candidate.module.clientId === requested.clientId &&
                !this.consented(candidate, role),
            )
              ? 'consent-mismatch'
              : [...this.failed].some(
                    (entry) =>
                      entry.provider.role === role &&
                      entry.module?.packageId === requested.packageId &&
                      entry.module.clientId === requested.clientId,
                  )
                ? 'mount-failed'
                : 'code-unavailable',
          }
        : {}),
    }
  }
  private reconcile(role: string): void {
    const entries = [...this.entries]
      .filter((e) => e.provider.role === role && !this.failed.has(e) && Number.isFinite(this.rank(e)))
      .sort((a, b) => this.rank(a) - this.rank(b) || (a.provider.priority ?? 0) - (b.provider.priority ?? 0))
    if (
      entries.some(
        (e, i) =>
          i > 0 &&
          this.rank(e) === this.rank(entries[i - 1]!) &&
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
      this.diagnose(role, previous ? [previous.entry.owner] : [], 'mount-failed', previous?.entry, 'dispose')
    }
    this.active.delete(role)
    if (next) {
      try {
        this.active.set(role, { entry: next, stop: next.provider.mount() })
      } catch (error) {
        this.failed.add(next)
        this.diagnose(role, [next.owner], 'mount-failed', next)
        this.reconcile(role)
        throw error
      }
    }
    this.diagnostics = [...this.diagnostics]
    notifyListeners(this.listeners, 'presentation owner')
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
/** Host projection shared by roster updates and explicit administration writes. */
export function selectPresentationRoles(state: ApplicationState | undefined): void {
  const overrides: Partial<Record<PresentationRole, ConsentedRoleTarget>> = {}
  for (const item of state?.roles ?? []) {
    if (item.source === 'choice' && item.status === 'resolved' && item.effective)
      overrides[item.role] = {
        ...item.effective,
        integrity: item.selection?.integrity ?? '',
        bindingDigest: item.selection?.bindingDigest ?? '',
      }
  }
  presentationRoles.select(
    state?.status === 'active' ? state.effective?.presentation?.roles : undefined,
    overrides,
  )
}
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
