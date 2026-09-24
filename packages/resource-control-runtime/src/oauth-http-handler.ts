import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { exchangeAuthorization, startAuthorization } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  AuthorizationServerMetadata,
  OAuthClientInformation,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  registerOAuthClient,
  resolveAuthorizationServerUrl,
  tryDiscoverAuthorizationServerMetadata,
} from './oauth-client.js'
import { claimOAuthNonce, openOAuthState, sealOAuthState } from './oauth-state.js'

/**
 * The daemon HTTP callback endpoints for the OAuth 2.1 authorization_code flow (`/oauth/:serverId/start`
 * and `/oauth/:serverId/callback`). This module is generic OAuth-over-HTTP plumbing built on top of Task 2's signed state
 * orchestrator (`oauth-state.ts`) and Task 3's client registration chain / provider adapter
 * (`oauth-client.ts`) - like both of those, it knows nothing about *how* the caller looks up an MCP
 * server's URL or persists authorization status; those are injected (`resolveServer` /
 * `onAuthorizationStatus`) so this handler can be unit-tested against a fake and reused by whichever
 * process actually owns that state (see the two type doc comments below for exactly why).
 *
 * ## Two deliberate deviations from the task brief's literal `createOAuthHttpHandler` sketch
 *
 * The brief's "Produces" line sketches `createOAuthHttpHandler(opts: {secret, credentialStore,
 * baseUrl})`. That signature is not implementable as written - starting an authorization flow
 * requires knowing the target MCP server's URL (and its optional static `client_id`), and neither
 * of those is derivable from `secret`/`credentialStore`/`baseUrl` alone. This module therefore adds
 * two more fields to the options type: `resolveServer` (required - there is no way to build an
 * authorization URL without it) and `onAuthorizationStatus` (optional - the brief's step 4 asks the
 * callback to update `McpServerDescriptor.authorizationStatus`, but that field lives in the daemon's
 * `resource-control-store` journal, a single-writer, read-modify-write JSON file this handler's
 * actual caller - `agnes serve`'s launcher process, a *different* process from the daemon that owns
 * that journal - cannot safely write to directly without racing the daemon's own writer. Reaching it
 * safely needs a daemon-local RPC method - at the time Task 4 wrote this module, that method did not
 * exist yet (the plan's own preflight scan assigns `packages/daemon/src/local/methods/`... in
 * practice `_agnes/v1/mcp.servers.oauth.status.set`, see resource-control-contracts/src/
 * resource-control.ts, a different location than that preflight guess found - to Task 5, not Task
 * 4). Task 5 has since added it and wired `packages/cli/launch/oauth-admin.ts`'s
 * `onAuthorizationStatus` to call it; this option stays optional here regardless, because this
 * module still cannot assume every caller has (or wants) a daemon connection to report through -
 * keeping the hook optional and injected is what let this module be built, tested and merged one
 * task before its one real consumer existed, and is not made mandatory now just because a consumer
 * finally showed up. See the Task 4 report for the original reasoning and the Task 5 report for how
 * the gap was closed.)
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
 * instead). Mirrors the daemon's `mcp.servers.oauth.start`-shaped intent from the mcp-oauth-
 * authorization plan's Task 5 brief (`{authorizeUrl} | {pendingClientId: true}`), plus the failure
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

/** Exactly the shape `packages/host/src/adapters/credential-store.ts`'s `OAuthCredential` requires
 * for `CredentialStore.putOAuth`. Deliberately NOT importing that type from `@agnes/host` - this
 * package (`resource-control-runtime`) has no dependency on `@agnes/host` today, and adding one just
 * to name a type would be a needless new package edge for a shape any structurally-compatible object
 * already satisfies (the same decoupling `oauth-client.ts`'s own `OAuthCredential` already
 * establishes for the same reason - see that file's doc comment). */
export type OAuthStoredCredential = Readonly<{
  provider: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  scope: readonly string[]
  grantId: string
}>

/** Structural subset of `CredentialStore` (only the one method this handler calls). */
export type OAuthCredentialStoreWriter = Readonly<{
  putOAuth(ref: string, value: OAuthStoredCredential): Promise<void>
}>

export type CreateOAuthHttpHandlerOptions = Readonly<{
  /** HMAC secret for `sealOAuthState`/`openOAuthState` - see oauth-state.ts. */
  secret: string
  credentialStore: OAuthCredentialStoreWriter
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
  /** Bounds every network call this handler makes to an authorization server (discovery,
   * registration, token exchange) - matches the order of magnitude of
   * `packages/base/src/mcp/connect.ts`'s `DEFAULT_MCP_CONNECT_TIMEOUT_MS`
   * (10s) for the same reason: a slow or malicious remote endpoint must not be able to hang this
   * handler (and, transitively, the single-threaded Node HTTP server it runs inside of)
   * indefinitely. */
  requestTimeoutMs?: number
}>

const DEFAULT_STATE_TTL_MS = 10 * 60_000
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const ROUTE = /^\/oauth\/([^/]+)\/(start|callback)$/
const SERVER_ID_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/
const INVALID_STATE_BODY = JSON.stringify({ error: { code: 'invalid_oauth_state' } })

type PendingRegistration = Readonly<{
  clientId: string
  clientSecret?: string
  expiresAt: number
}>

/**
 * Exported (Task 6's addition; originally private to this module) so `mcp-oauth-credentials.ts`'s
 * worker-side lazy-refresh resolver reads and writes the exact same credential-store ref this
 * handler's callback route uses to persist the initial token exchange - the two must agree on the
 * ref format byte-for-byte or a refresh would silently write to (or read from) a different file than
 * the one `resolvedConfig()` actually resolves against.
 */
export function credentialRefFor(serverId: string): string {
  return `secret://mcp-oauth/${serverId}`
}

/**
 * Exported (Task 6's addition; originally private to this module) so `mcp-oauth-credentials.ts`'s
 * `refreshAuthorization` call gets the identical timeout + `redirect: 'error'` guard as every other
 * SDK network call in this OAuth flow, instead of risking a second, independently-written (and
 * possibly subtly different) copy of this security-reviewed wrapper - see the SHARP EDGE comment at
 * this function's call site below for why that specific risk is not hypothetical here.
 */
export function withTimeout(fetchImpl: FetchLike | undefined, timeoutMs: number): FetchLike {
  const base = fetchImpl ?? fetch
  return async (input, init) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      // `redirect: 'error'` (found by independent security review): every fetch this handler makes
      // (PRM discovery, RFC 8414 discovery, DCR registration, token exchange - see the "SHARP EDGE"
      // checklist comment where this function is called from, which is what actually keeps this
      // list true; this doc comment describing the intent is not itself what enforces it) targets a
      // URL that has already been validated (see oauth-client.ts's SSRF guards), but a redirect response's own
      // `Location` header is not itself something that validation ever inspects - a compromised or
      // malicious endpoint could otherwise 30x this daemon-side request to an arbitrary internal host
      // after the fact, silently bypassing every check already done on the *requested* URL. `fetch`'s
      // own default (`redirect: 'follow'`) would do exactly that. None of these calls have a
      // legitimate reason to redirect (they are metadata/credential exchanges, not content fetches),
      // so refusing outright - matching `packages/base/src/mcp/connect.ts`'s
      // `policedHttpFetch` own no-validator fallback behavior, rather than reimplementing its full
      // revalidate-then-follow loop for a flow that never needs it - is the correct default.
      return await base(input, { ...init, redirect: 'error', signal: init?.signal ?? controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Same core principle as `packages/daemon/src/surfaces/routes.ts:491`'s `safeRedirect`: never
 * redirect to anything other than a same-origin relative path (reject a scheme-qualified URL and a
 * protocol-relative `//host/...` URL, both of which a bare `startsWith('/')` check alone would miss
 * the `//` case for). That function itself is not reused here - it is not exported, and its second
 * half (`routeTarget` against a `ResolvedSurface[]` mount table) validates a completely different
 * thing: whether a location is a *registered Surface channel mount*, not whether it is "somewhere on
 * this process's own Web UI origin". Reimplementing just the reusable half, with this comment
 * pointing at the precedent, follows the spirit of "don't hand-roll redirect validation" without
 * forcing a fit that does not apply. */
function safeReturnTo(returnTo: string | undefined, baseUrl: URL): URL {
  if (returnTo?.startsWith('/') && !returnTo.startsWith('//')) {
    try {
      return new URL(returnTo, baseUrl)
    } catch {
      // Falls through to the default below.
    }
  }
  return new URL('/', baseUrl)
}

/**
 * CSRF/drive-by guard for `/start` only (found by independent security review): `server.ts` calls
 * `handleAdmin` with no bearer-token gate before this handler chain is ever reached - unlike
 * `localPackageAdmin`/`localResourceAdmin`, which each enforce bearer+origin checks via
 * `createAdminSurface`/`createResourceAdminSurface`. Without this, any page the user happens to
 * have open could trigger `/oauth/<serverId>/start` via `<img>`/`fetch()`/a hidden `<iframe>` with
 * zero user interaction, for any already-registered OAuth-bound MCP server - a zero-click drive-by
 * that would also arm the SSRF surface above without the user ever clicking "Authorize".
 *
 * `/callback` deliberately gets none of this: it is reached via a real top-level cross-origin
 * navigation *from the authorization server back to us* (a 302 the user's browser follows after
 * consenting), which this exact same check would incorrectly reject as cross-site. Its own
 * protection - the signed, replay-protected `state` parameter (Task 2) - is what actually
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

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body))
}

function invalidState(response: ServerResponse): void {
  response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }).end(INVALID_STATE_BODY)
}

function redirect(response: ServerResponse, target: URL): void {
  response.writeHead(302, { location: target.toString() }).end()
}

/**
 * The `(request, response) => Promise<boolean>` handler `handleAdmin` also uses (returns `true`
 * once it has fully written a response, `false` for a request outside `/oauth/*`), PLUS one more
 * capability: `startAuthorization`, a plain async function carrying the exact same "resolve ->
 * discover -> register client -> PKCE -> sign state -> build authorize URL" logic `GET /start` uses
 * (see `beginAuthorization` below), returned as data instead of a redirect. It exists for the
 * mcp-oauth-authorization plan's Task 5 (`mcp.servers.oauth.start`) - see that task's report for why
 * it is exposed this way rather than as a genuine daemon-dispatched `_agnes/v1/...` RPC method: the
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
    startAuthorization(serverId: string, options?: Readonly<{ returnTo?: string }>): Promise<OAuthStartResult>
  }>

export function createOAuthHttpHandler(opts: CreateOAuthHttpHandlerOptions): OAuthHttpHandler {
  const now = opts.now ?? (() => Date.now())
  const stateTtlMs = opts.stateTtlMs ?? DEFAULT_STATE_TTL_MS
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  // SHARP EDGE (found the hard way by independent security review, second round: `handleCallback`'s
  // `exchangeAuthorization` call below was missing `fetchFn: fetchImpl` entirely, silently exempting
  // the single most sensitive request in this whole flow - the POST carrying the authorization code,
  // PKCE `code_verifier` and any client secret - from both the timeout and the redirect:'error' guard
  // this wrapper exists to provide). Every SDK function call in this file (and in oauth-client.ts,
  // which this file calls into) that accepts a `fetchFn`/`fetchImpl` option MUST receive this exact
  // value - there is no central client/transport object here the way
  // `packages/base/src/mcp/connect.ts` injects `policedHttpFetch` into once for
  // every request a transport issues; each SDK call is independent and the option is easy to forget
  // on a new one. Current checklist (recheck this comment if you add a new SDK call): oauth-client.ts's
  // `resolveAuthorizationServerUrl`/`tryDiscoverAuthorizationServerMetadata`/`registerOAuthClient`
  // (all take `fetchImpl` as a parameter, already threaded through from here) and this file's own
  // `exchangeAuthorization` call in `handleCallback`. `startAuthorization` is the one exception - its
  // signature has no `fetchFn` option at all, because it never fetches anything (pure PKCE generation
  // + URL construction) - omitting it there is correct, not a second instance of this bug.
  //
  // Task 6 addition: `mcp-oauth-credentials.ts` (worker-side lazy token refresh - a separate process
  // from this handler) makes its own independent `resolveAuthorizationServerUrl`/
  // `tryDiscoverAuthorizationServerMetadata`/`refreshAuthorization` calls and needs this exact same
  // discipline extended to that call site - flagged as a known future risk by this file's own Task 4
  // fix-round-2 review ("whichever later task builds token-refresh will need the identical fetchFn
  // discipline extended to that call site"). It does not reuse this closure's `fetchImpl` value
  // (different process, no shared memory) - it builds its own via the `withTimeout` export above,
  // the same function, not a parallel reimplementation.
  const fetchImpl = withTimeout(opts.fetchImpl, requestTimeoutMs)

  // Bridges `start` -> `callback` within this one process's lifetime: the client_id/secret a real
  // Dynamic Client Registration call resolves at `start` time MUST be the exact same one used to
  // exchange the code at `callback` time (the authorization code is bound server-side to the
  // client_id that requested it), so it cannot simply be re-derived by calling
  // `registerOAuthClient` a second time at callback - for a DCR-backed server that would register a
  // *second*, different client and the token exchange would be rejected. This is a parallel,
  // equally single-process-scoped in-memory map alongside oauth-state.ts's own `claimedNonces`, not
  // a new persistence layer - same lifetime, same "does not survive a daemon restart" scoping
  // already documented there, keyed by the same nonce.
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

  async function discover(
    serverUrl: URL,
  ): Promise<{ authorizationServerUrl: URL; metadata: AuthorizationServerMetadata | undefined }> {
    const authorizationServerUrl = await resolveAuthorizationServerUrl(serverUrl, fetchImpl)
    const metadata = await tryDiscoverAuthorizationServerMetadata(authorizationServerUrl, fetchImpl)
    return { authorizationServerUrl, metadata }
  }

  type BeginAuthorizationResult =
    | Readonly<{ kind: 'not_found' }>
    | Readonly<{ kind: 'discovery_failed' }>
    | Readonly<{ kind: 'pending_client_id' }>
    | Readonly<{ kind: 'authorization_start_failed' }>
    | Readonly<{ kind: 'ok'; authorizationUrl: URL }>

  /** The one place "generate PKCE + sign state + get an authorization URL" happens - shared, not
   * duplicated, between `handleStart` (HTTP `GET /start`, 302s to the result) and
   * `startAuthorization` (JSON capability, below). Every SDK network call it makes
   * (resolveAuthorizationServerUrl/tryDiscoverAuthorizationServerMetadata/registerOAuthClient/
   * startAuthorization) goes through the same guarded `fetchImpl` this closure built above - see the
   * SHARP EDGE checklist comment there; because both callers below route through this one function,
   * there is exactly one call site to keep that checklist honest for, not two that could quietly
   * drift apart. */
  async function beginAuthorization(
    serverId: string,
    returnTo: string | undefined,
  ): Promise<BeginAuthorizationResult> {
    const info = await opts.resolveServer(serverId)
    if (!info) return { kind: 'not_found' }

    const redirectUri = new URL(`/oauth/${serverId}/callback`, opts.baseUrl).toString()

    let authorizationServerUrl: URL
    let metadata: AuthorizationServerMetadata | undefined
    try {
      ;({ authorizationServerUrl, metadata } = await discover(info.serverUrl))
    } catch {
      return { kind: 'discovery_failed' }
    }

    const registration = await registerOAuthClient(info.serverUrl, {
      ...(info.staticClientId ? { staticClientId: info.staticClientId } : {}),
      redirectUri,
      fetchImpl,
    })
    if ('pendingClientId' in registration) return { kind: 'pending_client_id' }

    const clientInformation: OAuthClientInformation = {
      client_id: registration.clientId,
      ...(registration.clientSecret ? { client_secret: registration.clientSecret } : {}),
    }

    let started: { authorizationUrl: URL; codeVerifier: string }
    try {
      // startAuthorization() is the SDK's own PKCE generator (an S256 code_verifier/code_challenge
      // pair via its internal pkceChallenge()) - reused here rather than hand-rolled with
      // node:crypto directly, per the plan's explicit instruction to check for an SDK helper first.
      // It also refuses a server that advertises code_challenge_methods_supported without S256 in
      // it, so PKCE can never be silently downgraded away (design §1.3's hard requirement).
      started = await startAuthorization(authorizationServerUrl, {
        ...(metadata ? { metadata } : {}),
        clientInformation,
        redirectUrl: redirectUri,
      })
    } catch {
      return { kind: 'authorization_start_failed' }
    }

    const nowMs = now()
    sweepExpiredRegistrations(nowMs)
    const nonce = randomBytes(16).toString('hex')
    const sealed = await sealOAuthState(
      {
        serverId,
        redirectUri,
        codeVerifier: started.codeVerifier,
        nonce,
        issuedAt: nowMs,
        ...(returnTo ? { returnTo } : {}),
      },
      { secret: opts.secret },
    )
    pendingRegistrations.set(nonce, {
      clientId: registration.clientId,
      ...(registration.clientSecret ? { clientSecret: registration.clientSecret } : {}),
      expiresAt: nowMs + stateTtlMs,
    })

    started.authorizationUrl.searchParams.set('state', sealed)
    return { kind: 'ok', authorizationUrl: started.authorizationUrl }
  }

  function parseReturnTo(raw: string | undefined): string | undefined {
    return raw?.startsWith('/') && !raw.startsWith('//') ? raw : undefined
  }

  async function handleStart(
    serverId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const requestUrl = new URL(request.url ?? '', opts.baseUrl)
    const returnTo = parseReturnTo(requestUrl.searchParams.get('returnTo') ?? undefined)
    const result = await beginAuthorization(serverId, returnTo)
    if (result.kind === 'not_found') return json(response, 404, { error: { code: 'mcp_server_not_found' } })
    if (result.kind === 'discovery_failed')
      return json(response, 502, { error: { code: 'oauth_discovery_failed' } })
    if (result.kind === 'pending_client_id')
      return json(response, 409, { error: { code: 'oauth_client_registration_required' } })
    if (result.kind === 'authorization_start_failed')
      return json(response, 502, { error: { code: 'oauth_authorization_start_failed' } })
    redirect(response, result.authorizationUrl)
  }

  /** The JSON-returning twin of `handleStart` - see this factory's own `OAuthHttpHandler` doc
   * comment for why this is exposed as a plain function rather than a second HTTP route or a daemon
   * RPC method. `serverId` is validated the same way the HTTP route's dispatcher validates it
   * (SERVER_ID_PATTERN) since this entry point bypasses that dispatcher entirely. */
  async function startAuthorizationJson(
    serverId: string,
    options?: Readonly<{ returnTo?: string }>,
  ): Promise<OAuthStartResult> {
    if (!SERVER_ID_PATTERN.test(serverId)) return { error: 'mcp_server_not_found' }
    const result = await beginAuthorization(serverId, parseReturnTo(options?.returnTo))
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

    // Every rejection from here down happens before `credentialStore.putOAuth` or
    // `exchangeAuthorization` is ever reached - a tampered, expired, mismatched or replayed state
    // must be rejected before the authorization code (if any) is used for anything at all.
    if (!stateParam) return invalidState(response)

    let payload: Awaited<ReturnType<typeof openOAuthState>>
    try {
      payload = await openOAuthState(stateParam, { secret: opts.secret, maxAgeMs: stateTtlMs })
    } catch {
      return invalidState(response)
    }
    // The state's own serverId must match the URL's serverId segment - otherwise a validly-signed
    // state minted for one server could be replayed against a different server's callback route.
    if (payload.serverId !== serverId) return invalidState(response)

    const claimed = await claimOAuthNonce(payload.nonce, payload.issuedAt + stateTtlMs)
    if (!claimed) return invalidState(response)

    const pending = pendingRegistrations.get(payload.nonce)
    pendingRegistrations.delete(payload.nonce)
    const returnUrl = safeReturnTo(payload.returnTo, opts.baseUrl)

    if (!pending) {
      // Nonce genuinely claimed for the first time, yet no matching registration bookkeeping - the
      // only realistic cause is this process having restarted between start and callback (both the
      // nonce table and this map are process-lifetime only, by design - see oauth-state.ts).
      await markStatus(serverId, 'error')
      return redirect(response, returnUrl)
    }

    if (errorParam) {
      // The authorization server (or the user, declining consent) reported a failure - never
      // attempt a token exchange for this state.
      await markStatus(serverId, 'error')
      return redirect(response, returnUrl)
    }
    if (!codeParam) {
      await markStatus(serverId, 'error')
      return redirect(response, returnUrl)
    }

    const info = await opts.resolveServer(serverId)
    if (!info) {
      await markStatus(serverId, 'error')
      return redirect(response, returnUrl)
    }

    let authorizationServerUrl: URL
    let metadata: AuthorizationServerMetadata | undefined
    try {
      ;({ authorizationServerUrl, metadata } = await discover(info.serverUrl))
    } catch {
      await markStatus(serverId, 'error')
      return redirect(response, returnUrl)
    }

    const clientInformation: OAuthClientInformation = {
      client_id: pending.clientId,
      ...(pending.clientSecret ? { client_secret: pending.clientSecret } : {}),
    }

    let tokens: Awaited<ReturnType<typeof exchangeAuthorization>>
    try {
      tokens = await exchangeAuthorization(authorizationServerUrl, {
        ...(metadata ? { metadata } : {}),
        clientInformation,
        authorizationCode: codeParam,
        codeVerifier: payload.codeVerifier,
        redirectUri: payload.redirectUri,
        // Found missing by independent security review, second round: without this, the SDK's
        // executeTokenRequest() falls back to raw global fetch - no timeout, and (critically)
        // fetch's own default redirect:'follow', silently exempting the single most sensitive
        // request in this whole flow (the POST carrying the authorization code, PKCE
        // code_verifier and any client secret) from both protections withTimeout exists to
        // provide. `fetchImpl` is never undefined here (see its declaration above), so this can
        // be assigned directly rather than needing the conditional-spread dance the DCR call
        // above uses for its optional metadata field.
        fetchFn: fetchImpl,
      })
    } catch {
      await markStatus(serverId, 'error')
      return redirect(response, returnUrl)
    }

    // OAuth 2.1 allows a token response to omit `refresh_token` (RFC 6749 §5.1 makes it optional),
    // but `credential-store.ts`'s existing, untouched `isOAuthInput` schema requires both
    // `refreshToken` and `expiresAt` to be present - see design §3.5's explicit decision to treat
    // this as a hard failure (not silently degrade the stored shape or fabricate a value) rather
    // than weaken that shared, already-tested validation.
    if (!tokens.refresh_token || tokens.expires_in === undefined) {
      await markStatus(serverId, 'error')
      return redirect(response, returnUrl)
    }

    const scope = (tokens.scope ?? '').split(/\s+/).filter((value) => value.length > 0)
    const credential: OAuthStoredCredential = {
      provider: 'mcp-oauth',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: now() + tokens.expires_in * 1000,
      scope,
      // No provider-issued grant identifier is available from a standard RFC 6749 token response;
      // the serverId is a stable, human-legible, always-available substitute (the credentialRef
      // already encodes it too, so this is redundant-but-harmless, never misleading).
      grantId: serverId,
    }

    try {
      await opts.credentialStore.putOAuth(credentialRefFor(serverId), credential)
    } catch {
      await markStatus(serverId, 'error')
      return redirect(response, returnUrl)
    }

    await markStatus(serverId, 'authorized')
    redirect(response, returnUrl)
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
      json(response, 404, { error: { code: 'mcp_server_not_found' } })
      return true
    }
    if (action === 'start' && rejectsCrossOriginNavigation(request, opts.baseUrl)) {
      json(response, 403, { error: { code: 'origin_rejected' } })
      return true
    }
    if (action === 'start') await handleStart(rawServerId, request, response)
    else await handleCallback(rawServerId, request, response)
    return true
  }
  return Object.assign(httpHandler, { startAuthorization: startAuthorizationJson })
}
