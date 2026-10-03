import { createHash } from 'node:crypto'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import {
  computeApprovalIntentDigest,
  validateApprovalAnswerForRequest,
  validateInlineApprovalAnswerReference,
  validateRuntime,
  type RuntimeWireTypes as W,
} from '@agnes/protocol/runtime'

export interface DeploymentIdentity {
  readonly tenantId: string
  readonly principalRef: string
  readonly credentialRef: string
}
export interface DeploymentApprovalRequest {
  readonly proposalId: string
  readonly planRevision: number
  readonly plan: NonNullable<W['ChangeProposal']['plan']>
  readonly planDigest: string
  readonly capabilityDifference:
    | W['ReleasePlan']['permissionDifference']
    | W['ResourceChangePlan']['permissionDifference']
  readonly sourceDifference: W['ChangeProposalRequest']['change']
  readonly requester: string
  readonly scope: W['ScopeRef']
  readonly identity: DeploymentIdentity
}
export interface FrozenDeploymentInput {
  readonly planRef: W['DataRef']
  readonly input: W['DataRef']
  readonly inputDigest: string
  readonly sourceHeads: W['UpgradeExpectedHeads'] | null
  readonly expiresAt: string
}
export interface DeploymentApprovalBinding extends FrozenDeploymentInput {
  readonly proposalId: string
  readonly planRevision: number
  readonly planDigest: string
  readonly scope: W['ScopeRef']
  readonly tenantId: string
  readonly owner: W['InteractionRecord']['owner']
  readonly actionRef: string
  readonly request: W['ApprovalRequest']
  readonly authorizationRef: W['DataRef']
}
export interface DeploymentApprovalTerminal {
  readonly binding: DeploymentApprovalBinding
  readonly interaction: W['InteractionRecord']
  readonly proposalId: string
  readonly interactionId: string
  readonly responseId: string | null
  readonly status: 'pending' | 'answered' | 'expired' | 'cancelled'
  readonly decision: 'approve' | 'deny' | null
  readonly intentDigest: string
  readonly expiresAt: string
  readonly owner: W['InteractionRecord']['owner']
  readonly tenantId: string
  readonly scope: W['ScopeRef']
  readonly reference: W['DataRef']
}
export interface DeploymentApprovalPort {
  request(
    input: DeploymentApprovalRequest,
    context: CallContext,
  ): Promise<Outcome<{ interactionId: string; binding: DeploymentApprovalBinding }>>
  read(
    input: { proposalId: string; interactionId: string },
    context: CallContext,
  ): Promise<Outcome<DeploymentApprovalTerminal>>
  responseStatus(
    input: { proposalId: string; interactionId: string; responseId: string },
    context: CallContext,
  ): Promise<Outcome<DeploymentApprovalTerminal>>
  /** Original State/codec/source proof, including current source heads and approved scope. */
  verify(
    input: { request: DeploymentApprovalRequest; binding: DeploymentApprovalBinding },
    context: CallContext,
  ): Promise<Outcome<void>>
  cancel(
    input: { proposalId: string; interactionId: string; reason: string },
    context: CallContext,
  ): Promise<Outcome<void>>
}
/** Missing State/admission/codec capabilities refuse; no IDs, sessions or control rows are fabricated. */
export interface DeploymentApprovalAdapterPorts {
  freeze?:
    | ((request: DeploymentApprovalRequest, context: CallContext) => Promise<Outcome<FrozenDeploymentInput>>)
    | null
  /** Select a current authorized helper Run, otherwise normal AdmissionTicket/createRun for a controlled management session. */
  openCarrier?:
    | ((
        request: DeploymentApprovalRequest,
        context: CallContext,
      ) => Promise<Outcome<{ runId: string; context: CallContext }>>)
    | null
  /** Create a fresh real Action. Do not rewrite the completed requestChange Action. */
  prepareAction?:
    | ((
        input: { request: DeploymentApprovalRequest; frozen: FrozenDeploymentInput; runId: string },
        context: CallContext,
      ) => Promise<
        Outcome<{ owner: W['InteractionRecord']['owner']; actionRef: string; request: W['ApprovalRequest'] }>
      >)
    | null
  prepareAuthorization?:
    | ((
        input: { owner: W['InteractionRecord']['owner']; request: W['ApprovalRequest']; input: W['DataRef'] },
        context: CallContext,
      ) => Promise<Outcome<W['DataRef']>>)
    | null
  prepareApproval?:
    | ((
        input: {
          owner: W['InteractionRecord']['owner']
          request: W['ApprovalRequest']
          authorizationRef: W['DataRef']
        },
        context: CallContext,
      ) => Promise<Outcome<W['InteractionRecord']>>)
    | null
  read?: DeploymentApprovalPort['read'] | null
  responseStatus?: DeploymentApprovalPort['responseStatus'] | null
  verify?: DeploymentApprovalPort['verify'] | null
  cancelInteraction?:
    | ((
        input: W['InteractionCancelRequest'],
        context: CallContext,
      ) => Promise<Outcome<W['InteractionRecord']>>)
    | null
}

export class ApprovalFailure extends Error {
  constructor(
    readonly code: W['RuntimeErrorCode'],
    readonly detail: string,
  ) {
    super(detail)
  }
}
const hash = (input: unknown) => createHash('sha256').update(jcs(input)).digest('hex')
function reject(detail = 'deployment_approval_mismatch'): never {
  throw new ApprovalFailure('denied', detail)
}
function decode<K extends keyof W>(schema: K, input: unknown): W[K] {
  const result = validateRuntime(schema, input)
  if (!result.ok) throw new ApprovalFailure('invalid_input', 'schema_invalid')
  return structuredClone(result.value)
}
function unwrap<T>(outcome: Outcome<T>): T {
  if (outcome.ok) return outcome.value
  throw new ApprovalFailure(outcome.error.code, outcome.error.detailCode)
}
function failure(
  code: W['RuntimeErrorCode'] = 'denied',
  detail = 'deployment_approval_unavailable',
): Outcome<never> {
  return {
    ok: false,
    error: {
      code,
      detailCode: detail,
      message: detail,
      diagnosticId: `installer:${detail}`,
      retryAdvice: { kind: 'never' },
    },
  }
}
export function validateReferenceDeploymentBinding(
  source: DeploymentApprovalRequest,
  proof: DeploymentApprovalBinding,
) {
  for (const reference of [proof.input, proof.planRef, proof.authorizationRef]) decode('DataRef', reference)
  decode('Id', proof.owner.actionId)
  decode('Id', proof.owner.runId)
  const question = decode('ApprovalRequest', proof.request)
  const computed = computeApprovalIntentDigest(question)
  const plan = { ...source.plan.value }
  Reflect.deleteProperty(plan, source.plan.kind === 'resource' ? 'digest' : 'planFingerprint')
  const comparisons: readonly [unknown, unknown][] = [
    [proof.proposalId, source.proposalId],
    [proof.planRevision, source.planRevision],
    [proof.planDigest, source.planDigest],
    [hash(plan), source.planDigest],
    [proof.tenantId, source.identity.tenantId],
    [proof.scope, source.scope],
    [question.scope, source.scope],
    [proof.actionRef, question.actionRef],
    [proof.inputDigest, hash(proof.input)],
    [proof.inputDigest, question.inputDigest],
    [proof.expiresAt, question.expiresAt],
  ]
  if (
    comparisons.some(([a, b]) => hash(a) !== hash(b)) ||
    !computed.ok ||
    computed.value !== question.intentDigest ||
    proof.owner.actionId === source.proposalId ||
    !Number.isFinite(Date.parse(proof.expiresAt))
  )
    reject()
  if (source.plan.kind === 'release' && Date.parse(proof.expiresAt) > Date.parse(source.plan.value.expiresAt))
    reject()
  if (proof.sourceHeads) decode('UpgradeExpectedHeads', proof.sourceHeads)
  if (source.plan.kind === 'release') {
    const previous = source.plan.value,
      current = proof.sourceHeads
    if (previous.sourceReleaseSetId === null) {
      if (current) throw new ApprovalFailure('conflict', 'deployment_source_changed')
    } else if (
      current?.kind !== 'release' ||
      hash([current.routeId, current.releaseSetId, current.routeRevision]) !==
        hash([previous.routeId, previous.sourceReleaseSetId, previous.expectedRouteRevision])
    )
      throw new ApprovalFailure('conflict', 'deployment_source_changed')
  }
}
export function validateReferenceDeploymentTerminal(view: DeploymentApprovalTerminal) {
  const entry = decode('InteractionRecord', view.interaction)
  if (entry.request.kind !== 'approval') reject()
  if (
    hash(entry.owner) !== hash(view.binding.owner) ||
    hash(entry.owner) !== hash(view.owner) ||
    hash(entry.request) !== hash(view.binding.request) ||
    entry.status !== view.status ||
    entry.interactionId !== view.interactionId ||
    entry.request.intentDigest !== view.intentDigest ||
    entry.request.expiresAt !== view.expiresAt
  )
    reject()
  const response = entry.status === 'answered' ? entry.resolution.responseId : null
  if (response !== view.responseId) reject()
  if (entry.status !== 'answered') {
    if (view.decision !== null) reject()
    return
  }
  if (entry.resolution.answer.kind !== 'inline') reject('deployment_answer_decoder_unavailable')
  const codec = validateInlineApprovalAnswerReference(entry.request, entry.resolution.answer)
  if (!codec.ok) reject()
  const answer = validateApprovalAnswerForRequest(entry.request, entry.resolution.answer.value)
  if (!answer.ok || answer.value.decision !== view.decision) reject()
}
export function createReferenceDeploymentApprovalAdapter(
  dependencies: DeploymentApprovalAdapterPorts,
): DeploymentApprovalPort {
  const closed = async () => failure()
  return {
    async request(source, caller) {
      try {
        const { freeze, openCarrier, prepareAction, prepareAuthorization, prepareApproval, verify } =
          dependencies
        if (
          !freeze ||
          !openCarrier ||
          !prepareAction ||
          !prepareAuthorization ||
          !prepareApproval ||
          !verify ||
          !dependencies.read ||
          !dependencies.responseStatus ||
          !dependencies.cancelInteraction
        )
          return failure()
        const input = unwrap(await freeze(source, caller))
        const carrier = unwrap(await openCarrier(source, caller))
        decode('Id', carrier.runId)
        const created = unwrap(
          await prepareAction({ request: source, frozen: input, runId: carrier.runId }, carrier.context),
        )
        if (created.owner.runId !== carrier.runId) reject('deployment_carrier_mismatch')
        const state = unwrap(
          await prepareAuthorization(
            { owner: created.owner, request: created.request, input: input.input },
            carrier.context,
          ),
        )
        const proof: DeploymentApprovalBinding = {
          proposalId: source.proposalId,
          planRevision: source.planRevision,
          scope: source.scope,
          planDigest: source.planDigest,
          tenantId: source.identity.tenantId,
          ...input,
          ...created,
          authorizationRef: state,
        }
        validateReferenceDeploymentBinding(source, proof)
        unwrap(await verify({ request: source, binding: proof }, caller))
        const native = decode(
          'InteractionRecord',
          unwrap(
            await prepareApproval(
              { owner: created.owner, request: created.request, authorizationRef: state },
              carrier.context,
            ),
          ),
        )
        if (hash([native.owner, native.request]) !== hash([proof.owner, proof.request])) reject()
        return { ok: true, value: { binding: proof, interactionId: native.interactionId } }
      } catch (error) {
        return error instanceof ApprovalFailure ? failure(error.code, error.detail) : failure('internal')
      }
    },
    async cancel(ids, call) {
      if (!dependencies.read || !dependencies.cancelInteraction) return failure()
      try {
        const previous = unwrap(await dependencies.read(ids, call)).interaction
        if (previous.interactionId !== ids.interactionId)
          throw new ApprovalFailure('conflict', 'operation_identity_conflict')
        if (previous.status !== 'pending') return { ok: true, value: undefined }
        const request = {
          expectedVersion: previous.version,
          reason: ids.reason,
          interactionId: ids.interactionId,
        }
        const result = decode(
          'InteractionRecord',
          unwrap(await dependencies.cancelInteraction(request, call)),
        )
        if (
          result.interactionId !== ids.interactionId ||
          result.status !== 'cancelled' ||
          hash(result.owner) !== hash(previous.owner)
        )
          throw new ApprovalFailure('conflict', 'operation_identity_conflict')
        return { ok: true, value: undefined }
      } catch (error) {
        return error instanceof ApprovalFailure ? failure(error.code, error.detail) : failure('internal')
      }
    },
    verify: dependencies.verify ?? closed,
    responseStatus: dependencies.responseStatus ?? closed,
    read: dependencies.read ?? closed,
  }
}
export const createReferenceRefusingDeploymentApprovalPort = () =>
  createReferenceDeploymentApprovalAdapter({})
