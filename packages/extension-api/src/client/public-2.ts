// generated from schema/runtime by tools/gen-runtime.ts — do not edit
import type * as Wire from '@agnes/protocol/runtime'
import type { Outcome } from '../runtime/public-api.js'

export interface ShellConversationClient {
  create(
    input: Wire.ShellConversationClientCreateRequest,
  ): Promise<Outcome<Wire.ShellConversationClientCreateResult>>
  open(input: Wire.ShellConversationClientOpenRequest): Promise<Outcome<Wire.RuntimeConversationWindow>>
  history(input: Wire.ShellConversationClientHistoryRequest): Promise<Outcome<Wire.RuntimeConversationWindow>>
  submit(input: Wire.ShellConversationClientSubmitRequest): Promise<Outcome<Wire.CommandHandle>>
  cancel(input: Wire.ShellConversationClientCancelRequest): Promise<Outcome<Wire.CommandHandle>>
  status(requestId: Wire.ShellConversationClientStatusRequest): Promise<Outcome<Wire.CommandHandle>>
}

export interface ShellDomainClient {
  query(input: Wire.DomainQuery): Promise<Outcome<Wire.ProjectionSnapshot>>
}

export interface SessionControlClient {
  read(sessionId: Wire.Id): Promise<Outcome<Wire.SessionControlState>>
  submit(request: Wire.SessionControlRequest): Promise<Outcome<Wire.SessionControlResult>>
  status(input: Wire.SessionControlClientStatusRequest): Promise<Outcome<Wire.SessionControlResult>>
}

export interface SessionBudgetClient {
  read(input: Wire.SessionBudgetClientReadRequest): Promise<Outcome<Wire.SessionBudgetResult>>
}

export interface PermissionClient {
  listGrants(input: Wire.ApprovalGrantBindingInput): Promise<Outcome<Wire.ApprovalGrantListResult>>
  revokeGrant(input: Wire.PermissionClientRevokeGrantRequest): Promise<Outcome<Wire.ApprovalGrantRecord>>
}

export interface SessionJobsClient {
  enqueue(input: Wire.SessionJobsClientEnqueueRequest): Promise<Outcome<Wire.SessionJobsClientEnqueueResult>>
  poll(input: Wire.SessionJobsClientPollRequest): Promise<Outcome<Wire.JobStatus>>
  cancel(input: Wire.SessionJobsClientCancelRequest): Promise<Outcome<Wire.SessionJobsClientCancelResult>>
  create(input: Wire.SessionJobsClientCreateRequest): Promise<Outcome<Wire.CommandHandle>>
  update(input: Wire.SessionJobsClientUpdateRequest): Promise<Outcome<Wire.CommandHandle>>
  inspect(input: Wire.SessionJobsClientInspectRequest): Promise<Outcome<Wire.SessionJobsClientInspectResult>>
  cancelDefinition(input: Wire.SessionJobsClientCancelDefinitionRequest): Promise<Outcome<Wire.CommandHandle>>
  commandStatus(requestId: Wire.Id): Promise<Outcome<Wire.CommandHandle>>
}

export interface InteractionClient {
  pending(
    request: Wire.InteractionClientPendingRequest,
  ): Promise<Outcome<Wire.InteractionClientPendingResult>>
  read(interactionId: Wire.Id): Promise<Outcome<Wire.InteractionRecord>>
  respond(request: Wire.InteractionClientRespondRequest): Promise<Outcome<Wire.InteractionResponseStatus>>
  formLink(interactionId: Wire.Id, expectedVersion: Wire.UInt53): Promise<Outcome<Wire.InteractionFormLink>>
  responseStatus(responseId: Wire.Id): Promise<Outcome<Wire.InteractionResponseStatus>>
}

export interface ApprovalClient {
  read(interactionId: Wire.Id): Promise<Outcome<Wire.InteractionRecord>>
  respond(request: Wire.ApprovalRespondRequest): Promise<Outcome<Wire.InteractionResponseStatus>>
  formLink(interactionId: Wire.Id, expectedVersion: Wire.UInt53): Promise<Outcome<Wire.InteractionFormLink>>
  responseStatus(responseId: Wire.Id): Promise<Outcome<Wire.InteractionResponseStatus>>
}

export interface ArtifactReadStream {
  readonly chunks: AsyncIterable<Uint8Array>
  readonly ended: Promise<Outcome<Wire.ArtifactReadStreamEndResult>>
  cancel(reason: string): Promise<void>
  close(): Promise<void>
}

export interface ArtifactClient {
  describe(artifactId: Wire.Id, version: Wire.UInt53): Promise<Outcome<Wire.ArtifactViewRef>>
  openDownload(request: Wire.ArtifactClientOpenDownloadRequest): Promise<Outcome<Wire.ArtifactDownloadTicket>>
  readRange(request: {
    artifactId: Wire.Id
    version: Wire.UInt53
    offset: Wire.UInt53
    length: Wire.UInt53
  }): Promise<
    Outcome<{
      bytes: Uint8Array
      offset: Wire.UInt53
      totalBytes: Wire.UInt53
      digest: Wire.Digest
    }>
  >
  openStream(request: {
    artifactId: Wire.Id
    version: Wire.UInt53
    offset?: Wire.UInt53
  }): Promise<Outcome<ArtifactReadStream>>
  followDownload(ticket: Wire.ArtifactDownloadTicket): Outcome<void>
}

export type DomainView<T = Wire.JsonValue> = Omit<Wire.DomainView, 'data'> & { data: T }
