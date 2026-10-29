import type { Actor, JsonValue } from '@agnes/protocol'
import type { StreamDeclaration, StreamScope } from '@agnes/protocol/gen/plugin-stream'

export type { StreamDeclaration, StreamScope } from '@agnes/protocol/gen/plugin-stream'
export type StreamFrame = Uint8Array | JsonValue
export interface PluginStream {
  send(frame: StreamFrame): 'accepted' | 'dropped' | 'closed'
  onFrame(fn: (frame: StreamFrame) => void): () => void
  onDrop(fn: (info: { reason: 'backpressure'; count: number }) => void): () => void
  onDisconnect(fn: (info: { reason: string }) => void | Promise<void>): () => void
  close(reason: string): void
}
export interface StreamContext {
  /** Authenticated same-origin Web ingress, when present. Never supplied in plugin input. */
  readonly origin?: string
  readonly scope: StreamScope
  readonly actor: Actor
  readonly source: string
  readonly signal: AbortSignal
  readonly stream: PluginStream
  /** Verified by current authority; never a browser-supplied grant. */
  /** Set only by the backend's reviewed cross-owner producer bridge. */
  readonly producer?: Readonly<{ owner: string; packageId: string; integrity: string; activationId: string }>
  readonly control?: { readonly grantId: string; readonly expiresAt: number }
}
export type StreamHandler = (input: JsonValue, context: StreamContext) => void | Promise<void>
/** The daemon binds owner and scope from the reviewed registration, not from plugin input. */
export interface PluginStreamsPort {
  register(name: StreamDeclaration['name'], handler: StreamHandler): () => void
}
export interface PluginStreamsClient {
  open(
    name: string,
    input: JsonValue,
    options?: {
      signal?: AbortSignal
      controlOperationId?: string
    },
  ): Promise<PluginStream>
}
