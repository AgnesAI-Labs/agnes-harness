import type {
  ApprovalAnswer,
  ApprovalClient,
  CommandHandle,
  ConversationListRequest,
  DomainCommandClient,
  DomainCommandClientSubmitRequest,
  DomainViewChange,
  InteractionRecord,
  InteractionResponseStatus,
  PageConversationSummary,
  ProjectionChange,
  ShellConversationClient,
} from '@agnes/extension-api/client'
import type { BoundService, CallContext, EventsOutboxControl, Outcome } from '@agnes/extension-api/runtime'
import type {
  InboxRecord,
  OutboxRedriveRequest,
  OutboxRedriveResult,
  PageOutboxDeadLetterItem,
} from '@agnes/protocol/runtime'

const approve: ApprovalAnswer = { decision: 'approve', intentDigest: 'a'.repeat(64), grantScope: 'once' }
const deny: ApprovalAnswer = { decision: 'deny', intentDigest: 'a'.repeat(64) }
// @ts-expect-error deny carries no grant
const denyWithGrant: ApprovalAnswer = { decision: 'deny', intentDigest: 'a'.repeat(64), grantScope: 'once' }
// @ts-expect-error persisted approve must fix a scope
const approveWithoutScope: ApprovalAnswer = { decision: 'approve', intentDigest: 'a'.repeat(64) }
void [approve, deny, denyWithGrant, approveWithoutScope]

const notAccepted: CommandHandle = {
  requestId: 'request',
  status: 'not-accepted',
  commandId: null,
  revision: null,
  completion: null,
  result: null,
  error: null,
}
const noResponse: InteractionResponseStatus = {
  responseId: 'response',
  status: 'not-accepted',
  interactionId: null,
  version: null,
  result: null,
  error: null,
}
// @ts-expect-error absence cannot create a command identity
const inventedCommand: CommandHandle = {
  requestId: 'request',
  status: 'not-accepted',
  commandId: 'made-up',
  revision: null,
  completion: null,
  result: null,
  error: null,
}
// @ts-expect-error accepted commands must state their completion contract
const missingCompletion: CommandHandle = {
  requestId: 'request',
  status: 'accepted',
  commandId: 'command',
  revision: 1,
  result: null,
  error: null,
}
void [notAccepted, noResponse, inventedCommand, missingCompletion]

export function renderOriginalStatus(handle: CommandHandle): string {
  if (handle.status === 'not-accepted') {
    const identity: null = handle.commandId
    const revision: null = handle.revision
    const completion: null = handle.completion
    void [identity, revision, completion]
    return 'not-accepted'
  }
  return `${handle.commandId}:${handle.completion}`
}

export function legacyChangeAlias(change: ProjectionChange): DomainViewChange {
  return change
}
export function terminalAnswer(record: InteractionRecord): void {
  if (record.status === 'pending') {
    const absent: null = record.resolution
    void absent
  }
  if (record.status === 'answered') {
    const responseId: string = record.resolution.responseId
    void responseId
  }
}

export async function consumeOwnerAndClients(
  owner: BoundService,
  context: CallContext,
  clients: { conversation: ShellConversationClient; approval: ApprovalClient; domain: DomainCommandClient },
  list: ConversationListRequest,
  command: DomainCommandClientSubmitRequest,
  redrive: OutboxRedriveRequest,
): Promise<void> {
  const page: Outcome<PageConversationSummary> = await clients.conversation.list(list)
  const outcome: Outcome<CommandHandle> = await clients.domain.submit(command)
  const response: Outcome<InteractionResponseStatus> = await clients.approval.respond({
    interactionId: 'interaction',
    responseId: 'response',
    expectedVersion: 1,
    decision: 'deny',
    intentDigest: 'a'.repeat(64),
  })
  void [page, outcome, response]
  if (owner.eventsOutbox) {
    const port: EventsOutboxControl = owner.eventsOutbox
    const dead: Outcome<PageOutboxDeadLetterItem> = await port.deadLetters(
      { scope: context.scope, destination: null, cursor: null, limit: 20 },
      context,
    )
    const repaired: Outcome<OutboxRedriveResult> = await port.redriveOutbox(redrive, context)
    void [dead, repaired]
    // @ts-expect-error owner control requires the real CallContext
    await port.redriveOutbox(redrive)
    await port.redriveOutbox(
      {
        requestId: 'request',
        scope: context.scope,
        // @ts-expect-error preserve the full source authority, event and destination delivery key
        eventId: 'event',
        expectedDeliveryRevision: 1,
        reason: 'repair',
      },
      context,
    )
  }
}

export function requireTargetSequence(inbox: InboxRecord): number {
  return inbox.inboxSeq
}
// @ts-expect-error commandSchema is part of the exact command address contract
const missingCommandSchema: DomainCommandClientSubmitRequest = {
  action: { viewId: 'view', actionKey: 'save', viewRevision: 1 },
  input: {
    kind: 'inline',
    schema: { typeId: 'demo/input@1', revision: 1, digest: 'a'.repeat(64) },
    value: null,
    digest: 'a'.repeat(64),
    bytes: 4,
  },
  requestId: 'request',
  expectedRevision: 1,
}
void missingCommandSchema
