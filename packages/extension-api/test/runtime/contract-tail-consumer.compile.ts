import type { ClientInteractionFormLinkInput } from '@agnes/extension-api/client'
import type {
  ApprovalRespondRequest,
  AuthorityTransferControl,
  CallContext,
  ConfigResolveRequest,
  ConfigResolveResult,
  InteractionAdmissionControl,
  InteractionClientRespondRequest,
  InteractionFormLinkRequest,
  Outcome,
} from '@agnes/extension-api/runtime'
import {
  RuntimeAuthorityTransferAPI,
  RuntimeMethodSchemaRefs,
  RuntimeServiceCatalog,
  validateRuntime,
} from '@agnes/protocol/runtime'

export function useControl(
  control: InteractionAdmissionControl,
  context: CallContext,
  answer: InteractionClientRespondRequest,
  approval: ApprovalRespondRequest,
  input: ClientInteractionFormLinkInput,
) {
  const request: InteractionFormLinkRequest = { requestId: 'host-issued', input }
  return [
    control.acceptResponse(answer, context),
    control.respondApproval(approval, context),
    control.formLink(request, context),
  ]
}
export function inspectConfiguration(input: ConfigResolveRequest, result: ConfigResolveResult) {
  const candidate: 'candidate' = result.status
  const parsed = validateRuntime('ConfigResolveRequest', input)
  // @ts-expect-error A candidate does not publish a trusted configuration.
  const published: 'published' = result.status
  return { parsed, candidate, published }
}
export function useOptionalMaintenance(
  control: AuthorityTransferControl,
  context: CallContext,
  request: Parameters<AuthorityTransferControl['probe']>[0],
) {
  const result: Promise<
    Outcome<Awaited<ReturnType<typeof control.probe>> extends Outcome<infer T> ? T : never>
  > = control.probe(request, context)
  const feature: 'authority-transfer.v1' =
    RuntimeServiceCatalog['agh.state'].methods.authorityProbe.requiredFeature
  const broker: false = RuntimeServiceCatalog['agh.state'].methods.authorityProbe.sameAttemptBrokerAllowed
  const identity: 'agh.state/authorityProbe.request@1' =
    RuntimeMethodSchemaRefs['agh.state'].authorityProbe.input.typeId
  return { result, feature, broker, identity, eligible: RuntimeAuthorityTransferAPI.contracts }
}
