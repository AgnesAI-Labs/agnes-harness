import type {
  ApprovalClient,
  ArtifactClient,
  CallContext,
  ClientHello,
  ClientModule,
  ClientWelcome,
  DomainView,
  InteractionClient,
  InteractionRecord,
  JobOccurrence,
  Outcome,
  Page,
  SessionJobsClient,
  WebRendererDefinition,
} from '@agnes/extension-api/client'
import type {
  InteractionClientPendingResult,
  PageInteractionRecord,
  PageJobOccurrence,
  PageSignal,
  SessionJobsClientInspectResult,
  Signal,
} from '@agnes/protocol/runtime'

export function acceptReadonlyInteractions(items: readonly InteractionRecord[]): PageInteractionRecord {
  const page: Page<InteractionRecord> = { items, snapshot: 'snapshot', nextCursor: null, complete: true }
  const result: InteractionClientPendingResult = page
  // @ts-expect-error Page items are readonly.
  result.items.push(items[0])
  // @ts-expect-error Page indices are readonly.
  result.items[0] = items[0]
  return result
}

export function acceptReadonlyJobs(
  items: readonly JobOccurrence[],
  definition: SessionJobsClientInspectResult['definition'],
): SessionJobsClientInspectResult {
  const occurrences: PageJobOccurrence = { items, snapshot: 'snapshot', nextCursor: null, complete: true }
  return { definition, occurrences }
}

export function acceptReadonlySignals(items: readonly Signal[]): PageSignal {
  return { items, snapshot: 'snapshot', nextCursor: null, complete: true }
}

export function readClientPages(interactions: InteractionClient, jobs: SessionJobsClient) {
  const pending: ReturnType<InteractionClient['pending']> = interactions.pending({
    scope: {
      kind: 'workspace',
      installationId: 'installation',
      runtimeId: 'runtime',
      workspaceId: 'workspace',
    },
    limit: 10,
  })
  const inspected: ReturnType<SessionJobsClient['inspect']> = jobs.inspect({
    id: 'job',
    cursor: null,
    limit: 10,
  })
  return { pending, inspected }
}

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T
export type PendingMatches = Assert<
  Equal<Awaited<ReturnType<InteractionClient['pending']>>, Outcome<Page<InteractionRecord>>>
>
export type JobsMatch = Assert<
  Equal<Awaited<ReturnType<SessionJobsClient['inspect']>>, Outcome<SessionJobsClientInspectResult>>
>
export type ClientInputsRemainPublic = [
  ApprovalClient,
  ArtifactClient,
  CallContext,
  ClientHello,
  ClientModule,
  ClientWelcome,
  DomainView,
  WebRendererDefinition,
]

import type {
  // @ts-expect-error Outbox acknowledgments belong to the Runtime API.
  AckOutboxRequest,
  // @ts-expect-error Authority transfer requests belong to the Runtime API.
  AuthorityTransferControlFenceRequest,
  // @ts-expect-error Outbox claim requests belong to the Runtime API.
  ClaimOutboxRequest,
  // @ts-expect-error State maintenance interfaces belong to the Runtime API.
  StateStoreControl,
} from '@agnes/extension-api/client'
export type ForbiddenClientTypes = [
  AckOutboxRequest,
  AuthorityTransferControlFenceRequest,
  ClaimOutboxRequest,
  StateStoreControl,
]

export function preserveMutableFields(
  page: Page<{ label: string }>,
  welcome: ClientWelcome,
  module: ClientModule,
) {
  page.items = [{ label: 'replacement' }]
  const first = page.items[0]
  if (first) first.label = 'updated'
  welcome.modules.push(module)
}
