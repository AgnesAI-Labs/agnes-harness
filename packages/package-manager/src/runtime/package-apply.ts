import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type { RuntimeWireTypes as W } from '@agnes/protocol/runtime'
import {
  type DeploymentApprovalBinding,
  type DeploymentApprovalPort,
  type DeploymentApprovalRequest,
  type DeploymentIdentity,
  validateDeploymentBinding,
  validateDeploymentTerminal,
} from './deployment-approval.js'
import {
  InstallFault,
  type InstallRecord,
  installerDigest,
  installerFailure,
  installerWire,
} from './install-journal.js'
import {
  buildLockedPackage,
  type PackageBuildInput,
  type PackageBuildResult,
  packageBuildApprovalDigest,
} from './package-build.js'
import type { PackageMaintenancePorts } from './providers/package-installer.js'
import { verifyInstallObservation } from './repair-plan.js'

export interface PackageApplyInputs {
  readonly operation: NonNullable<InstallRecord['operation']>
  readonly graph: W['AssemblyGraph'] | null
  readonly builds: readonly PackageBuildInput[]
}
export interface PackageApplyPorts {
  readonly deploymentAudit?:
    | ((
        input: {
          proposalId: string
          tenantId: string
          principalRef: string
          credentialRef: string
          scope: W['ScopeRef']
          permission: 'maintain'
        },
        context: CallContext,
      ) => Promise<Outcome<void>>)
    | null
  readonly retainOperation?:
    | ((
        plan: W['ReleasePlan'],
        operation: NonNullable<InstallRecord['operation']>,
        context: CallContext,
      ) => Promise<Outcome<void>>)
    | null
  readonly buildPackage?: ((input: PackageBuildInput) => Promise<Outcome<PackageBuildResult>>) | null
  readonly deploymentApproval?: DeploymentApprovalPort | null
  readonly deploymentIdentity?:
    | ((context: CallContext, scope: W['ScopeRef']) => Promise<Outcome<DeploymentIdentity>>)
    | null
  /** The trusted generator binds the complete graph, build limits and source locks to the fixed plan.
   * Caller-supplied graphs, credentials, build scripts and operation identities are never accepted. */
  readonly executionInputs?:
    | ((record: InstallRecord, context: CallContext) => Promise<Outcome<PackageApplyInputs>>)
    | null
  /** Original resource owner: idempotent business operation; it owns cancellation, pins and probe. */
  readonly resourceApply?:
    | ((
        input: { operation: NonNullable<InstallRecord['operation']>; plan: W['ResourceChangePlan'] },
        context: CallContext,
      ) => Promise<Outcome<W['ReceiptPointer']>>)
    | null
}

/** Private orchestration checkpoints, not a second UpgradeOperation or publication authority. */
export interface InstallApplyCheckpoint {
  readonly interactionId: string
  readonly binding: DeploymentApprovalBinding
  readonly responseId: string | null
  readonly inputsDigest: string | null
  readonly phase: 'approval' | 'started' | 'built' | 'prepared' | 'publishing' | 'done'
  readonly buildEvidence: readonly W['DataRef'][]
  readonly candidateRef: W['DataRef'] | null
}
const ref = (value: W['JsonValue']): W['DataRef'] => ({
  kind: 'inline',
  value,
  digest: installerDigest(value),
  bytes: Buffer.byteLength(JSON.stringify(value)),
  schema: {
    typeId: 'private.package-installer/build@1',
    revision: 1,
    digest: installerDigest('private.package-installer/build@1'),
  },
})
const result = <T>(outcome: Outcome<T>): T => {
  if (!outcome.ok) throw new InstallFault(outcome.error.code, outcome.error.detailCode)
  return outcome.value
}
export function createPackageApplyController(ports: PackageMaintenancePorts & PackageApplyPorts) {
  let disposed = false
  const lifetime = new AbortController()
  function live(context: CallContext) {
    if (disposed) throw new InstallFault('internal', 'provider_disposed')
    if (context.signal.aborted) throw new InstallFault('cancelled', 'call_cancelled')
  }
  async function identity(record: InstallRecord, context: CallContext) {
    live(context)
    if (!ports.currentAuthorization) throw new InstallFault('denied', 'current_authorization_unavailable')
    if (!ports.deploymentIdentity) throw new InstallFault('denied', 'deployment_identity_unavailable')
    const who = result(await ports.deploymentIdentity(context, record.proposal.scope))
    for (const field of [who.tenantId, who.principalRef, who.credentialRef]) installerWire('Id', field)
    if (who.principalRef !== context.principalRef || !context.authorizationRef)
      throw new InstallFault('denied', 'principal_mismatch')
    const actor = result(await ports.currentAuthorization(context, record.proposal.scope, 'maintain'))
    if (actor !== who.principalRef) throw new InstallFault('denied', 'principal_mismatch')
    if (!ports.deploymentAudit) throw new InstallFault('denied', 'deployment_audit_unavailable')
    result(
      await ports.deploymentAudit(
        {
          proposalId: record.proposal.proposalId,
          ...who,
          scope: record.proposal.scope,
          permission: 'maintain',
        },
        context,
      ),
    )
    live(context)
    return who
  }
  function approvalRequest(record: InstallRecord, who: DeploymentIdentity): DeploymentApprovalRequest {
    if (!record.proposal.plan || !record.proposal.planDigest)
      throw new InstallFault('conflict', 'proposal_not_planned')
    return {
      proposalId: record.proposal.proposalId,
      planRevision: record.applyCheckpoint?.binding.planRevision ?? record.proposal.revision,
      plan: record.proposal.plan,
      planDigest: record.proposal.planDigest,
      capabilityDifference: record.proposal.plan.value.permissionDifference,
      sourceDifference: record.input.change,
      requester: record.owner,
      scope: record.proposal.scope,
      identity: who,
    }
  }
  async function guard(id: string, context: CallContext) {
    const record = ports.journal.read(id)
    const who = await identity(record, context)
    if (record.cancellation) throw new InstallFault('cancelled', 'proposal_cancelled')
    const plan = record.proposal.plan
    if (!plan || !record.proposal.planDigest) throw new InstallFault('conflict', 'proposal_not_planned')
    const interactionId = record.applyCheckpoint?.interactionId
    if (!ports.deploymentApproval || !interactionId)
      throw new InstallFault('denied', 'deployment_approval_unavailable')
    const terminal = result(await ports.deploymentApproval.read({ proposalId: id, interactionId }, context))
    const binding = record.applyCheckpoint!.binding
    validateDeploymentBinding(approvalRequest(record, who), binding)
    validateDeploymentTerminal(terminal)
    if (installerDigest(binding) !== installerDigest(terminal.binding))
      throw new InstallFault('denied', 'deployment_approval_mismatch')
    const verified = await ports.deploymentApproval.verify(
      { request: approvalRequest(record, who), binding },
      context,
    )
    if (!verified.ok) {
      if (terminal.status === 'pending')
        result(
          await ports.deploymentApproval.cancel(
            { proposalId: id, interactionId, reason: 'deployment_input_changed' },
            context,
          ),
        )
      throw new InstallFault(verified.error.code, verified.error.detailCode)
    }
    const now = Date.parse(ports.now())
    if (
      terminal.status !== 'answered' ||
      terminal.decision !== 'approve' ||
      !terminal.responseId ||
      terminal.interactionId !== interactionId ||
      terminal.proposalId !== id ||
      terminal.intentDigest !== binding.request.intentDigest ||
      installerDigest(terminal.owner) !== installerDigest(binding.owner) ||
      terminal.tenantId !== who.tenantId ||
      installerDigest(terminal.scope) !== installerDigest(record.proposal.scope) ||
      !Number.isFinite(now) ||
      !Number.isFinite(Date.parse(terminal.expiresAt)) ||
      Date.parse(terminal.expiresAt) <= now ||
      (plan.kind === 'release' &&
        (!Number.isFinite(Date.parse(plan.value.expiresAt)) || Date.parse(plan.value.expiresAt) <= now)) ||
      (record.applyCheckpoint?.responseId !== null &&
        record.applyCheckpoint?.responseId !== terminal.responseId)
    )
      throw new InstallFault('denied', 'deployment_approval_mismatch')
    installerWire('Id', terminal.responseId)
    installerWire('DataRef', terminal.reference)
    if (plan.kind === 'release') {
      if (!ports.resolveReleaseRoute)
        throw new InstallFault('denied', 'release_target_validation_unavailable')
      const route = result(await ports.resolveReleaseRoute(record.proposal.scope, context))
      if (route !== plan.value.routeId) throw new InstallFault('conflict', 'plan_target_conflict')
    }
    await identity(record, context)
    const latest = ports.journal.read(id)
    live(context)
    if (latest.cancellation) throw new InstallFault('cancelled', 'proposal_cancelled')
    if (latest.proposal.revision !== record.proposal.revision)
      throw new InstallFault('conflict', 'proposal_revision_conflict')
    return { record, terminal }
  }
  function save(
    record: InstallRecord,
    changes: Partial<InstallRecord>,
    proposal: Partial<W['ChangeProposal']> = {},
  ) {
    return ports.journal.compareAndSwap(record.proposal.proposalId, record.proposal.revision, {
      ...record,
      ...changes,
      proposal: { ...record.proposal, ...proposal, revision: record.proposal.revision + 1 },
    })
  }
  async function attempt<T>(work: () => Promise<T>): Promise<Outcome<T>> {
    try {
      return { ok: true, value: await work() }
    } catch (error) {
      return error instanceof InstallFault
        ? installerFailure(error.code, error.detailCode)
        : installerFailure('internal', 'installer_port_unavailable')
    }
  }
  async function probe(record: InstallRecord, context: CallContext) {
    await identity(record, context)
    if (!record.operation || !ports.readLocalOperation)
      throw new InstallFault('unknown_effect', 'operation_probe_unavailable')
    const observed = result(await ports.readLocalOperation(structuredClone(record.operation), context))
    verifyInstallObservation(record, observed)
    await identity(record, context)
    if (observed.state !== 'published' || !observed.receipt)
      throw new InstallFault('unknown_effect', 'operation_unknown')
    const current = ports.journal.read(record.proposal.proposalId)
    if (current.proposal.resultRef) return current.proposal
    return save(
      current,
      {
        ...(current.applyCheckpoint
          ? { applyCheckpoint: { ...current.applyCheckpoint, phase: 'done' } }
          : {}),
      },
      { status: 'applied', resultRef: observed.receipt },
    ).proposal
  }
  const controller = {
    requestApproval(proposalId: string, expectedRevision: number, context: CallContext) {
      return attempt(async () => {
        const saved = ports.journal.read(proposalId)
        const who = await identity(saved, context)
        if (saved.cancellation) throw new InstallFault('cancelled', 'proposal_cancelled')
        if (saved.proposal.revision !== expectedRevision)
          throw new InstallFault('conflict', 'proposal_revision_conflict')
        if (!saved.proposal.plan || saved.proposal.status !== 'awaiting-approval')
          throw new InstallFault('conflict', 'proposal_not_awaiting_approval')
        if (saved.applyCheckpoint) {
          if (!ports.deploymentApproval) throw new InstallFault('denied', 'deployment_approval_unavailable')
          const binding = saved.applyCheckpoint.binding
          validateDeploymentBinding(approvalRequest(saved, who), binding)
          const checked = await ports.deploymentApproval.verify(
            { request: approvalRequest(saved, who), binding },
            context,
          )
          if (!checked.ok) {
            const native = result(
              await ports.deploymentApproval.read(
                { proposalId, interactionId: saved.applyCheckpoint.interactionId },
                context,
              ),
            )
            if (native.status === 'pending')
              result(
                await ports.deploymentApproval.cancel(
                  { proposalId, interactionId: native.interactionId, reason: 'deployment_input_changed' },
                  context,
                ),
              )
            throw new InstallFault(checked.error.code, checked.error.detailCode)
          }
          return saved.proposal
        }
        if (!ports.deploymentApproval) throw new InstallFault('denied', 'deployment_approval_unavailable')
        const interaction = result(
          await ports.deploymentApproval.request(approvalRequest(saved, who), context),
        )
        installerWire('Id', interaction.interactionId)
        validateDeploymentBinding(approvalRequest(saved, who), interaction.binding)
        await identity(saved, context)
        return save(
          saved,
          {
            applyCheckpoint: {
              interactionId: interaction.interactionId,
              binding: interaction.binding,
              responseId: null,
              inputsDigest: null,
              phase: 'approval',
              buildEvidence: [],
              candidateRef: null,
            },
          },
          { interactionRef: { interactionId: interaction.interactionId } },
        ).proposal
      })
    },
    /** Replanning creates a new immutable proposal and fresh Action; old answers never move. */
    supersedeApproval(
      oldId: string,
      oldRevision: number,
      newId: string,
      newRevision: number,
      context: CallContext,
    ): Promise<Outcome<W['ChangeProposal']>> {
      return attempt(async () => {
        const old = ports.journal.read(oldId),
          next = ports.journal.read(newId)
        await identity(old, context)
        await identity(next, context)
        if (
          oldId === newId ||
          old.proposal.revision !== oldRevision ||
          next.proposal.revision !== newRevision
        )
          throw new InstallFault('conflict', 'proposal_revision_conflict')
        if (
          old.operation ||
          old.cancellation ||
          next.operation ||
          next.applyCheckpoint ||
          next.proposal.status !== 'awaiting-approval' ||
          !old.applyCheckpoint ||
          !ports.deploymentApproval
        )
          throw new InstallFault('conflict', 'proposal_not_awaiting_approval')
        result(
          await ports.deploymentApproval.cancel(
            {
              proposalId: oldId,
              interactionId: old.applyCheckpoint.interactionId,
              reason: 'deployment_input_changed',
            },
            context,
          ),
        )
        await identity(old, context)
        save(old, { cancellation: { reason: 'deployment_input_changed' } }, { status: 'cancelled' })
        return result(await controller.requestApproval(newId, newRevision, context))
      })
    },
    /** After a lost response only the original operation is probed; no unconfirmed step is replayed. */
    apply(proposalId: string, expectedRevision: number, context: CallContext) {
      const call = { ...context, signal: AbortSignal.any([context.signal, lifetime.signal]) }
      return attempt(async () => {
        let record = ports.journal.read(proposalId)
        await identity(record, call)
        if (record.proposal.revision !== expectedRevision)
          throw new InstallFault('conflict', 'proposal_revision_conflict')
        if (record.operation) return probe(record, call)
        const checked = await guard(proposalId, call)
        record = checked.record
        if (!['awaiting-approval', 'approved'].includes(record.proposal.status))
          throw new InstallFault('conflict', 'proposal_not_awaiting_approval')
        if (!ports.executionInputs || !ports.readLocalOperation)
          throw new InstallFault('incompatible', 'installer_effect_unimplemented')
        const supplied = result(await ports.executionInputs(structuredClone(record), call))
        const inputs = {
          ...supplied,
          operation: structuredClone(supplied.operation),
          graph: structuredClone(supplied.graph),
          builds: supplied.builds.map((b) => ({
            ...b,
            plan: structuredClone(b.plan),
            lock: structuredClone(b.lock),
            limits: structuredClone(b.limits),
          })),
        }
        installerWire('Id', inputs.operation.operationId)
        installerWire('DataRef', inputs.operation.reference)
        const plan = record.proposal.plan!
        if (plan.kind === 'release') {
          if (
            inputs.operation.operationId !== plan.value.upgradeId ||
            !inputs.graph ||
            !ports.candidate ||
            !ports.publish ||
            !ports.retainOperation
          )
            throw new InstallFault('incompatible', 'installer_effect_unimplemented')
          installerWire('AssemblyGraph', inputs.graph)
          if (
            inputs.builds.some(
              (task) =>
                !inputs.graph?.lock.entries.some(
                  (entry) => installerDigest(entry) === installerDigest(task.lock),
                ),
            )
          )
            throw new InstallFault('conflict', 'plan_input_conflict')
          if (
            installerDigest(inputs.graph.bindings) !==
              installerDigest(plan.value.targetReleaseSet.bindings) ||
            inputs.graph.lock.entries.length !== plan.value.targetReleaseSet.packages.length ||
            inputs.graph.lock.entries.some(
              (entry) =>
                !plan.value.targetReleaseSet.packages.some(
                  (pkg) =>
                    pkg.packageId === entry.packageId &&
                    pkg.digest === entry.digest &&
                    pkg.version === entry.version,
                ),
            )
          )
            throw new InstallFault('conflict', 'plan_input_conflict')
        } else if (!ports.resourceApply || inputs.graph || inputs.builds.length)
          throw new InstallFault('incompatible', 'resource_apply_unavailable')
        const digest = installerDigest({
          operation: inputs.operation,
          graph: inputs.graph,
          builds: inputs.builds.map((b) => ({
            lock: b.lock,
            plan: b.plan,
            approvalDigest: packageBuildApprovalDigest(b.plan, b.limits, b.minimumOwnership),
          })),
        })
        record = (await guard(proposalId, call)).record
        if (record.proposal.status === 'awaiting-approval')
          record = save(
            record,
            {
              approvalRef: checked.terminal.reference,
              applyCheckpoint: { ...record.applyCheckpoint!, responseId: checked.terminal.responseId },
            },
            { status: 'approved' },
          )
        record = (await guard(proposalId, call)).record
        record = save(
          record,
          {
            operation: inputs.operation,
            applyCheckpoint: { ...record.applyCheckpoint!, inputsDigest: digest, phase: 'started' },
          },
          { status: 'applying' },
        )
        if (plan.kind === 'resource') {
          await guard(proposalId, call)
          const receipt = result(
            await ports.resourceApply!({ operation: inputs.operation, plan: plan.value }, call),
          )
          installerWire('ReceiptPointer', receipt)
          return probe(record, call)
        }
        await guard(proposalId, call)
        result(await ports.retainOperation!(plan.value, inputs.operation, call))
        const evidence: W['DataRef'][] = []
        for (const task of inputs.builds) {
          await guard(proposalId, call)
          const expected = packageBuildApprovalDigest(task.plan, task.limits, task.minimumOwnership)
          const built = result(
            await buildLockedPackage({
              ...task,
              signal: call.signal,
              authorize: async (digest) => {
                if (digest !== expected) return false
                try {
                  await guard(proposalId, call)
                  return true
                } catch {
                  return false
                }
              },
            }),
          )
          const locked = plan.value.targetReleaseSet.packages.find((p) => p.packageId === task.lock.packageId)
          if (
            !locked ||
            locked.digest !== built.inspection.packageDigest ||
            (task.lock.manifestRef.kind === 'inline'
              ? task.lock.manifestRef.digest
              : task.lock.manifestRef.blob.digest) !== built.inspection.manifestDigest
          )
            throw new InstallFault('conflict', 'build_release_conflict')
          evidence.push(
            ref(
              installerWire('JsonValue', {
                approvalDigest: built.approvalDigest,
                reproducibility: built.reproducibility,
                audit: built.audit,
              }),
            ),
          )
          record = (await guard(proposalId, call)).record
          record = save(record, {
            applyCheckpoint: { ...record.applyCheckpoint!, buildEvidence: [...evidence], phase: 'built' },
          })
        }
        record = (await guard(proposalId, call)).record
        const candidate = installerWire(
          'AssemblyPrepareResult',
          result(await ports.candidate!({ graph: inputs.graph! }, call)),
        )
        if (candidate.readiness.state !== 'ready')
          throw new InstallFault('conflict', 'candidate_not_prepared')
        record = (await guard(proposalId, call)).record
        record = save(record, {
          applyCheckpoint: {
            ...record.applyCheckpoint!,
            candidateRef: candidate.candidateRef,
            phase: 'prepared',
          },
        })
        record = (await guard(proposalId, call)).record
        record = save(record, { applyCheckpoint: { ...record.applyCheckpoint!, phase: 'publishing' } })
        await guard(proposalId, call)
        result(
          await ports.publish!(
            {
              candidateRef: candidate.candidateRef,
              expectedPublishedRevision: plan.value.expectedRouteRevision ?? 0,
            },
            call,
          ),
        )
        return probe(record, call)
      })
    },
    responseStatus(proposalId: string, responseId: string, context: CallContext) {
      return attempt(async () => {
        const saved = ports.journal.read(proposalId)
        await identity(saved, context)
        if (!ports.deploymentApproval || !saved.applyCheckpoint)
          throw new InstallFault('denied', 'deployment_approval_unavailable')
        installerWire('Id', responseId)
        const response = result(
          await ports.deploymentApproval.responseStatus(
            { proposalId, interactionId: saved.applyCheckpoint.interactionId, responseId },
            context,
          ),
        )
        const who = await identity(saved, context)
        validateDeploymentBinding(approvalRequest(saved, who), saved.applyCheckpoint.binding)
        validateDeploymentTerminal(response)
        if (installerDigest(response.binding) !== installerDigest(saved.applyCheckpoint.binding))
          throw new InstallFault('conflict', 'operation_identity_conflict')
        if (
          response.proposalId !== proposalId ||
          response.interactionId !== saved.applyCheckpoint.interactionId ||
          response.responseId !== responseId
        )
          throw new InstallFault('conflict', 'operation_identity_conflict')
        return response
      })
    },
    dispose() {
      disposed = true
      lifetime.abort()
    },
  }
  return controller
}
