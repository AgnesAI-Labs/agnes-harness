// generated from runtime client metadata — do not edit
import type * as Wire from './runtime-public.js'
function freeze<T>(value: T): T { if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) } return value }
export const RuntimeClientOperations = freeze({
  "conversation.create": {
    "localInterface": "ShellConversationClient",
    "localMethod": "create",
    "kind": "command",
    "input": "ShellConversationClientCreateRequest",
    "output": "ShellConversationClientCreateResult",
    "backendContract": "agh.supervisor",
    "backendMethod": "createConversation",
    "backendKind": "control",
    "requiredFeature": "client-transport.v1",
    "identityField": "requestId",
    "statusOperation": "conversation.status"
  },
  "conversation.open": {
    "localInterface": "ShellConversationClient",
    "localMethod": "open",
    "kind": "query",
    "input": "ShellConversationClientOpenRequest",
    "output": "RuntimeConversationWindow",
    "backendContract": "agh.projection",
    "backendMethod": "openConversation",
    "backendKind": "query",
    "requiredFeature": "client-transport.v1"
  },
  "conversation.history": {
    "localInterface": "ShellConversationClient",
    "localMethod": "history",
    "kind": "query",
    "input": "ShellConversationClientHistoryRequest",
    "output": "RuntimeConversationWindow",
    "backendContract": "agh.projection",
    "backendMethod": "conversationHistory",
    "backendKind": "query",
    "requiredFeature": "client-transport.v1"
  },
  "conversation.submit": {
    "localInterface": "ShellConversationClient",
    "localMethod": "submit",
    "kind": "command",
    "input": "ShellConversationClientSubmitRequest",
    "output": "CommandHandle",
    "backendContract": "agh.supervisor",
    "backendMethod": "submitConversation",
    "backendKind": "control",
    "requiredFeature": "client-transport.v1",
    "identityField": "requestId",
    "statusOperation": "conversation.status"
  },
  "conversation.cancel": {
    "localInterface": "ShellConversationClient",
    "localMethod": "cancel",
    "kind": "command",
    "input": "ShellConversationClientCancelRequest",
    "output": "CommandHandle",
    "backendContract": "agh.supervisor",
    "backendMethod": "cancelConversation",
    "backendKind": "control",
    "requiredFeature": "client-transport.v1",
    "identityField": "requestId",
    "statusOperation": "conversation.status"
  },
  "conversation.status": {
    "localInterface": "ShellConversationClient",
    "localMethod": "status",
    "kind": "query",
    "input": "ShellConversationClientStatusRequest",
    "output": "CommandHandle",
    "backendContract": "agh.supervisor",
    "backendMethod": "conversationCommandStatus",
    "backendKind": "query",
    "requiredFeature": "client-transport.v1"
  },
  "domain.query": {
    "localInterface": "ShellDomainClient",
    "localMethod": "query",
    "kind": "query",
    "input": "DomainQuery",
    "output": "ProjectionSnapshot",
    "backendContract": "agh.projection",
    "backendMethod": "snapshot",
    "backendKind": "query",
    "requiredFeature": "client-transport.v1"
  },
  "domain.submit": {
    "localInterface": "DomainCommandClient",
    "localMethod": "submit",
    "kind": "command",
    "input": "DomainCommandClientSubmitRequest",
    "output": "CommandHandle",
    "backendContract": "agh.projection",
    "backendMethod": "acceptCommand",
    "backendKind": "control",
    "requiredFeature": "client-transport.v1",
    "backendInput": "DomainCommandRequest",
    "hostFields": [
      "negotiatedSession",
      "clientInstanceId",
      "catalogRevision",
      "ownerToken"
    ],
    "transform": "domain-command",
    "identityField": "requestId",
    "statusOperation": "domain.commandStatus"
  },
  "domain.commandStatus": {
    "localInterface": "DomainCommandClient",
    "localMethod": "commandStatus",
    "kind": "query",
    "input": "DomainCommandClientCommandStatusRequest",
    "output": "CommandHandle",
    "backendContract": "agh.projection",
    "backendMethod": "commandStatus",
    "backendKind": "query",
    "requiredFeature": "client-transport.v1"
  },
  "control.read": {
    "localInterface": "SessionControlClient",
    "localMethod": "read",
    "kind": "query",
    "input": "Id",
    "output": "SessionControlState",
    "backendContract": "agh.supervisor",
    "backendMethod": "readSessionControl",
    "backendKind": "query",
    "requiredFeature": "client-transport.v1"
  },
  "control.submit": {
    "localInterface": "SessionControlClient",
    "localMethod": "submit",
    "kind": "command",
    "input": "SessionControlRequest",
    "output": "SessionControlResult",
    "backendContract": "agh.supervisor",
    "backendMethod": "submitSessionControl",
    "backendKind": "control",
    "requiredFeature": "client-transport.v1",
    "identityField": "requestId",
    "statusOperation": "control.status"
  },
  "control.status": {
    "localInterface": "SessionControlClient",
    "localMethod": "status",
    "kind": "query",
    "input": "SessionControlClientStatusRequest",
    "output": "SessionControlResult",
    "backendContract": "agh.supervisor",
    "backendMethod": "sessionControlStatus",
    "backendKind": "query",
    "requiredFeature": "client-transport.v1"
  },
  "budget.read": {
    "localInterface": "SessionBudgetClient",
    "localMethod": "read",
    "kind": "query",
    "input": "SessionBudgetClientReadRequest",
    "output": "SessionBudgetResult",
    "backendContract": "agh.budget",
    "backendMethod": "readSessionBudget",
    "backendKind": "query",
    "requiredFeature": "client-transport.v1"
  },
  "permission.listGrants": {
    "localInterface": "PermissionClient",
    "localMethod": "listGrants",
    "kind": "query",
    "input": "ApprovalGrantBindingInput",
    "output": "ApprovalGrantListResult",
    "backendContract": "agh.policy",
    "backendMethod": "listGrants",
    "backendKind": "query",
    "requiredFeature": "client-transport.v1"
  },
  "permission.revokeGrant": {
    "localInterface": "PermissionClient",
    "localMethod": "revokeGrant",
    "kind": "command",
    "input": "PermissionClientRevokeGrantRequest",
    "output": "ApprovalGrantRecord",
    "backendContract": "agh.policy",
    "backendMethod": "revokeGrant",
    "backendKind": "control",
    "requiredFeature": "client-transport.v1",
    "identityField": "requestId"
  },
  "jobs.enqueue": {
    "localInterface": "SessionJobsClient",
    "localMethod": "enqueue",
    "kind": "command",
    "input": "SessionJobsClientEnqueueRequest",
    "output": "SessionJobsClientEnqueueResult",
    "backendContract": "agh.jobs",
    "backendMethod": "enqueueClientJob",
    "backendKind": "control",
    "requiredFeature": "client-transport.v1",
    "identityField": "requestId"
  },
  "jobs.poll": {
    "localInterface": "SessionJobsClient",
    "localMethod": "poll",
    "kind": "query",
    "input": "SessionJobsClientPollRequest",
    "output": "JobStatus",
    "backendContract": "agh.jobs",
    "backendMethod": "pollClientJob",
    "backendKind": "query",
    "requiredFeature": "client-transport.v1"
  },
  "jobs.cancel": {
    "localInterface": "SessionJobsClient",
    "localMethod": "cancel",
    "kind": "command",
    "input": "SessionJobsClientCancelRequest",
    "output": "SessionJobsClientCancelResult",
    "backendContract": "agh.jobs",
    "backendMethod": "cancelClientJob",
    "backendKind": "control",
    "requiredFeature": "client-transport.v1",
    "identityField": "requestId"
  },
  "jobs.create": {
    "localInterface": "SessionJobsClient",
    "localMethod": "create",
    "kind": "command",
    "input": "SessionJobsClientCreateRequest",
    "output": "CommandHandle",
    "backendContract": "agh.jobs",
    "backendMethod": "acceptCreateDefinition",
    "backendKind": "control",
    "requiredFeature": "client-transport.v1",
    "identityField": "requestId",
    "statusOperation": "jobs.commandStatus"
  },
  "jobs.update": {
    "localInterface": "SessionJobsClient",
    "localMethod": "update",
    "kind": "command",
    "input": "SessionJobsClientUpdateRequest",
    "output": "CommandHandle",
    "backendContract": "agh.jobs",
    "backendMethod": "acceptUpdateDefinition",
    "backendKind": "control",
    "requiredFeature": "client-transport.v1",
    "identityField": "requestId",
    "statusOperation": "jobs.commandStatus"
  },
  "jobs.inspect": {
    "localInterface": "SessionJobsClient",
    "localMethod": "inspect",
    "kind": "query",
    "input": "SessionJobsClientInspectRequest",
    "output": "SessionJobsClientInspectResult",
    "backendContract": "agh.jobs",
    "backendMethod": "inspect",
    "backendKind": "query",
    "requiredFeature": "client-transport.v1",
    "backendInput": "JobsInspectRequest",
    "backendOutput": "JobsInspectResult",
    "transform": "equivalent-payload"
  },
  "jobs.cancelDefinition": {
    "localInterface": "SessionJobsClient",
    "localMethod": "cancelDefinition",
    "kind": "command",
    "input": "SessionJobsClientCancelDefinitionRequest",
    "output": "CommandHandle",
    "backendContract": "agh.jobs",
    "backendMethod": "acceptCancelDefinition",
    "backendKind": "control",
    "requiredFeature": "client-transport.v1",
    "identityField": "requestId",
    "statusOperation": "jobs.commandStatus"
  },
  "jobs.commandStatus": {
    "localInterface": "SessionJobsClient",
    "localMethod": "commandStatus",
    "kind": "query",
    "input": "Id",
    "output": "CommandHandle",
    "backendContract": "agh.jobs",
    "backendMethod": "clientCommandStatus",
    "backendKind": "query",
    "requiredFeature": "client-transport.v1"
  },
  "interaction.pending": {
    "localInterface": "InteractionClient",
    "localMethod": "pending",
    "kind": "query",
    "input": "InteractionClientPendingRequest",
    "output": "InteractionClientPendingResult",
    "backendContract": "agh.interaction",
    "backendMethod": "pending",
    "backendKind": "query",
    "requiredFeature": "client-transport.v1"
  },
  "interaction.read": {
    "localInterface": "InteractionClient",
    "localMethod": "read",
    "kind": "query",
    "input": "Id",
    "output": "InteractionRecord",
    "backendContract": "agh.interaction",
    "backendMethod": "read",
    "backendKind": "query",
    "requiredFeature": "client-transport.v1"
  },
  "interaction.respond": {
    "localInterface": "InteractionClient",
    "localMethod": "respond",
    "kind": "command",
    "input": "InteractionClientRespondRequest",
    "output": "InteractionResponseStatus",
    "backendContract": "agh.interaction",
    "backendMethod": "acceptResponse",
    "backendKind": "control",
    "requiredFeature": "client-transport.v1",
    "expectedInteractionKind": "question",
    "identityField": "responseId",
    "statusOperation": "interaction.responseStatus"
  },
  "interaction.formLink": {
    "localInterface": "InteractionClient",
    "localMethod": "formLink",
    "kind": "command",
    "input": "ClientInteractionFormLinkInput",
    "output": "InteractionFormLink",
    "backendContract": "agh.interaction",
    "backendMethod": "formLink",
    "backendKind": "control",
    "requiredFeature": "client-transport.v1",
    "backendInput": "InteractionFormLinkRequest",
    "wrapField": "input",
    "hostFields": [
      "requestId"
    ]
  },
  "interaction.responseStatus": {
    "localInterface": "InteractionClient",
    "localMethod": "responseStatus",
    "kind": "query",
    "input": "Id",
    "output": "InteractionResponseStatus",
    "backendContract": "agh.interaction",
    "backendMethod": "responseStatus",
    "backendKind": "query",
    "requiredFeature": "client-transport.v1"
  },
  "approval.read": {
    "localInterface": "ApprovalClient",
    "localMethod": "read",
    "kind": "query",
    "input": "Id",
    "output": "InteractionRecord",
    "backendContract": "agh.interaction",
    "backendMethod": "read",
    "backendKind": "query",
    "requiredFeature": "client-transport.v1",
    "expectedInteractionKind": "approval"
  },
  "approval.respond": {
    "localInterface": "ApprovalClient",
    "localMethod": "respond",
    "kind": "command",
    "input": "ApprovalRespondRequest",
    "output": "InteractionResponseStatus",
    "backendContract": "agh.interaction",
    "backendMethod": "respondApproval",
    "backendKind": "control",
    "requiredFeature": "client-transport.v1",
    "expectedInteractionKind": "approval",
    "identityField": "responseId",
    "statusOperation": "approval.responseStatus"
  },
  "approval.formLink": {
    "localInterface": "ApprovalClient",
    "localMethod": "formLink",
    "kind": "command",
    "input": "ClientInteractionFormLinkInput",
    "output": "InteractionFormLink",
    "backendContract": "agh.interaction",
    "backendMethod": "formLink",
    "backendKind": "control",
    "requiredFeature": "client-transport.v1",
    "backendInput": "InteractionFormLinkRequest",
    "wrapField": "input",
    "hostFields": [
      "requestId"
    ],
    "expectedInteractionKind": "approval"
  },
  "approval.responseStatus": {
    "localInterface": "ApprovalClient",
    "localMethod": "responseStatus",
    "kind": "query",
    "input": "Id",
    "output": "InteractionResponseStatus",
    "backendContract": "agh.interaction",
    "backendMethod": "responseStatus",
    "backendKind": "query",
    "requiredFeature": "client-transport.v1",
    "expectedInteractionKind": "approval"
  },
  "artifact.describe": {
    "localInterface": "ArtifactClient",
    "localMethod": "describe",
    "kind": "query",
    "input": "ArtifactDescribeInput",
    "output": "ArtifactViewRef",
    "backendContract": "agh.artifacts",
    "backendMethod": "describe",
    "backendKind": "query",
    "requiredFeature": "client-transport.v1",
    "backendLocalInterface": "ArtifactAccessPort",
    "requiredBackendFeature": "artifact-access.v1"
  },
  "artifact.openDownload": {
    "localInterface": "ArtifactClient",
    "localMethod": "openDownload",
    "kind": "command",
    "input": "ArtifactClientOpenDownloadRequest",
    "output": "ArtifactDownloadTicket",
    "backendContract": "agh.artifacts",
    "backendMethod": "openDownload",
    "backendKind": "control",
    "requiredFeature": "client-transport.v1",
    "backendLocalInterface": "ArtifactAccessPort",
    "requiredBackendFeature": "artifact-access.v1",
    "backendInput": "ArtifactOpenDownloadRequest",
    "wrapField": "input",
    "hostFields": [
      "requestId"
    ]
  },
  "artifact.readRange": {
    "localInterface": "ArtifactClient",
    "localMethod": "readRange",
    "kind": "binary",
    "input": "ArtifactClientReadRangeRequest",
    "output": "ByteRangeResult",
    "backendContract": "agh.artifacts",
    "backendMethod": "readRange",
    "backendKind": "query",
    "backendLocalInterface": "ArtifactAccessPort",
    "requiredFeature": "client-transport.v1",
    "requiredBackendFeature": "artifact-access.v1"
  },
  "artifact.openStream": {
    "localInterface": "ArtifactClient",
    "localMethod": "openStream",
    "kind": "binary",
    "input": "ArtifactClientOpenStreamRequest",
    "output": "ByteReadStream",
    "backendContract": "agh.artifacts",
    "backendMethod": "openStream",
    "backendKind": "query",
    "backendLocalInterface": "ArtifactAccessPort",
    "requiredFeature": "client-transport.v1",
    "requiredBackendFeature": "artifact-access.v1"
  },
  "artifact.followDownload": {
    "localInterface": "ArtifactClient",
    "localMethod": "followDownload",
    "kind": "local",
    "input": "ArtifactDownloadTicket",
    "output": "void"
  }
} as const)
export const RuntimeClientTransportPolicy = freeze({
  "maxBootstrapRejectedBytes": 65536,
  "maxBootstrapMessageUtf8Bytes": 1024,
  "maxSupportedProtocols": 16,
  "defaultCatalogPageLimit": 100,
  "maxCatalogPageLimit": 128,
  "maxJsonBytes": 1048576,
  "maxReaderQueueBytes": 4194304,
  "maxReaderQueueFrames": 256,
  "readerIdleTimeoutMs": 30000,
  "maxRangeBytes": 1048576,
  "maxArtifactBytes": 1073741824,
  "downloadTicketTtlMs": 300000,
  "eof": "clamp"
} as const)
export interface ClientOperationTypes {
  'conversation.create': { input: Wire.ShellConversationClientCreateRequest; output: Wire.ShellConversationClientCreateResult }
  'conversation.open': { input: Wire.ShellConversationClientOpenRequest; output: Wire.RuntimeConversationWindow }
  'conversation.history': { input: Wire.ShellConversationClientHistoryRequest; output: Wire.RuntimeConversationWindow }
  'conversation.submit': { input: Wire.ShellConversationClientSubmitRequest; output: Wire.CommandHandle }
  'conversation.cancel': { input: Wire.ShellConversationClientCancelRequest; output: Wire.CommandHandle }
  'conversation.status': { input: Wire.ShellConversationClientStatusRequest; output: Wire.CommandHandle }
  'domain.query': { input: Wire.DomainQuery; output: Wire.ProjectionSnapshot }
  'domain.submit': { input: Wire.DomainCommandClientSubmitRequest; output: Wire.CommandHandle }
  'domain.commandStatus': { input: Wire.DomainCommandClientCommandStatusRequest; output: Wire.CommandHandle }
  'control.read': { input: Wire.Id; output: Wire.SessionControlState }
  'control.submit': { input: Wire.SessionControlRequest; output: Wire.SessionControlResult }
  'control.status': { input: Wire.SessionControlClientStatusRequest; output: Wire.SessionControlResult }
  'budget.read': { input: Wire.SessionBudgetClientReadRequest; output: Wire.SessionBudgetResult }
  'permission.listGrants': { input: Wire.ApprovalGrantBindingInput; output: Wire.ApprovalGrantListResult }
  'permission.revokeGrant': { input: Wire.PermissionClientRevokeGrantRequest; output: Wire.ApprovalGrantRecord }
  'jobs.enqueue': { input: Wire.SessionJobsClientEnqueueRequest; output: Wire.SessionJobsClientEnqueueResult }
  'jobs.poll': { input: Wire.SessionJobsClientPollRequest; output: Wire.JobStatus }
  'jobs.cancel': { input: Wire.SessionJobsClientCancelRequest; output: Wire.SessionJobsClientCancelResult }
  'jobs.create': { input: Wire.SessionJobsClientCreateRequest; output: Wire.CommandHandle }
  'jobs.update': { input: Wire.SessionJobsClientUpdateRequest; output: Wire.CommandHandle }
  'jobs.inspect': { input: Wire.SessionJobsClientInspectRequest; output: Wire.SessionJobsClientInspectResult }
  'jobs.cancelDefinition': { input: Wire.SessionJobsClientCancelDefinitionRequest; output: Wire.CommandHandle }
  'jobs.commandStatus': { input: Wire.Id; output: Wire.CommandHandle }
  'interaction.pending': { input: Wire.InteractionClientPendingRequest; output: Wire.InteractionClientPendingResult }
  'interaction.read': { input: Wire.Id; output: Wire.InteractionRecord }
  'interaction.respond': { input: Wire.InteractionClientRespondRequest; output: Wire.InteractionResponseStatus }
  'interaction.formLink': { input: Wire.ClientInteractionFormLinkInput; output: Wire.InteractionFormLink }
  'interaction.responseStatus': { input: Wire.Id; output: Wire.InteractionResponseStatus }
  'approval.read': { input: Wire.Id; output: Wire.InteractionRecord }
  'approval.respond': { input: Wire.ApprovalRespondRequest; output: Wire.InteractionResponseStatus }
  'approval.formLink': { input: Wire.ClientInteractionFormLinkInput; output: Wire.InteractionFormLink }
  'approval.responseStatus': { input: Wire.Id; output: Wire.InteractionResponseStatus }
  'artifact.describe': { input: Wire.ArtifactDescribeInput; output: Wire.ArtifactViewRef }
  'artifact.openDownload': { input: Wire.ArtifactClientOpenDownloadRequest; output: Wire.ArtifactDownloadTicket }
}
export type ClientJsonOperation = keyof ClientOperationTypes
