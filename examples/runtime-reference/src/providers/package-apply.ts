import { createHash } from 'node:crypto'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import { validateRuntime, type RuntimeWireTypes as W } from '@agnes/protocol/runtime'
import {
  type DeploymentApprovalTerminal as Answer,
  type DeploymentApprovalBinding,
  type DeploymentApprovalPort,
  type DeploymentApprovalRequest,
  type DeploymentIdentity as Identity,
  ApprovalFailure as NativeApprovalFailure,
  validateReferenceDeploymentBinding,
  validateReferenceDeploymentTerminal,
} from './deployment-approval.js'
import { type ReferenceInstallRecord, type ReferenceMaintenancePorts, Refusal } from './package-installer.js'

interface Build {
  lock: W['PackageLockEntry']
  plan: { digest: string }
  limits: W['ResourceLimits']
  minimumOwnership: string
}
export interface ReferenceApplyCheckpoint {
  interactionId: string
  binding: DeploymentApprovalBinding
  responseId: string | null
  inputsDigest: string | null
  phase: 'approval' | 'started' | 'built' | 'prepared' | 'publishing' | 'done'
  buildEvidence: readonly W['DataRef'][]
  candidateRef: W['DataRef'] | null
}
export interface ReferenceApplyPorts {
  deploymentAudit?:
    | ((
        input: {
          proposalId: string
          tenantId: string
          principalRef: string
          credentialRef: string
          scope: W['ScopeRef']
          permission: 'maintain'
        },
        call: CallContext,
      ) => Promise<Outcome<void>>)
    | null
  retainOperation?:
    | ((
        plan: W['ReleasePlan'],
        operation: NonNullable<ReferenceInstallRecord['operation']>,
        c: CallContext,
      ) => Promise<Outcome<void>>)
    | null
  deploymentIdentity?: ((call: CallContext, scope: W['ScopeRef']) => Promise<Outcome<Identity>>) | null
  deploymentApproval?: DeploymentApprovalPort | null
  executionInputs?:
    | ((
        saved: ReferenceInstallRecord,
        call: CallContext,
      ) => Promise<
        Outcome<{
          operation: NonNullable<ReferenceInstallRecord['operation']>
          graph: W['AssemblyGraph'] | null
          builds: readonly Build[]
        }>
      >)
    | null
  /** Independent installer consumes an explicitly supplied isolated builder, never the default installer. */
  buildPackage?:
    | ((input: Build & { signal: AbortSignal; authorize: (digest: string) => Promise<boolean> }) => Promise<
        Outcome<{
          inspection: { packageDigest: string; manifestDigest: string }
          approvalDigest: string
          reproducibility: unknown
          audit: unknown
        }>
      >)
    | null
  resourceApply?:
    | ((
        input: { operation: NonNullable<ReferenceInstallRecord['operation']>; plan: W['ResourceChangePlan'] },
        call: CallContext,
      ) => Promise<Outcome<W['ReceiptPointer']>>)
    | null
}
class ApplyError extends Error {
  constructor(
    readonly code: W['RuntimeErrorCode'],
    readonly detail: string,
  ) {
    super(detail)
  }
}
const hash = (v: unknown) => createHash('sha256').update(jcs(v)).digest('hex')
function refuse(code: W['RuntimeErrorCode'], detail: string): never {
  throw new ApplyError(code, detail)
}
const take = <T>(r: Outcome<T>) => (r.ok ? r.value : refuse(r.error.code, r.error.detailCode))
function wire<K extends keyof W>(name: K, v: unknown): W[K] {
  const checked = validateRuntime(name, v)
  return checked.ok ? structuredClone(checked.value) : refuse('invalid_input', 'schema_invalid')
}
const buildDigest = (b: Build) =>
  hash({
    planDigest: b.plan.digest,
    limits: b.limits,
    minimumOwnership: b.minimumOwnership,
    shell: '/bin/sh',
    source: ['source', 'source.archive'],
    output: 'artifact.tar',
    attempts: 2,
  })
export function createReferencePackageApplyController(p: ReferenceMaintenancePorts & ReferenceApplyPorts) {
  let closed = false
  const stop = new AbortController()
  const active = (c: CallContext) => {
    if (closed) refuse('internal', 'provider_disposed')
    if (c.signal.aborted) refuse('cancelled', 'call_cancelled')
  }
  async function access(r: ReferenceInstallRecord, c: CallContext) {
    active(c)
    if (!p.currentAuthorization) refuse('denied', 'current_authorization_unavailable')
    if (!p.deploymentIdentity) refuse('denied', 'deployment_identity_unavailable')
    const id = take(await p.deploymentIdentity(c, r.proposal.scope))
    for (const field of [id.tenantId, id.principalRef, id.credentialRef]) wire('Id', field)
    if (id.principalRef !== c.principalRef || !c.authorizationRef) refuse('denied', 'principal_mismatch')
    if (take(await p.currentAuthorization(c, r.proposal.scope, 'maintain')) !== id.principalRef)
      refuse('denied', 'principal_mismatch')
    if (!p.deploymentAudit) refuse('denied', 'deployment_audit_unavailable')
    take(
      await p.deploymentAudit(
        { proposalId: r.proposal.proposalId, ...id, scope: r.proposal.scope, permission: 'maintain' },
        c,
      ),
    )
    active(c)
    return id
  }
  const update = (
    r: ReferenceInstallRecord,
    fields: Partial<ReferenceInstallRecord>,
    change: Partial<W['ChangeProposal']> = {},
  ) =>
    p.journal.compareAndSwap(r.proposal.proposalId, r.proposal.revision, {
      ...r,
      ...fields,
      proposal: { ...r.proposal, ...change, revision: r.proposal.revision + 1 },
    })
  function source(row: ReferenceInstallRecord, actor: Identity): DeploymentApprovalRequest {
    const plan = row.proposal.plan,
      digest = row.proposal.planDigest
    if (!plan || !digest) refuse('conflict', 'proposal_not_planned')
    return {
      proposalId: row.proposal.proposalId,
      planRevision: row.applyCheckpoint?.binding.planRevision ?? row.proposal.revision,
      plan,
      planDigest: digest,
      capabilityDifference: plan.value.permissionDifference,
      sourceDifference: row.input.change,
      requester: row.owner,
      scope: row.proposal.scope,
      identity: actor,
    }
  }
  async function approved(id: string, c: CallContext) {
    const r = p.journal.read(id),
      actor = await access(r, c),
      plan = r.proposal.plan
    if (r.cancellation) refuse('cancelled', 'proposal_cancelled')
    if (!plan || !r.proposal.planDigest) refuse('conflict', 'proposal_not_planned')
    if (!p.deploymentApproval || !r.applyCheckpoint) refuse('denied', 'deployment_approval_unavailable')
    const a = take(
      await p.deploymentApproval.read({ proposalId: id, interactionId: r.applyCheckpoint.interactionId }, c),
    )
    const proof = r.applyCheckpoint.binding
    try {
      validateReferenceDeploymentBinding(source(r, actor), proof)
      validateReferenceDeploymentTerminal(a)
    } catch (error) {
      if (error instanceof NativeApprovalFailure) refuse(error.code, error.detail)
      refuse('denied', 'deployment_approval_mismatch')
    }
    if (hash(a.binding) !== hash(proof)) refuse('denied', 'deployment_approval_mismatch')
    const checked = await p.deploymentApproval.verify({ request: source(r, actor), binding: proof }, c)
    if (!checked.ok) {
      if (a.status === 'pending')
        take(
          await p.deploymentApproval.cancel(
            { proposalId: id, interactionId: a.interactionId, reason: 'deployment_input_changed' },
            c,
          ),
        )
      refuse(checked.error.code, checked.error.detailCode)
    }
    const time = Date.parse(p.now()),
      expiry = Date.parse(a.expiresAt)
    const valid =
      a.status === 'answered' &&
      a.decision === 'approve' &&
      Boolean(a.responseId) &&
      a.proposalId === id &&
      a.interactionId === r.applyCheckpoint.interactionId &&
      a.intentDigest === proof.request.intentDigest &&
      hash(a.owner) === hash(proof.owner) &&
      a.tenantId === actor.tenantId &&
      hash(a.scope) === hash(r.proposal.scope) &&
      Number.isFinite(time) &&
      Number.isFinite(expiry) &&
      expiry > time &&
      (plan.kind === 'resource' || Date.parse(plan.value.expiresAt) > time) &&
      (r.applyCheckpoint.responseId === null || r.applyCheckpoint.responseId === a.responseId)
    if (!valid) refuse('denied', 'deployment_approval_mismatch')
    wire('Id', a.responseId)
    wire('DataRef', a.reference)
    if (plan.kind === 'release') {
      if (!p.resolveReleaseRoute) refuse('denied', 'release_target_validation_unavailable')
      if (take(await p.resolveReleaseRoute(r.proposal.scope, c)) !== plan.value.routeId)
        refuse('conflict', 'plan_target_conflict')
    }
    await access(r, c)
    const latest = p.journal.read(id)
    active(c)
    if (latest.cancellation) refuse('cancelled', 'proposal_cancelled')
    if (latest.proposal.revision !== r.proposal.revision) refuse('conflict', 'proposal_revision_conflict')
    return { r, a }
  }
  async function recover(r: ReferenceInstallRecord, c: CallContext) {
    await access(r, c)
    if (!r.operation || !p.readLocalOperation) refuse('unknown_effect', 'operation_probe_unavailable')
    const o = take(await p.readLocalOperation(structuredClone(r.operation), c))
    if (o.operationId !== r.operation.operationId || o.planDigest !== r.proposal.planDigest)
      refuse('conflict', 'operation_identity_conflict')
    if (r.proposal.plan?.kind === 'resource') {
      if (o.heads !== null) refuse('conflict', 'operation_identity_conflict')
    } else if (
      !(
        o.heads === null &&
        r.proposal.plan?.kind === 'release' &&
        r.proposal.plan.value.sourceReleaseSetId === null &&
        o.state !== 'published'
      )
    )
      wire('UpgradeExpectedHeads', o.heads)
    if (o.checkpoint !== null) wire('UpgradeCheckpoint', o.checkpoint)
    if (o.receipt !== null) wire('ReceiptPointer', o.receipt)
    if (!['unpublished', 'published', 'unknown'].includes(o.state))
      refuse('invalid_input', 'operation_observation_invalid')
    if (o.state === 'published' && o.receipt === null) refuse('conflict', 'publication_receipt_missing')
    if (o.state === 'unpublished' && (o.receipt || r.proposal.resultRef))
      refuse('conflict', 'publication_fact_conflict')
    if (r.proposal.resultRef && o.receipt && hash(r.proposal.resultRef) !== hash(o.receipt))
      refuse('conflict', 'publication_fact_conflict')
    await access(r, c)
    if (o.state !== 'published' || !o.receipt) refuse('unknown_effect', 'operation_unknown')
    const latest = p.journal.read(r.proposal.proposalId)
    if (latest.proposal.resultRef) return latest.proposal
    return update(
      latest,
      latest.applyCheckpoint ? { applyCheckpoint: { ...latest.applyCheckpoint, phase: 'done' } } : {},
      { status: 'applied', resultRef: o.receipt },
    ).proposal
  }
  async function run<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
    try {
      return { value: await fn(), ok: true }
    } catch (e) {
      const code = e instanceof ApplyError ? e.code : e instanceof Refusal ? e.category : 'internal',
        detailCode = e instanceof ApplyError || e instanceof Refusal ? e.detail : 'installer_port_unavailable'
      return {
        ok: false,
        error: {
          code,
          detailCode,
          message: detailCode,
          diagnosticId: `installer:${detailCode}`,
          retryAdvice: { kind: 'never' },
        },
      }
    }
  }
  const controller = {
    requestApproval(id: string, revision: number, c: CallContext) {
      return run(async () => {
        const r = p.journal.read(id),
          actor = await access(r, c)
        if (r.cancellation) refuse('cancelled', 'proposal_cancelled')
        if (r.proposal.revision !== revision) refuse('conflict', 'proposal_revision_conflict')
        if (r.proposal.status !== 'awaiting-approval' || !r.proposal.plan)
          refuse('conflict', 'proposal_not_awaiting_approval')
        if (r.applyCheckpoint) {
          if (!p.deploymentApproval) refuse('denied', 'deployment_approval_unavailable')
          try {
            validateReferenceDeploymentBinding(source(r, actor), r.applyCheckpoint.binding)
          } catch (error) {
            if (error instanceof NativeApprovalFailure) refuse(error.code, error.detail)
            refuse('denied', 'deployment_approval_mismatch')
          }
          const check = await p.deploymentApproval.verify(
            { request: source(r, actor), binding: r.applyCheckpoint.binding },
            c,
          )
          if (!check.ok) {
            const original = take(
              await p.deploymentApproval.read(
                { proposalId: id, interactionId: r.applyCheckpoint.interactionId },
                c,
              ),
            )
            if (original.status === 'pending')
              take(
                await p.deploymentApproval.cancel(
                  {
                    proposalId: id,
                    interactionId: original.interactionId,
                    reason: 'deployment_input_changed',
                  },
                  c,
                ),
              )
            refuse(check.error.code, check.error.detailCode)
          }
          return r.proposal
        }
        if (!p.deploymentApproval) refuse('denied', 'deployment_approval_unavailable')
        const answer = take(await p.deploymentApproval.request(source(r, actor), c))
        wire('Id', answer.interactionId)
        try {
          validateReferenceDeploymentBinding(source(r, actor), answer.binding)
        } catch (error) {
          if (error instanceof NativeApprovalFailure) refuse(error.code, error.detail)
          refuse('denied', 'deployment_approval_mismatch')
        }
        await access(r, c)
        return update(
          r,
          {
            applyCheckpoint: {
              interactionId: answer.interactionId,
              binding: answer.binding,
              responseId: null,
              inputsDigest: null,
              phase: 'approval',
              buildEvidence: [],
              candidateRef: null,
            },
          },
          { interactionRef: { interactionId: answer.interactionId } },
        ).proposal
      })
    },
    supersedeApproval(
      previousId: string,
      previousVersion: number,
      replacementId: string,
      replacementVersion: number,
      c: CallContext,
    ): Promise<Outcome<W['ChangeProposal']>> {
      return run(async () => {
        const previous = p.journal.read(previousId),
          replacement = p.journal.read(replacementId)
        await access(previous, c)
        await access(replacement, c)
        if (
          previousId === replacementId ||
          previous.proposal.revision !== previousVersion ||
          replacement.proposal.revision !== replacementVersion
        )
          refuse('conflict', 'proposal_revision_conflict')
        if (
          previous.operation ||
          previous.cancellation ||
          replacement.operation ||
          replacement.applyCheckpoint ||
          replacement.proposal.status !== 'awaiting-approval' ||
          !previous.applyCheckpoint ||
          !p.deploymentApproval
        )
          refuse('conflict', 'proposal_not_awaiting_approval')
        take(
          await p.deploymentApproval.cancel(
            {
              proposalId: previousId,
              interactionId: previous.applyCheckpoint.interactionId,
              reason: 'deployment_input_changed',
            },
            c,
          ),
        )
        await access(previous, c)
        update(previous, { cancellation: { reason: 'deployment_input_changed' } }, { status: 'cancelled' })
        return take(await controller.requestApproval(replacementId, replacementVersion, c))
      })
    },
    apply(id: string, revision: number, context: CallContext) {
      const c = { ...context, signal: AbortSignal.any([stop.signal, context.signal]) }
      return run(async () => {
        let r = p.journal.read(id)
        await access(r, c)
        if (r.proposal.revision !== revision) refuse('conflict', 'proposal_revision_conflict')
        if (r.operation) return recover(r, c)
        const check = await approved(id, c)
        r = check.r
        if (!['awaiting-approval', 'approved'].includes(r.proposal.status))
          refuse('conflict', 'proposal_not_awaiting_approval')
        if (!p.executionInputs || !p.readLocalOperation)
          refuse('incompatible', 'installer_effect_unimplemented')
        const supplied = take(await p.executionInputs(structuredClone(r), c)),
          plan = r.proposal.plan!
        const setup = {
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
        wire('Id', setup.operation.operationId)
        wire('DataRef', setup.operation.reference)
        if (plan.kind === 'resource') {
          if (!p.resourceApply || setup.graph || setup.builds.length)
            refuse('incompatible', 'resource_apply_unavailable')
        } else {
          if (
            !setup.graph ||
            !p.candidate ||
            !p.publish ||
            !p.retainOperation ||
            setup.operation.operationId !== plan.value.upgradeId
          )
            refuse('incompatible', 'installer_effect_unimplemented')
          const g = wire('AssemblyGraph', setup.graph),
            pkgs = plan.value.targetReleaseSet.packages
          if (
            hash(g.bindings) !== hash(plan.value.targetReleaseSet.bindings) ||
            g.lock.entries.length !== pkgs.length ||
            g.lock.entries.some(
              (e) =>
                !pkgs.some(
                  (t) => t.packageId === e.packageId && t.version === e.version && t.digest === e.digest,
                ),
            )
          )
            refuse('conflict', 'plan_input_conflict')
          if (setup.builds.some((b) => !g.lock.entries.some((e) => hash(e) === hash(b.lock))))
            refuse('conflict', 'plan_input_conflict')
          if (setup.builds.length && !p.buildPackage) refuse('incompatible', 'build_provider_unavailable')
        }
        const fixed = hash({
          operation: setup.operation,
          graph: setup.graph,
          builds: setup.builds.map((b) => ({ lock: b.lock, plan: b.plan, approvalDigest: buildDigest(b) })),
        })
        r = (await approved(id, c)).r
        if (r.proposal.status === 'awaiting-approval')
          r = update(
            r,
            {
              approvalRef: check.a.reference,
              applyCheckpoint: { ...r.applyCheckpoint!, responseId: check.a.responseId },
            },
            { status: 'approved' },
          )
        r = (await approved(id, c)).r
        r = update(
          r,
          {
            operation: setup.operation,
            applyCheckpoint: { ...r.applyCheckpoint!, inputsDigest: fixed, phase: 'started' },
          },
          { status: 'applying' },
        )
        if (plan.kind === 'resource') {
          await approved(id, c)
          wire(
            'ReceiptPointer',
            take(await p.resourceApply!({ operation: setup.operation, plan: plan.value }, c)),
          )
          return recover(r, c)
        }
        await approved(id, c)
        take(await p.retainOperation!(plan.value, setup.operation, c))
        const evidence: W['DataRef'][] = []
        for (const b of setup.builds) {
          await approved(id, c)
          const expected = buildDigest(b),
            output = take(
              await p.buildPackage!({
                ...b,
                signal: c.signal,
                authorize: async (digest) => {
                  if (digest !== expected) return false
                  try {
                    await approved(id, c)
                    return true
                  } catch {
                    return false
                  }
                },
              }),
            )
          const locked = plan.value.targetReleaseSet.packages.find((t) => t.packageId === b.lock.packageId)
          if (
            !locked ||
            locked.digest !== output.inspection.packageDigest ||
            (b.lock.manifestRef.kind === 'inline'
              ? b.lock.manifestRef.digest
              : b.lock.manifestRef.blob.digest) !== output.inspection.manifestDigest
          )
            refuse('conflict', 'build_release_conflict')
          const v = wire('JsonValue', {
            approvalDigest: output.approvalDigest,
            reproducibility: output.reproducibility,
            audit: output.audit,
          })
          evidence.push({
            kind: 'inline',
            value: v,
            digest: hash(v),
            bytes: Buffer.byteLength(JSON.stringify(v)),
            schema: {
              typeId: 'private.package-installer/build@1',
              revision: 1,
              digest: hash('private.package-installer/build@1'),
            },
          })
          r = (await approved(id, c)).r
          r = update(r, {
            applyCheckpoint: { ...r.applyCheckpoint!, phase: 'built', buildEvidence: evidence.slice() },
          })
        }
        r = (await approved(id, c)).r
        const ready = wire('AssemblyPrepareResult', take(await p.candidate!({ graph: setup.graph! }, c)))
        if (ready.readiness.state !== 'ready') refuse('conflict', 'candidate_not_prepared')
        r = (await approved(id, c)).r
        r = update(r, {
          applyCheckpoint: { ...r.applyCheckpoint!, phase: 'prepared', candidateRef: ready.candidateRef },
        })
        r = (await approved(id, c)).r
        r = update(r, { applyCheckpoint: { ...r.applyCheckpoint!, phase: 'publishing' } })
        await approved(id, c)
        take(
          await p.publish!(
            {
              candidateRef: ready.candidateRef,
              expectedPublishedRevision: plan.value.expectedRouteRevision ?? 0,
            },
            c,
          ),
        )
        return recover(r, c)
      })
    },
    responseStatus(id: string, responseId: string, c: CallContext) {
      return run(async () => {
        const r = p.journal.read(id)
        await access(r, c)
        if (!r.applyCheckpoint || !p.deploymentApproval) refuse('denied', 'deployment_approval_unavailable')
        wire('Id', responseId)
        const answer = take(
          await p.deploymentApproval.responseStatus(
            { proposalId: id, interactionId: r.applyCheckpoint.interactionId, responseId },
            c,
          ),
        )
        const actor = await access(r, c)
        try {
          validateReferenceDeploymentBinding(source(r, actor), r.applyCheckpoint.binding)
          validateReferenceDeploymentTerminal(answer)
        } catch (error) {
          if (error instanceof NativeApprovalFailure) refuse(error.code, error.detail)
          refuse('denied', 'deployment_approval_mismatch')
        }
        if (hash(answer.binding) !== hash(r.applyCheckpoint.binding))
          refuse('conflict', 'operation_identity_conflict')
        if (
          answer.responseId !== responseId ||
          answer.proposalId !== id ||
          answer.interactionId !== r.applyCheckpoint.interactionId
        )
          refuse('conflict', 'operation_identity_conflict')
        return answer
      })
    },
    dispose() {
      closed = true
      stop.abort()
    },
  }
  return controller
}

export { createReferenceRefusingDeploymentApprovalPort } from './deployment-approval.js'
