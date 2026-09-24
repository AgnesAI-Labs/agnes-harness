// The client object: one connection, one handshake, one validated call path.
// Everything above it (sessions, jobs, approvals) is built out of `call` / `notify`,
// so schema checking and the lazy handshake happen in exactly one place.
import {
  type ApisListResult,
  type ApprovalGrantListResult,
  type ApprovalGrantRecord,
  type AttachFilter,
  type ClientModuleEffectCallParams,
  type ClientModuleListResult,
  type ClientModuleReadResult,
  type ClientModuleRosterRow,
  type ClientModuleServiceCallParams,
  type ConfigAccountInput,
  type ConfigOAuthInput,
  type ConfigOAuthResult,
  type ConfigProvidersResult,
  type ConfigSaveInput,
  type ConfigSnapshot,
  type ConfigTestInput,
  type ConfigTestResult,
  type Credential,
  type Cursor,
  META_KEY,
  METHODS,
  type MethodName,
  type MethodSpec,
  type PageSessionMeta,
  projectClientModuleRows,
  rpcError,
  type SessionListParams,
  type SessionPreferences,
  type SkinListResult,
  type SkinReadResult,
  type SurfacesMountsResult,
  validateAgainst,
  validateMethod,
  type WorkspaceAddResult,
  type WorkspaceListResult,
} from '@agnes/protocol'
import type {
  ClientModuleEffectCallResult,
  ClientModuleServiceCallResult,
} from '@agnes/protocol/gen/package-admin'
import { type AuthOption, type AuthProvider, jwtAuth, localAuth, portalIdentityAuth } from './auth.js'
import { BrandingCache } from './branding.js'
import { type Claim, makeClaim } from './claim.js'
import { JsonRpcError, ProtocolViolation, RequestTimeout, TransportClosed, Unsupported } from './errors.js'
import { type Disposer, Emitter } from './events.js'
import { untilAborted } from './initialize-wait.js'
import { type JournalStore, memoryJournal } from './journal.js'
import { type PermissionHandler, type PermissionRequest, rejectPermission } from './permission.js'
import { type ReconnectOptions, Reconnector } from './reattach.js'
import { RpcConnection } from './rpc.js'
import { Session } from './session.js'
import { resendPending, submitForkCommand } from './submit.js'
import { textFor } from './text.js'
import { inprocTransport, type RpcEndpoint } from './transport/inproc.js'
import type { CloseInfo, TransportFactory } from './transport/types.js'

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
  transport: TransportOption
  auth?: AuthOption
  clientId?: string
  journal?: JournalStore
  timeouts?: { request?: number; initialize?: number; claim?: number }
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

export type InitializeInfo = { agnesVersion: string; capabilities: Record<string, unknown> }

export type CallOptions = {
  // null means no deadline at all; a turn is bounded by liveness, not by a stopwatch.
  timeoutMs?: number | null
  // Set only by the handshake itself, which would otherwise wait on its own result.
  skipInit?: boolean
}

type InitializeResponseBody = {
  protocolVersion: number
  agentCapabilities?: Record<string, unknown>
  _meta?: { agnes?: { agnesVersion?: string } }
}

function knownMethod(method: string): method is MethodName {
  return Object.hasOwn(METHODS, method)
}

// The schema type, borrowed from the validator rather than imported from the schema
// library, which is protocol's dependency and not ours.
type Schema = Parameters<typeof validateAgainst>[0]

// Reserved for generated-but-unlisted methods; empty means no call bypasses METHODS validation.
const UNLISTED: Record<string, { params?: Schema; result?: Schema }> = {}

export class Client {
  // Connection/options stay private so consumers cannot bypass client bookkeeping or expose auth.
  private readonly conn: RpcConnection
  readonly journal: JournalStore
  readonly timeouts: { request: number; initialize: number; claim: number }
  readonly locale: string
  readonly bufferLimit: number
  readonly claim: Claim
  readonly text = {
    blocked: (): string => textFor(this.locale).blocked,
    unavailable: (): string => textFor(this.locale).unavailable,
  }
  private readonly emitter = new Emitter<ClientEvent>()
  private state: ConnectionState = 'idle'
  private readonly auth: AuthProvider
  private initPromise: Promise<InitializeInfo> | null = null
  private initAbort: AbortController | undefined
  private closing = false
  private closePromise: Promise<void> | null = null
  private closedPromise: Promise<void> | null = null
  private clientIdCache: string | null = null
  private readonly sessionTable = new Map<string, Session>()
  private readonly reconnector: Reconnector
  private brandingCache: BrandingCache | null = null
  // Latched by a `daemon.notice{kind:'shutting_down'}`: the next transport close is the
  // daemon going away on purpose, not a drop to retry through.
  shuttingDown = false

  constructor(opts: CreateClientOptions) {
    const providers = {
      local: () => localAuth(),
      jwt: (o: AuthOption) => {
        if (o.kind !== 'jwt') throw new Unsupported('jwt option')
        return jwtAuth(o.token)
      },
      'portal-identity': (o: AuthOption) => {
        if (o.kind !== 'portal-identity') throw new Unsupported('portal option')
        return portalIdentityAuth(o.token)
      },
      ...(opts.authProviders ?? {}),
    } as Record<string, (o: AuthOption) => AuthProvider>
    const authOpt: AuthOption = opts.auth ?? { kind: 'local' }
    const makeAuth = providers[authOpt.kind]
    if (!makeAuth) throw new Unsupported(`auth kind ${authOpt.kind}`)
    this.auth = makeAuth(authOpt)
    this.journal = opts.journal ?? memoryJournal(opts.clientId)
    this.timeouts = {
      request: opts.timeouts?.request ?? 30_000,
      initialize: opts.timeouts?.initialize ?? 10_000,
      claim: opts.timeouts?.claim ?? 4_000,
    }
    if (
      !Number.isInteger(this.timeouts.initialize) ||
      this.timeouts.initialize < 0 ||
      this.timeouts.initialize > 2_147_483_647
    )
      throw new TypeError('invalid initialize timeout')
    this.locale = opts.locale ?? 'en'
    this.bufferLimit = opts.bufferLimit ?? 1000
    const factories = {
      inproc: (o: TransportOption) => inprocTransport((o as { endpoint: RpcEndpoint }).endpoint),
      ...(opts.transportFactories ?? {}),
    } as Record<string, (o: TransportOption) => TransportFactory>
    const factory = factories[opts.transport.kind]
    if (!factory) throw new Unsupported(`transport ${opts.transport.kind}`)
    this.conn = new RpcConnection(factory(opts.transport), {
      requestTimeoutMs: this.timeouts.request,
      onClose: (info) => this.onTransportClose(info),
    })
    this.reconnector = new Reconnector(this, opts.reconnect)
    this.conn.onNotification((method, params) => this.dispatchNotification(method, params))
    this.conn.onServerRequest(async (method, params) => {
      if (method !== 'session/request_permission') throw new JsonRpcError(rpcError('METHOD_NOT_FOUND'))
      if (!validateMethod('session/request_permission', 'params', params).ok)
        throw new JsonRpcError(rpcError('INVALID_PARAMS'))
      const request = params as PermissionRequest & { _meta?: Record<string, { deadline?: string }> }
      const deadline = request._meta?.[META_KEY]?.deadline
      const clean: PermissionRequest = {
        sessionId: request.sessionId,
        toolCall: request.toolCall,
        options: request.options,
        ...(deadline !== undefined ? { deadlineMs: Date.parse(deadline) } : {}),
      }
      if (clean.deadlineMs !== undefined && !Number.isFinite(clean.deadlineMs)) return rejectPermission(clean)
      return this.sessionTable.get(clean.sessionId)?.answerPermission(clean) ?? rejectPermission(clean)
    })
    this.claim = makeClaim(this, opts.claimStrict ?? false)
  }

  // The reconnect loop's view of what to recover, and the browser build's own inspection
  // surface: neither needs (or gets) a way to add or remove an entry directly.
  get sessions(): ReadonlyMap<string, Session> {
    return this.sessionTable
  }

  // True once close() has been called, OR the daemon has announced it is shutting down
  // (`shuttingDown`, latched by dispatchNotification): either way the client is done for
  // good, not merely between reconnect attempts. A call in flight fails fast instead of
  // quietly reconnecting on the caller's behalf - this is the single check every entry
  // point below guards on, so a consumer that only knows about the explicit close() path
  // (or none at all) still gets refused rather than silently handed a second real
  // connection behind a `closed` event that already told every listener there would not
  // be one. Session uses it to tell "the transport died, wait for the reconnect to settle
  // this turn" from "the client is going away for good."
  get isClosed(): boolean {
    return this.closing || this.shuttingDown
  }

  /** Connected means the handshake and any attached-session recovery have both completed. */
  get connectionState(): ConnectionState {
    return this.state
  }

  private setConnectionState(next: ConnectionState): void {
    if (this.state === next || this.state === 'closed') return
    this.state = next
    this.emitter.emit('connectionStateChanged', next)
  }

  /** Shared deployment configuration. Secrets are submitted only, never returned or journaled. */
  readonly config = {
    oauth: (input: ConfigOAuthInput): Promise<ConfigOAuthResult> =>
      this.call(
        '_agnes/v1/config.oauth',
        input,
        input.action === 'commit' ? { timeoutMs: Math.max(this.timeouts.request, 90_000) } : {},
      ),
    account: (input: ConfigAccountInput): Promise<ConfigSnapshot> =>
      this.call('_agnes/v1/config.account', input),
    get: (): Promise<ConfigSnapshot> => this.call('_agnes/v1/config.get', {}),
    providers: (): Promise<ConfigProvidersResult> => this.call('_agnes/v1/config.providers', {}),
    test: (input: ConfigTestInput): Promise<ConfigTestResult> =>
      this.call(
        '_agnes/v1/config.test',
        input,
        ['anthropic', 'github-copilot', 'kimi-coding', 'openai-codex', 'xai'].includes(input.providerId)
          ? { timeoutMs: Math.max(this.timeouts.request, 90_000) }
          : {},
      ),
    save: (input: ConfigSaveInput): Promise<ConfigSnapshot> =>
      this.call(
        '_agnes/v1/config.save',
        input,
        ['anthropic', 'github-copilot', 'kimi-coding', 'openai-codex', 'xai'].includes(input.providerId)
          ? { timeoutMs: Math.max(this.timeouts.request, 90_000) }
          : {},
      ),
  }

  readonly workspace = {
    list: (): Promise<WorkspaceListResult> => this.call('_agnes/v1/workspace.list', {}),
    add: (path: string): Promise<WorkspaceAddResult> => this.call('_agnes/v1/workspace.add', { path }),
  }

  /**
   * The current Surface mount->endpoint table. This is how the CLI/Web OS process (`agnes serve`,
   * a separate process from `agnesd`) learns where each mounted Surface's loopback listener is, to
   * build `createMountProxy`'s lookup() across that process boundary (packages/cli/launch/web-command.ts).
   */
  readonly surfaces = {
    mounts: (): Promise<SurfacesMountsResult> => this.call('_agnes/v1/surfaces.mounts', {}),
  }

  /**
   * Skins contributed by installed packages. The caller supplies its own profile — the daemon scope
   * accepts exactly that one — and `cssUrl` is same-origin, so the client fetches it directly.
   */
  readonly skins = {
    list: (profile: string): Promise<SkinListResult> => this.call('_agnes/v1/skins.list', { profile }),
    /**
     * Bytes for one `/skins/...` path. The launcher's asset proxy needs the file contents, and the
     * path never leaves the URL space: the daemon resolves it against its own roster (design §22).
     */
    read: (profile: string, path: string): Promise<SkinReadResult> =>
      this.call('_agnes/v1/skins.read', { profile, path }),
  }

  /**
   * Web client modules contributed by installed packages (design WC2/WC3). The page calls `list`
   * directly; `read` is for the launcher's asset proxy — the path stays in the `/plugins/` URL
   * space and the daemon answers only from its immutable snapshots.
   */
  readonly clientModules = {
    /**
     * Returns the row-level browser projection. Older daemons may only send the compatibility
     * modules/statuses fields; normalize that response locally so callers get the same `rows`
     * contract without ever exposing config, credentials, or raw runtime artifacts.
     */
    list: async (profile: string): Promise<ClientModuleListResult & { rows: ClientModuleRosterRow[] }> =>
      projectClientModuleRows(
        await this.call('_agnes/v1/clientModules.list', { profile }),
      ) as ClientModuleListResult & { rows: ClientModuleRosterRow[] },
    read: (profile: string, path: string): Promise<ClientModuleReadResult> =>
      this.call('_agnes/v1/clientModules.read', { profile, path }),
    /** Private launcher BFF only; it is not exposed by the browser SDK surface. */
    callService: (input: ClientModuleServiceCallParams): Promise<ClientModuleServiceCallResult> =>
      this.call('_agnes/v1/clientModules.callService', input),
    /** Private launcher BFF only; browser builds reject this method. */
    callEffect: (input: ClientModuleEffectCallParams): Promise<ClientModuleEffectCallResult> =>
      this.call('_agnes/v1/clientModules.callEffect', input),
  }

  readonly session = {
    new: async (o: { cwd: string; preset?: string; sessionKey?: string }): Promise<Session> => {
      const meta: Record<string, unknown> = {}
      if (o.preset) meta.preset = o.preset
      if (o.sessionKey) meta.sessionKey = o.sessionKey
      const r = await this.call<{ sessionId: string }>('session/new', {
        cwd: o.cwd,
        mcpServers: [],
        _meta: { [META_KEY]: meta },
      })
      return this.sessionHandle(r.sessionId, o.cwd)
    },
    // The vendored request shape makes cwd and mcpServers mandatory. An omitted cwd means the
    // daemon must recover an existing session's immutable durable workspace or reject an unknown
    // id. A supplied cwd is only a lookup hint. The daemon must match it to an already registered
    // workspace and must never treat session.load as workspace.add.
    load: async (
      id: string,
      o: {
        cwd?: string
        onPermissionRequest?: PermissionHandler
        /** Receives the disposer for the load-time handler before the RPC is sent. */
        onPermissionRequestRegistered?: (off: () => void) => void
      } = {},
    ): Promise<Session> => {
      // Install before the request goes on the wire. A daemon may answer a permission request
      // while session/load is still replaying history; creating the handle only after load used to
      // make that request take the automatic reject path in the client-level server handler.
      const session = this.sessionHandle(id)
      const offPermission = o.onPermissionRequest
        ? session.onPermissionRequest(o.onPermissionRequest)
        : undefined
      if (offPermission) {
        try {
          o.onPermissionRequestRegistered?.(offPermission)
        } catch (error) {
          offPermission()
          throw error
        }
      }
      try {
        await this.call('session/load', { sessionId: id, cwd: o.cwd ?? '', mcpServers: [] })
        if (o.cwd) session.rememberWorkspace(o.cwd)
        return session
      } catch (error) {
        // A failed load did not establish a usable caller-owned session. Do not leave its handler
        // installed to answer a later request for the same cached handle by accident.
        offPermission?.()
        throw error
      }
    },
    attach: async (id: string, o: { cursor?: Cursor; filter?: AttachFilter } = {}): Promise<Session> => {
      const s = this.sessionHandle(id)
      await s.attach(o)
      return s
    },
    list: (o: SessionListParams = {}): Promise<PageSessionMeta> =>
      this.call<PageSessionMeta>('_agnes/v1/session.list', o),
    rename: (sessionId: string, title: string): Promise<SessionPreferences> =>
      this.call('_agnes/v1/session.rename', { sessionId, title }),
    archive: (sessionId: string, archived: boolean): Promise<SessionPreferences> =>
      this.call('_agnes/v1/session.archive', { sessionId, archived }),
    fork: async (id: string, at: number): Promise<Session> => {
      const childId = await submitForkCommand(this, id, at)
      return this.sessionHandle(childId)
    },
  }

  /** A parked approval is resumed by an opaque ticket and an approver credential. The server,
   *  never this client, resolves that credential to the Actor written to the ledger. */
  readonly approval = {
    decide: (
      ticket: string,
      verdict: 'allowed-once' | 'allowed-session' | 'allowed-permanent' | 'rejected',
      approverCredential: Credential,
    ): Promise<{ seq: number }> =>
      this.call<{ seq: number }>('_agnes/v1/approval.decide', {
        ticket,
        verdict,
        approverCredential,
      }),
    listGrants: (
      sessionId: string,
      binding: { toolId: string; scope: string; policyVersion: string },
    ): Promise<ApprovalGrantListResult> =>
      this.call('_agnes/v1/approvalGrants.list', { sessionId, ...binding }),
    revokeGrant: (
      sessionId: string,
      binding: { toolId: string; scope: string; policyVersion: string },
      grantId: string,
    ): Promise<ApprovalGrantRecord> =>
      this.call('_agnes/v1/approvalGrants.revoke', { sessionId, ...binding, grantId }),
  }

  /**
   * Re-establishes daemon runtime state for a durable session whose worker was reclaimed while the
   * client transport stayed open. Session owns the retry/cursor policy; Client keeps the validated
   * wire call in the same place as an explicit session.load.
   */
  restoreSession(id: string, cwd: string): Promise<unknown> {
    return this.call('session/load', { sessionId: id, cwd, mcpServers: [] })
  }

  private sessionHandle(id: string, cwd?: string): Session {
    let s = this.sessionTable.get(id)
    if (!s) {
      s = new Session(this, id, cwd)
      this.sessionTable.set(id, s)
    } else if (cwd) s.rememberWorkspace(cwd)
    return s
  }

  // Session-scoped notifications are routed by the sessionId they carry; anything
  // addressed to nobody in particular is a client-level event.
  private dispatchNotification(method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>
    if (method === '_agnes/v1/daemon.notice') {
      // Latched, never cleared: once the daemon says it is going away, the next drop is
      // that shutdown arriving, not a fault to reconnect through. A loop already running
      // (from an earlier, unrelated drop) is stopped too, rather than left to keep
      // retrying against a server that already announced it will not be there.
      if (p.kind === 'shutting_down') {
        this.shuttingDown = true
        this.reconnector.stop()
        this.setConnectionState('closed')
      }
      if (p.kind === 'overloaded' && typeof p.sessionId === 'string')
        this.sessionTable.get(p.sessionId)?.onStreamOverloaded()
      this.emit('notice', p)
      return
    }
    const sessionId = typeof p.sessionId === 'string' ? p.sessionId : null
    if (sessionId) this.sessionTable.get(sessionId)?.onNotification(method, p)
  }

  async clientId(): Promise<string> {
    this.clientIdCache ??= await this.journal.clientId()
    return this.clientIdCache
  }

  // Memoised, and only while it succeeds: a rejected handshake drops the memo so the
  // next caller gets a real retry rather than the old failure forever.
  initialize(): Promise<InitializeInfo> {
    if (this.isClosed) return Promise.reject(new TransportClosed({ reason: 'closed' }))
    if (this.initPromise === null) {
      if (this.state === 'idle') this.setConnectionState('connecting')
      this.initPromise = this.doInitialize().then(
        (info) => {
          if (this.state === 'connecting') this.setConnectionState('connected')
          return info
        },
        (error: unknown) => {
          this.initPromise = null
          if (this.state === 'connecting') this.setConnectionState('idle')
          throw error
        },
      )
    }
    return this.initPromise
  }

  private async doInitialize(): Promise<InitializeInfo> {
    const abort = new AbortController()
    this.initAbort = abort
    const start = Date.now()
    const timer = setTimeout(
      () => abort.abort(new RequestTimeout('initialize', this.timeouts.initialize)),
      this.timeouts.initialize,
    )
    try {
      await untilAborted(() => this.conn.connect(), abort.signal)
      const clientId = await untilAborted(() => this.clientId(), abort.signal)
      const params: Record<string, unknown> = {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          _meta: { [META_KEY]: { capabilities: { permission: true } } },
        },
      }
      const metadata: Record<string, unknown> = { clientId }
      params._meta = { [META_KEY]: metadata }
      // The signature input is the final handshake sans auth, including the durable clientId.
      const auth = await untilAborted(
        () => this.auth.build({ clientId, initializeParams: structuredClone(params), signal: abort.signal }),
        abort.signal,
      )
      if (auth !== undefined) metadata.auth = structuredClone(auth)
      const r = await untilAborted(
        () =>
          this.call<InitializeResponseBody>('initialize', params, {
            timeoutMs: Math.max(0, this.timeouts.initialize - (Date.now() - start)),
            skipInit: true,
          }),
        abort.signal,
      )
      if (r.protocolVersion !== 1) throw new ProtocolViolation('unsupported negotiated protocol version')
      return {
        agnesVersion: r._meta?.agnes?.agnesVersion ?? 'unknown',
        capabilities: r.agentCapabilities ?? {},
      }
    } finally {
      clearTimeout(timer)
      if (this.initAbort === abort) this.initAbort = undefined
    }
  }

  async call<T>(method: string, params: unknown, o: CallOptions = {}): Promise<T> {
    // Terminal is terminal, whether the caller closed us or the daemon told us it is
    // going away. Without this the handshake memo is gone, so the call runs
    // initialize() -> connect() -> a brand new transport, and the client the caller (or
    // the daemon) shut down is quietly alive again on a connection nobody is watching.
    if (this.isClosed) throw new TransportClosed({ reason: 'closed' })
    if (!o.skipInit) await this.initialize()
    this.checkParams(method, params)
    const result = await this.conn.request<T>(method, params, {
      // Omitted, not undefined: leaving the key off is what lets the connection apply
      // its own default deadline, while an explicit null means "no deadline".
      ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
    })
    this.checkResult(method, result)
    return result
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (this.isClosed) throw new TransportClosed({ reason: 'closed' })
    await this.initialize()
    this.checkParams(method, params)
    await this.conn.notify(method, params)
  }

  // Params are checked before the frame leaves: a malformed request should fail here,
  // where the stack points at the caller, not as a server error round-trip later.
  private checkParams(method: string, params: unknown): void {
    const fallback = UNLISTED[method]?.params
    const v = knownMethod(method)
      ? validateMethod(method, 'params', params)
      : fallback
        ? validateAgainst(fallback, params)
        : null
    if (v && !v.ok) throw new ProtocolViolation(`${method} params: ${v.errors[0]?.message ?? 'invalid'}`)
  }

  private checkResult(method: string, result: unknown): void {
    const fallback = UNLISTED[method]?.result
    const v = knownMethod(method)
      ? (METHODS[method] as MethodSpec).result
        ? validateMethod(method, 'result', result)
        : null
      : fallback
        ? validateAgainst(fallback, result)
        : null
    if (v && !v.ok) throw new ProtocolViolation(`${method} result: ${v.errors[0]?.message ?? 'invalid'}`)
  }

  async resendPending(sessionId: string): Promise<void> {
    await resendPending(this, sessionId)
  }

  async apis(): Promise<ApisListResult> {
    return this.call<ApisListResult>('_agnes/v1/apis.list', {})
  }

  branding(): BrandingCache {
    this.brandingCache ??= new BrandingCache(async () => (await this.apis()).profile.branding)
    return this.brandingCache
  }

  on(event: ClientEvent, h: (payload: unknown) => void): Disposer {
    return this.emitter.on(event, h)
  }

  // The way in for anything that has to reach a consumer without a session of its own to
  // travel on - notices, and now the reconnect loop's own `reconnected` /
  // `generationChanged` / `gap`. `on(...)` is the surface; the emitter itself is not, or a
  // consumer could fake a terminal `closed` for every other consumer.
  emit(event: ClientEvent, payload: unknown): void {
    // Reconnector sends this only after resend and every attached session have recovered.
    if (event === 'reconnected' && this.state === 'reconnecting' && !this.isClosed)
      this.setConnectionState('connected')
    this.emitter.emit(event, payload)
  }

  notice(payload: unknown): void {
    this.emit('notice', payload)
  }

  // Memoised rather than flagged: a second close() has to wait for the first one's
  // teardown. Returning early while the transport is still going down tells a signal
  // handler it may exit, in the middle of the cursor write it was waiting for.
  close(): Promise<void> {
    this.closePromise ??= this.doClose()
    return this.closePromise
  }

  private async doClose(): Promise<void> {
    this.closing = true
    this.setConnectionState('closed')
    this.brandingCache?.stop()
    // A retry loop already asleep between attempts must not wake up and reconnect a
    // client the caller just asked to go away.
    this.reconnector.stop()
    this.initAbort?.abort(new TransportClosed({ reason: 'closed' }))
    try {
      await this.conn.close()
    } finally {
      // A client that never connected still owes its listeners a terminal signal,
      // so `closed` fires here when the transport had no close of its own to report.
      await this.emitClosed({ reason: 'closed' })
    }
  }

  // The transport's own report that it is gone. Three outcomes, in order of how final the
  // loss is: the caller already asked to close, or the daemon already said it is shutting
  // down - either way this is the end, so tear down for good; otherwise it is a fault
  // nobody chose, and the reconnect loop takes it from here. Sessions are deliberately left
  // alone on that third path: `attached` stays true, `onClosed()` is never called, and a
  // consumer mid-`for await` on `events()` simply stalls until recover() lets it resume -
  // it must not be handed a stream that looks like it ended for good.
  private onTransportClose(info: CloseInfo): void {
    this.initAbort?.abort(new TransportClosed(info))
    this.initPromise = null
    if (this.isClosed) {
      this.reconnector.stop()
      this.setConnectionState('closed')
      // A synchronous transport callback: there is nobody here to await the cursor writes
      // this starts, so this one path stays fire-and-forget.
      void this.emitClosed(info)
      return
    }
    this.setConnectionState('reconnecting')
    this.emitter.emit('reconnecting', { reason: info.reason })
    this.reconnector.onClosed(info)
  }

  // Memoised, so it is both the fire-once latch and the thing close() waits on: the
  // transport usually reports its own close from inside conn.close(), and a plain flag
  // would let close() return while the writes that callback started are still in flight.
  // Because a drop that can be retried never reaches here (onTransportClose hands it to
  // the reconnect loop instead), this now genuinely fires once, for real, at the end of
  // the client's life - never once per drop.
  private emitClosed(info: CloseInfo): Promise<void> {
    this.closedPromise ??= this.doEmitClosed(info)
    return this.closedPromise
  }

  // Resolves once every session has finished the cursor write it owes, so an awaited
  // close() is the point after which a resume reads a position that is actually on disk.
  private async doEmitClosed(info: CloseInfo): Promise<void> {
    // Before the listeners: an iterator parked on `events()` is waiting on a stream
    // that will never produce again, and a `-p` run has to exit rather than hang.
    const flushes = [...this.sessionTable.values()].map((s) => s.onClosed())
    this.emitter.emit('closed', info)
    await Promise.allSettled(flushes)
  }
}

export function createClient(opts: CreateClientOptions): Client {
  return new Client(opts)
}
