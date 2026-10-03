import type { AuthorityTransferControl, CallContext, Outcome } from '@agnes/extension-api/runtime'
import type { AuthorityTransferProbe, DataRef, StateAuthorityRef } from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'

export type { AuthorityTransferControl } from '@agnes/extension-api/runtime'

/** These checkpoints describe order, not a cross-authority transaction or proof of a fence. */
export const AUTHORITY_TRANSFER_PHASES = [
  { phase: 'freeze', source: 'fenced', target: 'inactive', admission: 'closed' },
  { phase: 'copy', source: 'fenced', target: 'inactive', admission: 'closed' },
  { phase: 'validation', source: 'fenced', target: 'verified-inactive', admission: 'closed' },
  { phase: 'directory-publish', source: 'fenced', target: 'inactive', admission: 'closed' },
  { phase: 'cohort-activate', source: 'fenced', target: 'activating', admission: 'closed' },
  { phase: 'intake-replay', source: 'fenced', target: 'active', admission: 'closed' },
  { phase: 'admission-open', source: 'fenced', target: 'active', admission: 'open' },
] as const
export type AuthorityTransferPhase = (typeof AUTHORITY_TRANSFER_PHASES)[number]['phase']

export interface AuthorityTransferPorts {
  readonly source?: AuthorityTransferControl
  readonly target?: AuthorityTransferControl
  /** Current maintenance authorization comes from its owner, never from a fixture or bindingId. */
  readonly authorizeMaintenance?: (context: CallContext) => Promise<Outcome<true>>
}
function refused(detailCode: string): Outcome<never> {
  return {
    ok: false,
    error: {
      code: 'incompatible',
      detailCode,
      message: 'Authority transfer requires an owner port',
      diagnosticId: 'authority-transfer',
      retryAdvice: { kind: 'never' },
    },
  }
}

/** Narrow public control facade. Each owning service must implement the actual durable operations. */
export function createAuthorityTransferControl(ports: AuthorityTransferPorts): AuthorityTransferControl {
  async function invoke<K extends keyof AuthorityTransferControl>(
    side: 'source' | 'target',
    method: K,
    request: Parameters<AuthorityTransferControl[K]>[0],
    context: CallContext,
  ): Promise<Awaited<ReturnType<AuthorityTransferControl[K]>>> {
    type Result = Awaited<ReturnType<AuthorityTransferControl[K]>>
    if (context.signal.aborted)
      return {
        ok: false,
        error: {
          code: 'cancelled',
          detailCode: 'call_cancelled',
          message: 'Authority transfer cancelled',
          diagnosticId: 'authority-transfer',
          retryAdvice: { kind: 'never' },
        },
      } as Result
    const owner = ports[side]
    if (!owner) return refused(`${side}_transfer_unavailable`) as Result
    if (!ports.authorizeMaintenance) return refused('maintenance_authorization_unavailable') as Result
    const authorized = await ports.authorizeMaintenance(context)
    if (!authorized.ok) return authorized as Result
    // The generic method/request pair has identical keys from the frozen public interface.
    const call = owner[method] as (input: typeof request, ctx: CallContext) => Promise<Result>
    return call.call(owner, request, context)
  }
  return {
    fence: (request, context) => invoke('source', 'fence', request, context),
    export: (request, context) => invoke('source', 'export', request, context),
    exportPage: (request, context) => invoke('source', 'exportPage', request, context),
    import: (request, context) => invoke('target', 'import', request, context),
    verify: (request, context) => invoke('target', 'verify', request, context),
    activate: (request, context) => invoke('target', 'activate', request, context),
    abort: (request, context) => invoke('source', 'abort', request, context),
    probe: (request, context) => invoke('source', 'probe', request, context),
  }
}

export interface TransferMember {
  readonly source: StateAuthorityRef
  readonly target: StateAuthorityRef
  readonly sourceControl: Pick<AuthorityTransferControl, 'probe'>
  readonly targetControl: Pick<AuthorityTransferControl, 'probe'>
}
export interface TransferRecoveryPlan {
  readonly upgradeId: string
  readonly cutoverId: string
  readonly planFingerprint: string
  readonly cohortDigest: string
  readonly members: readonly TransferMember[]
}
/** All values below must be read from the current authoritative commit, not a journal success flag. */
export type PublicationProbe =
  | {
      state: 'source'
      sourceRoutesCurrent: boolean
      recovery: null | {
        upgradeId: string
        planFingerprint: string
        cohortDigest: string
        sources: readonly StateAuthorityRef[]
      }
    }
  | {
      state: 'published'
      upgradeId: string
      cutoverId: string
      planFingerprint: string
      cohortDigest: string
      targets: readonly StateAuthorityRef[]
      route: DataRef
    }
export interface TransferRecoveryPorts {
  probePublication(plan: TransferRecoveryPlan, context: CallContext): Promise<Outcome<PublicationProbe>>
  probeReplay(plan: TransferRecoveryPlan, context: CallContext): Promise<Outcome<{ ready: boolean }>>
}
export interface TransferRecoveryDecision {
  readonly phase: AuthorityTransferPhase | 'source-recovered' | 'reverse-required'
  readonly admission: 'closed' | 'ready'
  readonly sourceMayReopen: boolean
}
const same = (left: StateAuthorityRef, right: StateAuthorityRef): boolean =>
  left.authorityId === right.authorityId &&
  left.tenantId === right.tenantId &&
  left.authorityEpoch === right.authorityEpoch

/** Called on EVERY reopen before advancing a journal. No mutations or writer credentials are issued here. */
export async function probeAuthorityTransferRecovery(
  plan: TransferRecoveryPlan,
  ports: TransferRecoveryPorts | undefined,
  context: CallContext,
): Promise<Outcome<TransferRecoveryDecision>> {
  if (context.signal.aborted)
    return {
      ok: false,
      error: {
        code: 'cancelled',
        detailCode: 'call_cancelled',
        message: 'Authority transfer cancelled',
        diagnosticId: 'authority-transfer',
        retryAdvice: { kind: 'never' },
      },
    }
  if (!ports) return refused('recovery_probe_unavailable')
  if (
    !plan.members.length ||
    new Set(plan.members.map((member) => member.source.authorityId)).size !== plan.members.length ||
    plan.members.some(
      (member) =>
        member.source.authorityId !== member.target.authorityId ||
        member.source.tenantId !== member.target.tenantId ||
        member.target.authorityEpoch <= member.source.authorityEpoch,
    )
  )
    return refused('cohort_invalid')
  const publication = await ports.probePublication(plan, context)
  if (!publication.ok) return publication
  const facts: { source: AuthorityTransferProbe; target: AuthorityTransferProbe }[] = []
  for (const member of plan.members) {
    const source = await member.sourceControl.probe({ upgradeId: plan.upgradeId }, context)
    if (!source.ok) return source
    const target = await member.targetControl.probe({ upgradeId: plan.upgradeId }, context)
    if (!target.ok) return target
    if (
      !validateRuntime('AuthorityTransferProbe', source.value).ok ||
      !validateRuntime('AuthorityTransferProbe', target.value).ok
    )
      return refused('probe_schema')
    if (
      (source.value.state === 'fenced' || source.value.state === 'imported') &&
      (source.value.fence.upgradeId !== plan.upgradeId ||
        !same(source.value.fence.source, member.source) ||
        !source.value.fence.writerCredentialsRevoked)
    )
      return refused('source_fence_unproven')
    if (
      target.value.state === 'activated' &&
      (target.value.cutoverId !== plan.cutoverId ||
        !same(target.value.authority, member.target) ||
        target.value.checkpoint.authorityId !== member.target.authorityId ||
        target.value.checkpoint.authorityEpoch !== member.target.authorityEpoch)
    )
      return refused('target_activation_mismatch')
    if (
      target.value.state === 'imported' &&
      (target.value.fence.upgradeId !== plan.upgradeId || !same(target.value.fence.source, member.source))
    )
      return refused('target_import_mismatch')
    facts.push({ source: source.value, target: target.value })
  }
  const decision = (
    phase: TransferRecoveryDecision['phase'],
    admission: 'closed' | 'ready' = 'closed',
    sourceMayReopen = false,
  ): Outcome<TransferRecoveryDecision> => ({ ok: true, value: { phase, admission, sourceMayReopen } })
  if (publication.value.state === 'source') {
    if (!publication.value.sourceRoutesCurrent) return refused('publication_uncertain')
    if (facts.some((fact) => fact.target.state === 'activated')) return decision('reverse-required')
    const recovery = publication.value.recovery
    if (
      recovery &&
      recovery.upgradeId === plan.upgradeId &&
      recovery.planFingerprint === plan.planFingerprint &&
      recovery.cohortDigest === plan.cohortDigest &&
      recovery.sources.length === plan.members.length &&
      facts.every((fact, index) => {
        const expected = plan.members[index]!.source
        const route = recovery.sources.find((source) => source.authorityId === expected.authorityId)
        return (
          fact.source.state === 'aborted' &&
          route !== undefined &&
          same(fact.source.source, route) &&
          route.tenantId === expected.tenantId &&
          route.authorityEpoch === fact.source.restoredEpoch &&
          fact.source.restoredEpoch > expected.authorityEpoch
        )
      })
    )
      return decision('source-recovered', 'ready', true)
    if (!facts.every((fact) => fact.source.state === 'fenced' || fact.source.state === 'imported'))
      return decision('freeze')
    return decision(facts.every((fact) => fact.target.state === 'imported') ? 'validation' : 'copy')
  }
  const published = publication.value
  if (
    published.upgradeId !== plan.upgradeId ||
    published.cutoverId !== plan.cutoverId ||
    published.planFingerprint !== plan.planFingerprint ||
    published.cohortDigest !== plan.cohortDigest ||
    published.targets.length !== plan.members.length ||
    canonicalJsonDigest([...published.targets].sort((a, b) => a.authorityId.localeCompare(b.authorityId))) !==
      canonicalJsonDigest(
        plan.members
          .map((member) => member.target)
          .sort((a, b) => a.authorityId.localeCompare(b.authorityId)),
      )
  )
    return refused('publication_mismatch')
  if (!facts.every((fact) => fact.source.state === 'fenced' || fact.source.state === 'imported'))
    return refused('source_fence_unproven')
  if (!facts.every((fact) => fact.target.state === 'activated')) return decision('cohort-activate')
  const replay = await ports.probeReplay(plan, context)
  if (!replay.ok) return replay
  return replay.value.ready ? decision('admission-open', 'ready') : decision('intake-replay')
}
