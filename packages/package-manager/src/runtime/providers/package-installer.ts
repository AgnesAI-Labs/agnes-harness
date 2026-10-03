import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type { RuntimeWireTypes as Wire } from '@agnes/protocol/runtime'
import {
  InstallFault,
  type InstallJournal,
  type InstallRecord,
  installerDigest,
  installerFailure,
  installerWire,
} from '../install-journal.js'
import { type InstallOperationObservation, verifyInstallObservation } from '../repair-plan.js'

export type InstallerAuthorization = (
  context: CallContext,
  scope: Wire['ScopeRef'],
  mode: 'propose' | 'read' | 'cancel' | 'maintain',
) => Promise<Outcome<Wire['Id']>>

/** Must read a local authoritative snapshot; queries must never fetch, mutate or resume effects. */
export type InstallerOperationReader = (
  operation: NonNullable<InstallRecord['operation']>,
  context: CallContext,
) => Promise<Outcome<InstallOperationObservation>>

export interface PackageInstallerOptions {
  readonly journal: InstallJournal
  readonly currentAuthorization: InstallerAuthorization | null
  readonly readLocalOperation: InstallerOperationReader | null
}

export interface DeploymentApproval {
  readonly kind: 'deployment'
  readonly proposalId: string
  readonly owner: string
  readonly scope: Wire['ScopeRef']
  readonly planDigest: string
  readonly actorRef: string
  readonly expiresAt: string
  readonly decision: 'approved' | 'denied'
  readonly reference: Wire['DataRef']
}

/** All ports are explicit. No business root, legacy PackageManager or session tool grant. */
export interface PackageMaintenancePorts extends PackageInstallerOptions {
  readonly resolveReleaseRoute:
    | ((scope: Wire['ScopeRef'], context: CallContext) => Promise<Outcome<Wire['Id']>>)
    | null
  readonly generateVerifiedPlan:
    | ((
        input: Wire['ChangeProposalRequest'],
        context: CallContext,
      ) => Promise<Outcome<NonNullable<Wire['ChangeProposal']['plan']>>>)
    | null
  readonly readDeploymentApproval:
    | ((approvalRef: string, context: CallContext) => Promise<Outcome<DeploymentApproval>>)
    | null
  readonly candidate:
    | ((
        request: Wire['AssemblyPrepareRequest'],
        context: CallContext,
      ) => Promise<Outcome<Wire['AssemblyPrepareResult']>>)
    | null
  readonly publish:
    | ((
        request: Wire['AssemblyPublishRequest'],
        context: CallContext,
      ) => Promise<Outcome<Wire['AssemblyPublishResult']>>)
    | null
  readonly now: () => string
}

export interface PackageInstallerProvider {
  readonly providerId: string
  readonly contract: 'agh.package-installer'
  readonly implemented: readonly string[]
  readonly incomplete: readonly string[]
  requestChange(request: unknown, context: CallContext): Promise<Outcome<Wire['ChangeProposal']>>
  cancelProposal(request: unknown, context: CallContext): Promise<Outcome<Wire['ChangeProposal']>>
  proposalStatus(request: unknown, context: CallContext): Promise<Outcome<Wire['ChangeProposal']>>
  dispose(): void
}

async function authorized(
  options: PackageInstallerOptions,
  context: CallContext,
  scope: Wire['ScopeRef'],
  mode: Parameters<InstallerAuthorization>[2],
): Promise<string> {
  if (context.signal.aborted) throw new InstallFault('cancelled', 'call_cancelled')
  if (!options.currentAuthorization) throw new InstallFault('denied', 'current_authorization_unavailable')
  const current = await options.currentAuthorization(context, scope, mode)
  if (!current.ok) throw new InstallFault(current.error.code, current.error.detailCode)
  installerWire('Id', current.value)
  if (current.value !== context.principalRef) throw new InstallFault('denied', 'principal_mismatch')
  if (context.signal.aborted) throw new InstallFault('cancelled', 'call_cancelled')
  return current.value
}

async function attemptAsync<T>(action: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await action() }
  } catch (error) {
    return error instanceof InstallFault
      ? installerFailure(error.code, error.detailCode)
      : installerFailure('internal', 'installer_port_unavailable')
  }
}

function nextRecord(record: InstallRecord, update: Partial<Wire['ChangeProposal']>): InstallRecord {
  return { ...record, proposal: { ...record.proposal, ...update, revision: record.proposal.revision + 1 } }
}

async function readStatus(
  record: InstallRecord,
  options: PackageInstallerOptions,
  context: CallContext,
  mode: 'read' | 'maintain',
): Promise<Wire['ChangeProposal']> {
  if (!record.operation) return record.proposal
  const uncertain = () => ({
    ...record.proposal,
    status: record.proposal.resultRef === null ? ('unknown' as const) : ('applied' as const),
  })
  if (!options.readLocalOperation) return uncertain()
  let observation: Outcome<InstallOperationObservation>
  try {
    observation = await options.readLocalOperation(structuredClone(record.operation), context)
  } catch {
    observation = installerFailure('unknown_effect', 'operation_probe_unavailable')
  }
  await authorized(options, context, record.proposal.scope, mode)
  if (!observation.ok) return uncertain()
  verifyInstallObservation(record, observation.value)
  return {
    ...record.proposal,
    status: observation.value.state === 'published' ? 'applied' : uncertain().status,
    resultRef: observation.value.receipt ?? record.proposal.resultRef,
  }
}

/** Ordinary agents receive this object only. It contains no maintenance methods or controller handle. */
export function createPackageInstallerProvider(options: PackageInstallerOptions): PackageInstallerProvider {
  let disposed = false
  const gate = () => {
    if (disposed) throw new InstallFault('internal', 'provider_disposed')
  }
  const owned = async (id: string, context: CallContext, mode: 'read' | 'cancel') => {
    gate()
    const record = options.journal.read(id)
    const owner = await authorized(options, context, record.proposal.scope, mode)
    if (record.owner !== owner) throw new InstallFault('denied', 'proposal_owner_required')
    gate()
    return record
  }
  return {
    providerId: 'agh.default/package-installer',
    contract: 'agh.package-installer',
    implemented: Object.freeze(['requestChange', 'cancelProposal', 'proposalStatus']),
    incomplete: Object.freeze([
      'prepare',
      'activate',
      'disable',
      'repair',
      'applyResourceChange',
      'publication-recovery',
    ]),
    requestChange(request, context) {
      return attemptAsync(async () => {
        gate()
        const input = installerWire('ChangeProposalRequest', request)
        const owner = await authorized(options, context, input.targetScope, 'propose')
        gate()
        return options.journal.accept(input, owner).proposal
      })
    },
    cancelProposal(request, context) {
      return attemptAsync(async () => {
        const input = installerWire('PackageInstallerCancelProposalRequest', request)
        const record = await owned(input.proposalId, context, 'cancel')
        if (record.proposal.revision !== input.expectedRevision)
          throw new InstallFault('conflict', 'proposal_revision_conflict')
        if (record.cancellation !== null) return record.proposal
        const next = nextRecord(record, {
          status:
            record.operation === null && !['applied', 'denied'].includes(record.proposal.status)
              ? 'cancelled'
              : record.proposal.status,
        })
        // Durable cancellation intent blocks unstarted work; committed facts remain unchanged.
        return options.journal.compareAndSwap(input.proposalId, input.expectedRevision, {
          ...next,
          cancellation: { reason: input.reason },
        }).proposal
      })
    },
    proposalStatus(request, context) {
      return attemptAsync(async () => {
        const input = installerWire('PackageInstallerProposalStatusRequest', request)
        const record = await owned(input.proposalId, context, 'read')
        const status = await readStatus(record, options, context, 'read')
        gate()
        // The response is a read view. Persisting a recovery checkpoint is a separate controller effect.
        return status
      })
    },
    dispose() {
      disposed = true
    },
  }
}

function bindPlan(record: InstallRecord, plan: NonNullable<Wire['ChangeProposal']['plan']>): string {
  const change = record.input.change
  if (plan.kind === 'resource') {
    installerWire('ResourceChangePlan', plan.value)
    if (
      change.kind === 'package' ||
      installerDigest({
        kind: plan.value.kind,
        operation: plan.value.operation,
        resourceId: plan.value.resourceId,
        sourceRef: plan.value.sourceRef,
        config: plan.value.config,
        targetScope: plan.value.targetScope,
      }) !== installerDigest({ ...change, targetScope: record.input.targetScope })
    )
      throw new InstallFault('conflict', 'plan_input_conflict')
    return plan.value.digest
  }
  installerWire('ReleasePlan', plan.value)
  if (
    change.kind !== 'package' ||
    change.operation !== plan.value.operation ||
    !plan.value.targetReleaseSet.packages.some(
      (entry) =>
        entry.digest === change.locator.digest &&
        entry.sourceRef === change.locator.sourceId &&
        (change.locator.kind !== 'npm' || entry.version === change.locator.version),
    )
  )
    throw new InstallFault('conflict', 'plan_input_conflict')
  return plan.value.planFingerprint
}

/** Standalone trusted maintenance facade. Effectful deployment remains explicitly unavailable. */
export function createPackageMaintenanceController(ports: PackageMaintenancePorts) {
  const target = async (
    record: InstallRecord,
    plan: NonNullable<Wire['ChangeProposal']['plan']>,
    context: CallContext,
  ) => {
    if (plan.kind !== 'release') return
    if (!ports.resolveReleaseRoute) throw new InstallFault('denied', 'release_target_validation_unavailable')
    const route = await ports.resolveReleaseRoute(record.proposal.scope, context)
    if (!route.ok) throw new InstallFault(route.error.code, route.error.detailCode)
    if (route.value !== plan.value.routeId) throw new InstallFault('conflict', 'plan_target_conflict')
  }
  const load = async (id: string, revision: number, context: CallContext) => {
    const record = ports.journal.read(id)
    await authorized(ports, context, record.proposal.scope, 'maintain')
    if (record.proposal.revision !== revision)
      throw new InstallFault('conflict', 'proposal_revision_conflict')
    if (record.cancellation !== null) throw new InstallFault('cancelled', 'proposal_cancelled')
    return record
  }
  const unimplemented = (_request: unknown, context: CallContext) =>
    attemptAsync(async () => {
      await authorized(ports, context, context.scope, 'maintain')
      throw new InstallFault('incompatible', 'installer_effect_unimplemented')
    })
  return {
    proposalStatus(request: unknown, context: CallContext) {
      return attemptAsync(async () => {
        const input = installerWire('PackageInstallerProposalStatusRequest', request)
        const record = ports.journal.read(input.proposalId)
        await authorized(ports, context, record.proposal.scope, 'maintain')
        return readStatus(record, ports, context, 'maintain')
      })
    },
    plan(proposalId: string, expectedRevision: number, context: CallContext) {
      return attemptAsync(async () => {
        const record = await load(proposalId, expectedRevision, context)
        if (record.proposal.status !== 'planning') throw new InstallFault('conflict', 'proposal_not_planning')
        if (!ports.generateVerifiedPlan) throw new InstallFault('incompatible', 'plan_generation_unavailable')
        const generated = await ports.generateVerifiedPlan(structuredClone(record.input), context)
        if (!generated.ok) throw new InstallFault(generated.error.code, generated.error.detailCode)
        const plan = structuredClone(generated.value)
        const planDigest = bindPlan(record, plan)
        await target(record, plan, context)
        await load(proposalId, expectedRevision, context)
        return ports.journal.compareAndSwap(
          proposalId,
          expectedRevision,
          nextRecord(record, { status: 'awaiting-approval', plan, planDigest }),
        ).proposal
      })
    },
    checkApproval(proposalId: string, expectedRevision: number, approvalRef: string, context: CallContext) {
      return attemptAsync(async () => {
        const record = await load(proposalId, expectedRevision, context)
        if (!record.proposal.plan || record.proposal.status !== 'awaiting-approval')
          throw new InstallFault('conflict', 'proposal_not_awaiting_approval')
        await target(record, record.proposal.plan, context)
        if (!ports.readDeploymentApproval) throw new InstallFault('denied', 'deployment_approval_unavailable')
        const answer = await ports.readDeploymentApproval(approvalRef, context)
        if (!answer.ok) throw new InstallFault(answer.error.code, answer.error.detailCode)
        await target(record, record.proposal.plan, context)
        await load(proposalId, expectedRevision, context)
        const approval = answer.value
        const now = Date.parse(ports.now())
        if (
          approval.kind !== 'deployment' ||
          approval.decision !== 'approved' ||
          approval.proposalId !== proposalId ||
          approval.owner !== record.owner ||
          approval.planDigest !== record.proposal.planDigest ||
          installerDigest(approval.scope) !== installerDigest(record.proposal.scope) ||
          approval.actorRef !== context.principalRef ||
          !Number.isFinite(now) ||
          !Number.isFinite(Date.parse(approval.expiresAt)) ||
          Date.parse(approval.expiresAt) <= now ||
          (record.proposal.plan.kind === 'release' && Date.parse(record.proposal.plan.value.expiresAt) <= now)
        )
          throw new InstallFault('denied', 'deployment_approval_mismatch')
        installerWire('DataRef', approval.reference)
        return ports.journal.compareAndSwap(proposalId, expectedRevision, {
          ...nextRecord(record, { status: 'approved' }),
          approvalRef: structuredClone(approval.reference),
        }).proposal
      })
    },
    prepare: unimplemented,
    activate: unimplemented,
    disable: unimplemented,
    repair: unimplemented,
    applyResourceChange: unimplemented,
  }
}

export type { InstallJournal, InstallRecord } from '../install-journal.js'
export { openInstallJournal } from '../install-journal.js'
export type { InstallOperationObservation, InstallRepairPlan } from '../repair-plan.js'
export { createInstallRepairPlan, installRepairPlanRef } from '../repair-plan.js'
