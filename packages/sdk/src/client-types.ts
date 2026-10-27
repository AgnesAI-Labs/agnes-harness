// The options a client is created and called with, and the events it emits.
import type { LoopSelection } from '@agnes/protocol'
import type { AuthOption, AuthProvider } from './auth.js'
import type { JournalStore } from './journal.js'
import type { PermissionHandler } from './permission.js'
import type { ReconnectOptions } from './reattach.js'
import type { RpcEndpoint } from './transport/inproc.js'
import type { TransportFactory } from './transport/types.js'

export type TransportOption =
  | { kind: 'inproc'; endpoint: RpcEndpoint }
  | {
      kind: 'stdio'
      cmd: string[]
      env?: Record<string, string>
      cwd?: string
      nodeExecutable?: string
      windowsBatch?: 'script' | 'argv-proxy'
    }
  // Windows requires a verified identity, or a custom unix factory with trusted discovery.
  | { kind: 'unix'; path: string; serverIdentity?: { pid: number; processStartId: string } }
  | {
      kind: 'ws'
      url: string
      tls?: { ca?: string; rejectUnauthorized?: boolean }
      protocols?: string[]
    }

// `reconnected` fires once the connection and every attached session are recovered after
// an unexpected drop. `generationChanged` and `gap` are per-session recovery outcomes
// (a stale generation re-attached under the server's new one; a resumed cursor the server
// no longer has, re-attached from its earliest available row) - both can also fire outside
// a reconnect, but in practice today only recovery produces them.
export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed'
export type ClientEvent =
  | 'closed'
  | 'notice'
  | 'reconnecting'
  | 'reconnected'
  | 'connectionStateChanged'
  | 'generationChanged'
  | 'gap'

export type ReconnectedEvent = { attempts: number }
export type GenerationChangedEvent = { sessionId: string; generation: number }
export type GapEvent = { sessionId: string; earliestSeq: number }

export type CreateClientOptions = {
  /** Recovery policy for handles created/attached without an explicit load. ACP remains the default. */
  sessionRestoreHistory?: 'full' | 'none'
  transport: TransportOption
  auth?: AuthOption
  clientId?: string
  journal?: JournalStore
  timeouts?: { request?: number; initialize?: number; claim?: number; loadIdle?: number; loadHard?: number }
  locale?: string
  bufferLimit?: number
  claimStrict?: boolean
  // Backoff tuning for the reconnect loop. Tests shrink these to make retries instant;
  // production takes the defaults (100ms, doubling, capped at 5s, ±20% jitter).
  reconnect?: ReconnectOptions
  // Providers and transport factories are injected by the build entry point rather
  // than imported here, so the browser bundle cannot pull in node-only code paths
  // just because a type union mentions them.
  authProviders?: Record<string, (opt: AuthOption) => AuthProvider>
  transportFactories?: Partial<Record<TransportOption['kind'], (opt: TransportOption) => TransportFactory>>
}

export type InitializeInfo = {
  agnesVersion: string
  capabilities: Record<string, unknown>
  platform?: string
}

export type CallOptions = {
  /** Existing bridge proof envelope; method parameters remain credential-free. */
  metadata?: Record<string, unknown>
  // null means no deadline at all; a turn is bounded by liveness, not by a stopwatch.
  timeoutMs?: number | null
  // Set only by the handshake itself, which would otherwise wait on its own result.
  skipInit?: boolean
  signal?: AbortSignal
}

export type SessionLoadOptions = {
  cwd?: string
  /** Admission only, with a negotiated fallback to ACP load on older daemons. */
  history?: 'full' | 'none'
  signal?: AbortSignal
  onPermissionRequest?: PermissionHandler
  onProgress?: (progress: import('@agnes/protocol').SessionLoadingParams) => void
  /** Receives the disposer before the RPC is sent. */
  onPermissionRequestRegistered?: (off: () => void) => void
}

/** What `session/new` takes from a client. */
export type NewSessionOptions = {
  cwd: string
  preset?: string
  /** `read-only`, `workspace-write`, `full-access`, or `default` for the deployment default. */
  permission?: string
  agent?: string
  agentDigest?: string
  bundles?: readonly string[]
  /** Owner text appended to this new session's system prompt (1 to 8192 characters); never a replacement. */
  systemPromptAppend?: string
  sessionKey?: string
  loop?: LoopSelection
  /** Extra directories for this new session's file fence; the daemon must advertise support. */
  additionalDirectories?: readonly string[]
}
