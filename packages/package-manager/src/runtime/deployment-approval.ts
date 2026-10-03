import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import {
  computeApprovalIntentDigest,
  validateApprovalAnswerForRequest,
  validateInlineApprovalAnswerReference,
  type RuntimeWireTypes as W,
} from '@agnes/protocol/runtime'
import { InstallFault, installerDigest, installerFailure, installerWire } from './install-journal.js'

/** Issued by the trusted maintenance root; an approval Action never grants deployment permission. */
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
const value = <T>(outcome: Outcome<T>): T => {
  if (!outcome.ok) throw new InstallFault(outcome.error.code, outcome.error.detailCode)
  return outcome.value
}
export function validateDeploymentBinding(
  request: DeploymentApprovalRequest,
  binding: DeploymentApprovalBinding,
) {
  installerWire('DataRef', binding.planRef)
  installerWire('DataRef', binding.input)
  installerWire('DataRef', binding.authorizationRef)
  installerWire('Id', binding.owner.runId)
  installerWire('Id', binding.owner.actionId)
  const approval = installerWire('ApprovalRequest', binding.request)
  const intent = computeApprovalIntentDigest(approval)
  const body = { ...request.plan.value }
  Reflect.deleteProperty(body, request.plan.kind === 'release' ? 'planFingerprint' : 'digest')
  if (
    !intent.ok ||
    intent.value !== approval.intentDigest ||
    installerDigest(body) !== request.planDigest ||
    binding.proposalId !== request.proposalId ||
    binding.planRevision !== request.planRevision ||
    binding.planDigest !== request.planDigest ||
    binding.tenantId !== request.identity.tenantId ||
    installerDigest(binding.scope) !== installerDigest(request.scope) ||
    installerDigest(approval.scope) !== installerDigest(request.scope) ||
    binding.actionRef !== approval.actionRef ||
    binding.owner.actionId === request.proposalId ||
    binding.inputDigest !== installerDigest(binding.input) ||
    binding.inputDigest !== approval.inputDigest ||
    binding.expiresAt !== approval.expiresAt ||
    !Number.isFinite(Date.parse(binding.expiresAt)) ||
    (request.plan.kind === 'release' &&
      Date.parse(binding.expiresAt) > Date.parse(request.plan.value.expiresAt))
  )
    throw new InstallFault('denied', 'deployment_approval_mismatch')
  if (binding.sourceHeads !== null) installerWire('UpgradeExpectedHeads', binding.sourceHeads)
  if (request.plan.kind === 'release') {
    const plan = request.plan.value,
      heads = binding.sourceHeads
    if (
      plan.sourceReleaseSetId === null
        ? heads !== null
        : heads?.kind !== 'release' ||
          heads.routeId !== plan.routeId ||
          heads.releaseSetId !== plan.sourceReleaseSetId ||
          heads.routeRevision !== plan.expectedRouteRevision
    )
      throw new InstallFault('conflict', 'deployment_source_changed')
  }
}
export function validateDeploymentTerminal(terminal: DeploymentApprovalTerminal) {
  const native = installerWire('InteractionRecord', terminal.interaction)
  if (
    native.request.kind !== 'approval' ||
    native.interactionId !== terminal.interactionId ||
    installerDigest(native.owner) !== installerDigest(terminal.owner) ||
    installerDigest(native.owner) !== installerDigest(terminal.binding.owner) ||
    installerDigest(native.request) !== installerDigest(terminal.binding.request) ||
    terminal.status !== native.status ||
    terminal.intentDigest !== native.request.intentDigest ||
    terminal.expiresAt !== native.request.expiresAt ||
    terminal.responseId !== (native.status === 'answered' ? native.resolution.responseId : null)
  )
    throw new InstallFault('denied', 'deployment_approval_mismatch')
  if (native.status === 'answered') {
    const answer = native.resolution.answer
    if (answer.kind !== 'inline') throw new InstallFault('denied', 'deployment_answer_decoder_unavailable')
    const codec = validateInlineApprovalAnswerReference(native.request, answer)
    if (!codec.ok) throw new InstallFault('denied', 'deployment_approval_mismatch')
    const checked = validateApprovalAnswerForRequest(native.request, answer.value)
    if (!checked.ok || terminal.decision !== checked.value.decision)
      throw new InstallFault('denied', 'deployment_approval_mismatch')
  } else if (terminal.decision !== null) throw new InstallFault('denied', 'deployment_approval_mismatch')
}
export function createDeploymentApprovalAdapter(
  ports: DeploymentApprovalAdapterPorts,
): DeploymentApprovalPort {
  const unavailable = async () => installerFailure<never>('denied', 'deployment_approval_unavailable')
  return {
    async request(request, context) {
      try {
        if (
          !ports.freeze ||
          !ports.openCarrier ||
          !ports.prepareAction ||
          !ports.prepareAuthorization ||
          !ports.prepareApproval ||
          !ports.read ||
          !ports.responseStatus ||
          !ports.cancelInteraction ||
          !ports.verify
        )
          return unavailable()
        const frozen = value(await ports.freeze(request, context))
        const carrier = value(await ports.openCarrier(request, context))
        installerWire('Id', carrier.runId)
        const action = value(
          await ports.prepareAction({ request, frozen, runId: carrier.runId }, carrier.context),
        )
        if (action.owner.runId !== carrier.runId)
          throw new InstallFault('denied', 'deployment_carrier_mismatch')
        const authorizationRef = value(
          await ports.prepareAuthorization(
            { owner: action.owner, request: action.request, input: frozen.input },
            carrier.context,
          ),
        )
        const binding: DeploymentApprovalBinding = {
          ...frozen,
          proposalId: request.proposalId,
          planRevision: request.planRevision,
          planDigest: request.planDigest,
          scope: request.scope,
          tenantId: request.identity.tenantId,
          ...action,
          authorizationRef,
        }
        validateDeploymentBinding(request, binding)
        value(await ports.verify({ request, binding }, context))
        const interaction = installerWire(
          'InteractionRecord',
          value(
            await ports.prepareApproval(
              { owner: action.owner, request: action.request, authorizationRef },
              carrier.context,
            ),
          ),
        )
        if (
          installerDigest(interaction.owner) !== installerDigest(binding.owner) ||
          installerDigest(interaction.request) !== installerDigest(binding.request)
        )
          throw new InstallFault('denied', 'deployment_approval_mismatch')
        return { ok: true, value: { interactionId: interaction.interactionId, binding } }
      } catch (error) {
        return error instanceof InstallFault
          ? installerFailure(error.code, error.detailCode)
          : installerFailure('internal', 'deployment_approval_unavailable')
      }
    },
    read: ports.read ?? unavailable,
    responseStatus: ports.responseStatus ?? unavailable,
    verify: ports.verify ?? unavailable,
    async cancel(input, context) {
      if (!ports.read || !ports.cancelInteraction) return unavailable()
      try {
        const current = value(await ports.read(input, context)).interaction
        if (current.interactionId !== input.interactionId)
          throw new InstallFault('conflict', 'operation_identity_conflict')
        if (current.status !== 'pending') return { ok: true, value: undefined }
        const ended = installerWire(
          'InteractionRecord',
          value(
            await ports.cancelInteraction(
              {
                interactionId: current.interactionId,
                expectedVersion: current.version,
                reason: input.reason,
              },
              context,
            ),
          ),
        )
        if (
          ended.interactionId !== current.interactionId ||
          ended.status !== 'cancelled' ||
          installerDigest(ended.owner) !== installerDigest(current.owner)
        )
          throw new InstallFault('conflict', 'operation_identity_conflict')
        return { ok: true, value: undefined }
      } catch (error) {
        return error instanceof InstallFault
          ? installerFailure(error.code, error.detailCode)
          : installerFailure('internal', 'deployment_approval_unavailable')
      }
    },
  }
}
export function createRefusingDeploymentApprovalPort(): DeploymentApprovalPort {
  return createDeploymentApprovalAdapter({})
}
