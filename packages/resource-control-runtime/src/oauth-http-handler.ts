import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  beginMcpOAuthLogin,
  type McpOAuthCompleteParams,
  McpOAuthDiscoveryFailed,
  type McpOAuthSummary,
} from './mcp-oauth-login.js'
import { type OAuthResultPage, renderOAuthResultPage } from './oauth-result-page.js'
import { claimOAuthNonce, openOAuthState, sealOAuthState } from './oauth-state.js'

export { withTimeout } from './oauth-fetch.js'

/**
 * The daemon HTTP callback endpoints for the OAuth 2.1 authorization_code flow (`/oauth/:serverId/start`
 * and `/oauth/:serverId/callback`). This module builds on the signed state
 * orchestrator (`oauth-state.ts`) and client registration chain / provider adapter
 * (`oauth-client.ts`) - like both of those, it knows nothing about *how* the caller looks up an MCP
 * server's URL or persists authorization status; those are injected (`resolveServer` /
 * `onAuthorizationStatus`) so this handler can be unit-tested against a fake and reused by whichever
 * process actually owns that state (see the two type doc comments below for exactly why).
 *
 * `resolveServer` supplies the target URL and optional static client ID. `login` reads the sign-in
 * summary and completes a sign-in: the authorization code is exchanged by whoever implements it
 * (the daemon), never here, so a static client secret never reaches this process. Authorization status
 * belongs to the daemon's single-writer resource-control journal; the launcher must report through
 * `_agnes/v1/mcp.servers.oauth.status.set` rather than write that journal from another process.
 * The injected `onAuthorizationStatus` hook stays optional for callers without a daemon connection.
 */

/** What this handler needs to know about one managed MCP server to start an authorization flow.
 * Deliberately narrow (not the full `McpServerDescriptor`) so a caller can satisfy it from a cheap,
 * targeted lookup instead of handing over unrelated definition/status fields this module never
 * touches. */
export type OAuthHttpServerInfo = Readonly<{
  serverUrl: URL
  /** `McpOAuthSecretBinding.staticClientId`, when the user has already supplied one. */
  staticClientId?: string
}>

/** Injected server lookup - the daemon-reachability question above. Returns `undefined` for an
 * unknown serverId (the route answers 404, without ever contacting an authorization server). */
export type ResolveOAuthServer = (serverId: string) => Promise<OAuthHttpServerInfo | undefined>

/** Mirrors `McpServerDescriptor.authorizationStatus`'s value set minus `'pending'` (a callback only
 * ever transitions *out of* pending, never back into it). */
export type OAuthAuthorizationStatus = 'authorized' | 'needs-reconnect' | 'error'

/** `beginAuthorization`'s outcome, transport-agnostic (no HTTP status code baked in - `handleStart`
 * maps this to a redirect-or-error HTTP response; `startAuthorization` below maps it to plain JSON
 * instead). Includes authorization URLs, pending client IDs, and the failure
 * cases `handleStart`'s HTTP responses already distinguish (404/502/502) so a JSON caller can tell
 * them apart the same way an HTTP caller reading the status code could. */
export type OAuthStartResult =
  | Readonly<{ authorizeUrl: string }>
  | Readonly<{ pendingClientId: true }>
  | Readonly<{
      error: 'mcp_server_not_found' | 'oauth_discovery_failed' | 'oauth_authorization_start_failed'
    }>

/** Injected, best-effort descriptor bookkeeping - see the module header's second deviation. Errors
 * thrown here are swallowed by the callback handler: a failure to record status must never turn an
 * otherwise-successful (or otherwise-already-failed) token exchange into a second, misleading kind
 * of failure for the browser sitting on the other end of the redirect. */
export type OnOAuthAuthorizationStatus = (serverId: string, status: OAuthAuthorizationStatus) => Promise<void>

/** Sign-in summary and completion, both owned by the daemon. */
export type OAuthLoginOwner = Readonly<{
  get(serverId: string): Promise<McpOAuthSummary>
  complete(params: McpOAuthCompleteParams): Promise<void>
}>

export type CreateOAuthHttpHandlerOptions = Readonly<{
  /** HMAC secret for `sealOAuthState`/`openOAuthState` - see oauth-state.ts. */
  secret: string
  login: OAuthLoginOwner
  /** This process's own externally-reachable origin (e.g. `http://127.0.0.1:4177`), used to build
   * `redirect_uri` and the post-callback redirect back to the Web UI. */
  baseUrl: URL
  resolveServer: ResolveOAuthServer
  onAuthorizationStatus?: OnOAuthAuthorizationStatus
  /** Test seam; production leaves this unset and gets the SDK's own default (global `fetch`). */
  fetchImpl?: FetchLike
  /** Test seam for deterministic timestamps; production leaves this unset. */
  now?: () => number
  /** How long a signed state (and the PKCE/client-registration bookkeeping this handler keeps
   * alongside it in memory - see `pendingRegistrations` below) stays valid. 10 minutes: long enough
   * for a human to actually read a real consent screen and click through it (this is a real
   * end-user-facing browser flow, not a machine-to-machine round trip - matching the order of
   * magnitude of `profile.json`'s own `approval.pending_ttl_ms` default doc example for
   * human-interactive waits), short enough that an abandoned flow does not sit in memory
   * indefinitely. */
  stateTtlMs?: number
}>

const DEFAULT_STATE_TTL_MS = 10 * 60_000
const ROUTE = /^\/oauth\/([^/]+)\/(start|callback)$/
const SERVER_ID_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/

/** A registered client's secret stays in this process's memory; it never travels in `state`. */
type PendingRegistration = Readonly<{
  clientId: string
  clientSecret?: string
  expiresAt: number
}>

/**
 * CSRF/drive-by guard for `/start` only (found by independent security review): `server.ts` calls
 * `handleAdmin` with no credential gate before this handler chain is ever reached, and the Web
 * server's own cross-site floor only covers writes - `/start` is a GET, unlike the
 * `createAdminSurface`/`createResourceAdminSurface` routes, which check origin themselves. Without this, any page the user happens to
 * have open could trigger `/oauth/<serverId>/start` via `<img>`/`fetch()`/a hidden `<iframe>` with
 * zero user interaction, for any already-registered OAuth-bound MCP server - a zero-click drive-by
 * that would also arm the SSRF surface above without the user ever clicking "Authorize".
 *
 * `/callback` deliberately gets none of this: it is reached via a real top-level cross-origin
 * navigation *from the authorization server back to us* (a 302 the user's browser follows after
 * consenting), which this exact same check would incorrectly reject as cross-site. Its own
 * protection - the signed, replay-protected `state` parameter - is what actually
 * authenticates that request; adding a same-origin check there would break the real flow, not
 * secure it further.
 *
 * Shape mirrors `server.ts:268-283`'s workspace-picker route: `sec-fetch-site` must be
 * `same-origin` or `none` (older browsers, or a typed/bookmarked URL, send no Fetch Metadata
 * headers at all) when present, and `origin` must match this server's own origin when present -
 * both are optional-when-absent because this route is reached by a real top-level navigation (the
 * user clicking "Authorize" in the Web UI, or typing/bookmarking the URL directly), not a
 * fetch/XHR: browsers do not attach a custom `Authorization` header to a plain top-level
 * navigation from a link click, so - unlike the workspace-picker route - this deliberately does
 * NOT also require `options.token`/a bearer credential. `sec-fetch-site: cross-site` (what a
 * malicious page's `<img>`/`fetch()`/`<iframe>` actually sends) is exactly what gets rejected here;
 * a real top-level click-through navigation from the Web UI itself sends `same-origin`.
 */
function rejectsCrossOriginNavigation(request: IncomingMessage, baseUrl: URL): boolean {
  const site = request.headers['sec-fetch-site']
  if (typeof site === 'string') {
    if (site !== 'same-origin' && site !== 'none') return true
  } else if (site !== undefined) {
    // A duplicated/array-valued header is itself anomalous - fail closed rather than treating it
    // as equivalent to "absent" (which is the more permissive branch).
    return true
  }
  const origin = request.headers.origin
  if (typeof origin === 'string') {
    if (origin !== baseUrl.origin) return true
  } else if (origin !== undefined) {
    return true
  }
  return false
}

function page(response: ServerResponse, kind: OAuthResultPage, detail?: string, status?: number): void {
  const rendered = renderOAuthResultPage(kind, detail)
  response.writeHead(status ?? rendered.status, rendered.headers).end(rendered.body)
}

function redirect(response: ServerResponse, target: URL): void {
  response.writeHead(302, { location: target.toString() }).end()
}

function wantsJson(request: IncomingMessage): boolean {
  const accept = request.headers.accept
  return typeof accept === 'string' && accept.includes('application/json')
}

/**
 * The `(request, response) => Promise<boolean>` handler `handleAdmin` also uses (returns `true`
 * once it has fully written a response, `false` for a request outside `/oauth/*`), PLUS one more
 * capability: `startAuthorization`, a plain async function carrying the exact same "resolve ->
 * discover -> register client -> PKCE -> sign state -> build authorize URL" logic `GET /start` uses
 * (see `beginAuthorization` below), returned as data instead of a redirect. It exists for the
 * browser-facing authorization start operation. This stays in the HTTP process because the
 * `state` this closure signs is only ever verifiable by *this exact instance's* `/callback` (it is
 * sealed with `opts.secret` and cross-referenced against this closure's own in-memory
 * `pendingRegistrations`, both process-lifetime-scoped by design - see oauth-state.ts and the
 * `pendingRegistrations` doc comment below), and `/callback` can only ever be reached through this
 * same `agnes serve` launcher process's own HTTP surface (it is the one process with a browser-
 * reachable listener at all - the daemon's RPC surface is a private Unix socket a browser cannot
 * navigate to). A daemon-dispatched RPC method calling `beginAuthorization` a second time, in a
 * different process, would sign a `state` this instance's `/callback` could never open - not a
 * missing feature to add later, a structural mismatch this module's caller (a future Web UI) must
 * reach through this same process instead, e.g. via this capability once something wires it up.
 */
export type OAuthHttpHandler = ((request: IncomingMessage, response: ServerResponse) => Promise<boolean>) &
  Readonly<{
    startAuthorization(serverId: string): Promise<OAuthStartResult>
  }>

export function createOAuthHttpHandler(opts: CreateOAuthHttpHandlerOptions): OAuthHttpHandler {
  const now = opts.now ?? (() => Date.now())
  const stateTtlMs = opts.stateTtlMs ?? DEFAULT_STATE_TTL_MS
  // Every network call (discovery, registration) goes through `beginMcpOAuthLogin`, which wraps
  // this in `withTimeout` (10 s, `redirect: 'error'`). The token request is made by `login.complete`
  // in the daemon, under the same guard.
  const fetchImpl: FetchLike = opts.fetchImpl ?? fetch

  // Bridges `start` -> `callback` within this one process's lifetime: a dynamically registered
  // client's secret must reach the code exchange, but must not travel through the browser inside
  // `state`. Same lifetime as oauth-state.ts's own `claimedNonces`, keyed by the same nonce; a
  // missing entry at callback time means this process restarted in between.
  const pendingRegistrations = new Map<string, PendingRegistration>()

  function sweepExpiredRegistrations(nowMs: number): void {
    for (const [nonce, entry] of pendingRegistrations)
      if (entry.expiresAt < nowMs) pendingRegistrations.delete(nonce)
  }

  async function markStatus(serverId: string, status: OAuthAuthorizationStatus): Promise<void> {
    try {
      await opts.onAuthorizationStatus?.(serverId, status)
    } catch {
      // Best-effort bookkeeping only - see the module header's second deviation. A failure here
      // must never change the HTTP response already decided by the caller.
    }
  }

  type BeginAuthorizationResult =
    | Readonly<{ kind: 'not_found' }>
    | Readonly<{ kind: 'discovery_failed' }>
    | Readonly<{ kind: 'pending_client_id' }>
    | Readonly<{ kind: 'authorization_start_failed' }>
    | Readonly<{ kind: 'ok'; authorizationUrl: URL; redirectUri: string }>

  /** The one place a sign-in starts - shared, not duplicated, between `handleStart` (HTTP
   * `GET /start`, 302s to the result) and `startAuthorization` (JSON capability, below). The
   * request itself (client, scope, resource, PKCE) is built by `beginMcpOAuthLogin`; this adds the
   * signed `state` that carries what the callback must hand back to `login.complete`. */
  async function beginAuthorization(serverId: string): Promise<BeginAuthorizationResult> {
    const info = await opts.resolveServer(serverId)
    if (!info) return { kind: 'not_found' }

    const redirectUri = new URL(`/oauth/${serverId}/callback`, opts.baseUrl).toString()

    let started: Awaited<ReturnType<typeof beginMcpOAuthLogin>>
    try {
      started = await beginMcpOAuthLogin({
        serverId,
        serverUrl: info.serverUrl,
        ...(info.staticClientId ? { staticClientId: info.staticClientId } : {}),
        summary: await opts.login.get(serverId),
        redirectUri,
        fetchImpl,
      })
    } catch (error) {
      return {
        kind: error instanceof McpOAuthDiscoveryFailed ? 'discovery_failed' : 'authorization_start_failed',
      }
    }
    if ('pendingClientId' in started) return { kind: 'pending_client_id' }

    const nowMs = now()
    sweepExpiredRegistrations(nowMs)
    const nonce = randomBytes(16).toString('hex')
    const { clientSecret, ...client } = started.client
    const sealed = await sealOAuthState(
      {
        serverId,
        redirectUri,
        codeVerifier: started.codeVerifier,
        nonce,
        issuedAt: nowMs,
        expectedEpoch: started.expectedEpoch,
        client,
        requestedScope: [...started.requestedScope],
        authorization: started.authorization,
      },
      { secret: opts.secret },
    )
    pendingRegistrations.set(nonce, {
      clientId: client.clientId,
      ...(clientSecret ? { clientSecret } : {}),
      expiresAt: nowMs + stateTtlMs,
    })

    started.authorizationUrl.searchParams.set('state', sealed)
    return { kind: 'ok', authorizationUrl: started.authorizationUrl, redirectUri }
  }

  type StartFailure = Readonly<{
    page: OAuthResultPage
    status: number
    error:
      | 'mcp_server_not_found'
      | 'oauth_discovery_failed'
      | 'oauth_client_id_required'
      | 'oauth_authorization_start_failed'
  }>

  const START_FAILURES: Readonly<
    Record<
      'not_found' | 'discovery_failed' | 'pending_client_id' | 'authorization_start_failed',
      StartFailure
    >
  > = {
    not_found: { page: 'failed', status: 404, error: 'mcp_server_not_found' },
    discovery_failed: { page: 'discovery-failed', status: 502, error: 'oauth_discovery_failed' },
    pending_client_id: { page: 'client-id-required', status: 400, error: 'oauth_client_id_required' },
    authorization_start_failed: { page: 'failed', status: 502, error: 'oauth_authorization_start_failed' },
  }

  /** A failed `/start` answers a result page, or `{ error }` JSON when the caller asked for JSON. */
  function startFailed(
    request: IncomingMessage,
    response: ServerResponse,
    failure: StartFailure | { page: 'failed'; status: 403; error: 'origin_rejected' },
  ): void {
    if (wantsJson(request)) {
      response
        .writeHead(failure.status, { 'content-type': 'application/json; charset=utf-8' })
        .end(JSON.stringify({ error: failure.error }))
      return
    }
    page(response, failure.page, undefined, failure.status)
  }

  /** A plain navigation is redirected to the authorization server; a JSON caller (the Web UI)
   * gets the URL and the callback address instead, so it can check the address before leaving. */
  async function handleStart(
    serverId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const result = await beginAuthorization(serverId)
    if (result.kind !== 'ok') return startFailed(request, response, START_FAILURES[result.kind])
    if (wantsJson(request)) {
      response
        .writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        .end(
          JSON.stringify({
            authorizeUrl: result.authorizationUrl.toString(),
            redirectUri: result.redirectUri,
          }),
        )
      return
    }
    redirect(response, result.authorizationUrl)
  }

  /** The JSON-returning twin of `handleStart` - see this factory's own `OAuthHttpHandler` doc
   * comment for why this is exposed as a plain function rather than a second HTTP route or a daemon
   * RPC method. `serverId` is validated the same way the HTTP route's dispatcher validates it
   * (SERVER_ID_PATTERN) since this entry point bypasses that dispatcher entirely. */
  async function startAuthorizationJson(serverId: string): Promise<OAuthStartResult> {
    if (!SERVER_ID_PATTERN.test(serverId)) return { error: 'mcp_server_not_found' }
    const result = await beginAuthorization(serverId)
    if (result.kind === 'ok') return { authorizeUrl: result.authorizationUrl.toString() }
    if (result.kind === 'pending_client_id') return { pendingClientId: true }
    if (result.kind === 'not_found') return { error: 'mcp_server_not_found' }
    if (result.kind === 'discovery_failed') return { error: 'oauth_discovery_failed' }
    return { error: 'oauth_authorization_start_failed' }
  }

  async function handleCallback(
    serverId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const requestUrl = new URL(request.url ?? '', opts.baseUrl)
    const stateParam = requestUrl.searchParams.get('state')
    const codeParam = requestUrl.searchParams.get('code')
    const errorParam = requestUrl.searchParams.get('error')

    // Every rejection from here down happens before `login.complete` is ever reached - a tampered,
    // expired, mismatched or replayed state must be rejected before the authorization code (if any)
    // is used for anything at all.
    if (!stateParam) return page(response, 'state-expired')

    let payload: Awaited<ReturnType<typeof openOAuthState>>
    try {
      payload = await openOAuthState(stateParam, { secret: opts.secret, maxAgeMs: stateTtlMs })
    } catch {
      return page(response, 'state-expired')
    }
    // The state's own serverId must match the URL's serverId segment - otherwise a validly-signed
    // state minted for one server could be replayed against a different server's callback route.
    if (payload.serverId !== serverId) return page(response, 'state-expired')

    const claimed = await claimOAuthNonce(payload.nonce, payload.issuedAt + stateTtlMs)
    if (!claimed) return page(response, 'state-expired')

    const pending = pendingRegistrations.get(payload.nonce)
    pendingRegistrations.delete(payload.nonce)

    // No bookkeeping for a genuinely first-claimed nonce: this process restarted between start and
    // callback (both the nonce table and this map are process-lifetime only, by design). An error
    // from the authorization server (or the user declining consent) or a missing code: never try
    // an exchange.
    if (!pending || pending.clientId !== payload.client.clientId) {
      await markStatus(serverId, 'error')
      return page(response, 'state-expired')
    }
    if (errorParam || !codeParam) {
      await markStatus(serverId, 'error')
      if (errorParam)
        return page(response, errorParam === 'access_denied' ? 'cancelled' : 'failed', errorParam)
      return page(response, 'failed', 'The callback carried no code.')
    }

    try {
      await opts.login.complete({
        serverId,
        expectedEpoch: payload.expectedEpoch,
        code: codeParam,
        codeVerifier: payload.codeVerifier,
        redirectUri: payload.redirectUri,
        client: {
          ...payload.client,
          ...(pending.clientSecret ? { clientSecret: pending.clientSecret } : {}),
        },
        requestedScope: payload.requestedScope,
        authorization: payload.authorization,
      })
    } catch (error) {
      await markStatus(serverId, 'error')
      return page(response, error instanceof McpOAuthDiscoveryFailed ? 'discovery-failed' : 'failed')
    }
    await markStatus(serverId, 'authorized')
    page(response, 'signed-in')
  }

  const httpHandler = async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const requestUrl = new URL(request.url ?? '', opts.baseUrl)
    const match = ROUTE.exec(requestUrl.pathname)
    if (!match) return false
    const [, rawServerId, action] = match as unknown as [string, string, 'start' | 'callback']
    if (request.method !== 'GET') {
      response.writeHead(405).end()
      return true
    }
    if (!SERVER_ID_PATTERN.test(rawServerId)) {
      startFailed(request, response, START_FAILURES.not_found)
      return true
    }
    if (action === 'start' && rejectsCrossOriginNavigation(request, opts.baseUrl)) {
      startFailed(request, response, { page: 'failed', status: 403, error: 'origin_rejected' })
      return true
    }
    if (action === 'start') await handleStart(rawServerId, request, response)
    else await handleCallback(rawServerId, request, response)
    return true
  }
  return Object.assign(httpHandler, { startAuthorization: startAuthorizationJson })
}
