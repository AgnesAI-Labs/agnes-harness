// The `@agnes/sdk/runtime` entry: the runtime client wire (validated calls with journaled command
// recovery, subscriptions and verified artifact reads), its local interfaces as one client, and the
// default text presentation of a domain view. Everything here runs unchanged in browsers and Node. The
// journal the client needs comes from the `@agnes/sdk` or `@agnes/sdk/browser` entry; transport
// internals stay unexported.
export { type ArtifactByteStream, type ArtifactRange, artifactReader } from './artifact-reader.js'
export type { ArtifactClientOptions } from './artifacts.js'
export {
  createRuntimeClient,
  type LocalClient,
  type LocalInterface,
  type RuntimeClient,
  type RuntimeClientFacadeOptions,
} from './client.js'
export {
  type RuntimeSubscription,
  type SubscribeRequest,
  type SubscriptionEnd,
  subscriptions,
} from './client-subscriptions.js'
export {
  type CallResult,
  type LocalRefusal,
  type PushEvent,
  type RecoveryReport,
  RUNTIME_JOURNAL_KEY,
  type RuntimeClientMode,
  type RuntimeClientOptions,
  RuntimeClientTransport,
  type RuntimeFetch,
  type RuntimeSocket,
  type RuntimeWebSocketFactory,
  runtimeJournalKey,
} from './client-transport.js'
export { encodeForChannel, formatDomainView } from './format-view.js'
