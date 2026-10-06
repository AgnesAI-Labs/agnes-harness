// The runtime client's local interfaces over one transport: conversations, domain views and commands,
// session controls, budget, permissions, jobs, interactions, approvals, artifacts and the transport's
// own status. Each method is the generated operation its interface and method name map to; nothing
// here restates the operation table. Results keep the transport's four states, so an operation the
// backend does not serve arrives as its typed `operation_not_supported` failure, a lost reply stays
// `unknown`, and nothing is resent.
import {
  type ClientJsonOperation,
  type ClientOperationTypes,
  RuntimeClientOperations,
} from '@agnes/protocol/runtime'
import { type ArtifactClientOptions, artifactClient } from './artifacts.js'
import { subscriptions } from './client-subscriptions.js'
import type { CallResult, RuntimeClientTransport } from './client-transport.js'

type Operations = typeof RuntimeClientOperations
export type LocalInterface = Operations[ClientJsonOperation]['localInterface']
/** Transport status queries carry the call header, which the transport fills in. */
type Input<K extends ClientJsonOperation> = Operations[K]['backendContract'] extends 'agh.transport'
  ? Omit<ClientOperationTypes[K]['input'], 'header'>
  : ClientOperationTypes[K]['input']
/** The JSON methods of one generated local interface, by their generated method names. */
export type LocalClient<I extends LocalInterface> = {
  readonly [K in ClientJsonOperation as Operations[K]['localInterface'] extends I
    ? Operations[K]['localMethod']
    : never]: (
    input: Input<K>,
    signal?: AbortSignal,
  ) => Promise<CallResult<ClientOperationTypes[K]['output']>>
}

/** Binds every query and command of `name` to the transport under its generated method name. */
export function localClient<I extends LocalInterface>(
  transport: RuntimeClientTransport,
  name: I,
): LocalClient<I> {
  const client: Record<string, unknown> = {}
  for (const operation of Object.keys(RuntimeClientOperations) as (keyof Operations)[]) {
    const { localInterface, localMethod, kind } = RuntimeClientOperations[operation]
    if (localInterface !== name || (kind !== 'query' && kind !== 'command')) continue
    const call = kind === 'query' ? transport.query : transport.command
    client[localMethod] = (input: never, signal?: AbortSignal) =>
      call.call(transport, operation as ClientJsonOperation, input, signal)
  }
  return Object.freeze(client) as LocalClient<I>
}

/** `formLink(interactionId, expectedVersion)` as the public interface names it, sent as one input. */
const formLink =
  (transport: RuntimeClientTransport, operation: 'interaction.formLink' | 'approval.formLink') =>
  (interactionId: string, expectedVersion: number, signal?: AbortSignal) =>
    transport.command(operation, { interactionId, expectedVersion }, signal)

export type RuntimeClientFacadeOptions = ArtifactClientOptions & {
  /** How often an idle subscription polls when no push socket is open. */
  pollIntervalMs?: number
}

/** Every local interface the runtime client wire serves, over one connected or connecting transport. */
export function createRuntimeClient(
  transport: RuntimeClientTransport,
  options: RuntimeClientFacadeOptions = {},
) {
  const { pollIntervalMs, ...artifacts } = options
  return Object.freeze({
    transport,
    conversations: localClient(transport, 'ShellConversationClient'),
    domain: Object.freeze({
      ...localClient(transport, 'ShellDomainClient'),
      ...localClient(transport, 'DomainCommandClient'),
    }),
    controls: localClient(transport, 'SessionControlClient'),
    budget: localClient(transport, 'SessionBudgetClient'),
    permissions: localClient(transport, 'PermissionClient'),
    jobs: localClient(transport, 'SessionJobsClient'),
    status: localClient(transport, 'ClientTransportClient'),
    interactions: Object.freeze({
      ...localClient(transport, 'InteractionClient'),
      formLink: formLink(transport, 'interaction.formLink'),
    }),
    // Its own client, so a caller answering business questions never holds the human approval entry
    // by accident; who may answer either one is decided by the backend, never here.
    approvals: Object.freeze({
      ...localClient(transport, 'ApprovalClient'),
      formLink: formLink(transport, 'approval.formLink'),
    }),
    artifacts: Object.freeze(artifactClient(transport, artifacts)),
    subscribe: subscriptions(transport, pollIntervalMs === undefined ? {} : { pollIntervalMs }).subscribe,
  })
}
export type RuntimeClient = ReturnType<typeof createRuntimeClient>
