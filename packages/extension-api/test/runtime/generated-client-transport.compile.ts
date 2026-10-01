// generated from runtime client metadata — do not edit
import type {
  ApprovalClient,
  ArtifactClient,
  ClientTransportClient,
  DomainCommandClient,
  InteractionClient,
  PermissionClient,
  SessionBudgetClient,
  SessionControlClient,
  SessionJobsClient,
  ShellConversationClient,
  ShellDomainClient,
} from '@agnes/extension-api/client'
import type { Outcome } from '@agnes/extension-api/runtime'
import type { ClientOperationTypes } from '@agnes/protocol/runtime'
export async function consumeGeneratedClientSurface(
  clients: {
    ApprovalClient: ApprovalClient
    ArtifactClient: ArtifactClient
    ClientTransportClient: ClientTransportClient
    DomainCommandClient: DomainCommandClient
    InteractionClient: InteractionClient
    PermissionClient: PermissionClient
    SessionBudgetClient: SessionBudgetClient
    SessionControlClient: SessionControlClient
    SessionJobsClient: SessionJobsClient
    ShellConversationClient: ShellConversationClient
    ShellDomainClient: ShellDomainClient
  },
  inputs: { [K in keyof ClientOperationTypes]: ClientOperationTypes[K]['input'] },
): Promise<void> {
  const conversation_create: Outcome<ClientOperationTypes['conversation.create']['output']> =
    await clients.ShellConversationClient.create(inputs['conversation.create'])
  void conversation_create
  const conversation_open: Outcome<ClientOperationTypes['conversation.open']['output']> =
    await clients.ShellConversationClient.open(inputs['conversation.open'])
  void conversation_open
  const conversation_history: Outcome<ClientOperationTypes['conversation.history']['output']> =
    await clients.ShellConversationClient.history(inputs['conversation.history'])
  void conversation_history
  const conversation_submit: Outcome<ClientOperationTypes['conversation.submit']['output']> =
    await clients.ShellConversationClient.submit(inputs['conversation.submit'])
  void conversation_submit
  const conversation_cancel: Outcome<ClientOperationTypes['conversation.cancel']['output']> =
    await clients.ShellConversationClient.cancel(inputs['conversation.cancel'])
  void conversation_cancel
  const conversation_status: Outcome<ClientOperationTypes['conversation.status']['output']> =
    await clients.ShellConversationClient.status(inputs['conversation.status'])
  void conversation_status
  const domain_query: Outcome<ClientOperationTypes['domain.query']['output']> =
    await clients.ShellDomainClient.query(inputs['domain.query'])
  void domain_query
  const domain_submit: Outcome<ClientOperationTypes['domain.submit']['output']> =
    await clients.DomainCommandClient.submit(inputs['domain.submit'])
  void domain_submit
  const domain_commandStatus: Outcome<ClientOperationTypes['domain.commandStatus']['output']> =
    await clients.DomainCommandClient.commandStatus(inputs['domain.commandStatus'])
  void domain_commandStatus
  const control_read: Outcome<ClientOperationTypes['control.read']['output']> =
    await clients.SessionControlClient.read(inputs['control.read'])
  void control_read
  const control_submit: Outcome<ClientOperationTypes['control.submit']['output']> =
    await clients.SessionControlClient.submit(inputs['control.submit'])
  void control_submit
  const control_status: Outcome<ClientOperationTypes['control.status']['output']> =
    await clients.SessionControlClient.status(inputs['control.status'])
  void control_status
  const budget_read: Outcome<ClientOperationTypes['budget.read']['output']> =
    await clients.SessionBudgetClient.read(inputs['budget.read'])
  void budget_read
  const permission_listGrants: Outcome<ClientOperationTypes['permission.listGrants']['output']> =
    await clients.PermissionClient.listGrants(inputs['permission.listGrants'])
  void permission_listGrants
  const permission_revokeGrant: Outcome<ClientOperationTypes['permission.revokeGrant']['output']> =
    await clients.PermissionClient.revokeGrant(inputs['permission.revokeGrant'])
  void permission_revokeGrant
  const jobs_enqueue: Outcome<ClientOperationTypes['jobs.enqueue']['output']> =
    await clients.SessionJobsClient.enqueue(inputs['jobs.enqueue'])
  void jobs_enqueue
  const jobs_poll: Outcome<ClientOperationTypes['jobs.poll']['output']> =
    await clients.SessionJobsClient.poll(inputs['jobs.poll'])
  void jobs_poll
  const jobs_cancel: Outcome<ClientOperationTypes['jobs.cancel']['output']> =
    await clients.SessionJobsClient.cancel(inputs['jobs.cancel'])
  void jobs_cancel
  const jobs_create: Outcome<ClientOperationTypes['jobs.create']['output']> =
    await clients.SessionJobsClient.create(inputs['jobs.create'])
  void jobs_create
  const jobs_update: Outcome<ClientOperationTypes['jobs.update']['output']> =
    await clients.SessionJobsClient.update(inputs['jobs.update'])
  void jobs_update
  const jobs_inspect: Outcome<ClientOperationTypes['jobs.inspect']['output']> =
    await clients.SessionJobsClient.inspect(inputs['jobs.inspect'])
  void jobs_inspect
  const jobs_cancelDefinition: Outcome<ClientOperationTypes['jobs.cancelDefinition']['output']> =
    await clients.SessionJobsClient.cancelDefinition(inputs['jobs.cancelDefinition'])
  void jobs_cancelDefinition
  const jobs_commandStatus: Outcome<ClientOperationTypes['jobs.commandStatus']['output']> =
    await clients.SessionJobsClient.commandStatus(inputs['jobs.commandStatus'])
  void jobs_commandStatus
  const interaction_pending: Outcome<ClientOperationTypes['interaction.pending']['output']> =
    await clients.InteractionClient.pending(inputs['interaction.pending'])
  void interaction_pending
  const interaction_read: Outcome<ClientOperationTypes['interaction.read']['output']> =
    await clients.InteractionClient.read(inputs['interaction.read'])
  void interaction_read
  const interaction_respond: Outcome<ClientOperationTypes['interaction.respond']['output']> =
    await clients.InteractionClient.respond(inputs['interaction.respond'])
  void interaction_respond
  const interaction_formLink: Outcome<ClientOperationTypes['interaction.formLink']['output']> =
    await clients.InteractionClient.formLink(
      inputs['interaction.formLink'].interactionId,
      inputs['interaction.formLink'].expectedVersion,
    )
  void interaction_formLink
  const interaction_responseStatus: Outcome<ClientOperationTypes['interaction.responseStatus']['output']> =
    await clients.InteractionClient.responseStatus(inputs['interaction.responseStatus'])
  void interaction_responseStatus
  const approval_read: Outcome<ClientOperationTypes['approval.read']['output']> =
    await clients.ApprovalClient.read(inputs['approval.read'])
  void approval_read
  const approval_respond: Outcome<ClientOperationTypes['approval.respond']['output']> =
    await clients.ApprovalClient.respond(inputs['approval.respond'])
  void approval_respond
  const approval_formLink: Outcome<ClientOperationTypes['approval.formLink']['output']> =
    await clients.ApprovalClient.formLink(
      inputs['approval.formLink'].interactionId,
      inputs['approval.formLink'].expectedVersion,
    )
  void approval_formLink
  const approval_responseStatus: Outcome<ClientOperationTypes['approval.responseStatus']['output']> =
    await clients.ApprovalClient.responseStatus(inputs['approval.responseStatus'])
  void approval_responseStatus
  const artifact_describe: Outcome<ClientOperationTypes['artifact.describe']['output']> =
    await clients.ArtifactClient.describe(
      inputs['artifact.describe'].artifactId,
      inputs['artifact.describe'].version,
    )
  void artifact_describe
  const artifact_openDownload: Outcome<ClientOperationTypes['artifact.openDownload']['output']> =
    await clients.ArtifactClient.openDownload(inputs['artifact.openDownload'])
  void artifact_openDownload
  const transport_catalogStatus: Outcome<ClientOperationTypes['transport.catalogStatus']['output']> =
    await clients.ClientTransportClient.catalogStatus(inputs['transport.catalogStatus'])
  void transport_catalogStatus
  const transport_streamStatus: Outcome<ClientOperationTypes['transport.streamStatus']['output']> =
    await clients.ClientTransportClient.streamStatus(inputs['transport.streamStatus'])
  void transport_streamStatus
  const conversation_list: Outcome<ClientOperationTypes['conversation.list']['output']> =
    await clients.ShellConversationClient.list(inputs['conversation.list'])
  void conversation_list
}
