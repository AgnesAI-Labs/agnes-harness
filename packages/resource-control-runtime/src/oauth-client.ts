import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  isHttpsUrl,
  type OAuthClientProvider,
  registerClient,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  AuthorizationServerMetadata,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { validateManagedHttpUrl } from './mcp.js'

/**
 * OAuth 2.1 client registration chain (Client ID Metadata Documents / Dynamic Client Registration
 * / static client_id) plus an `OAuthClientProvider` adapter for the SDK's `auth()` orchestrator.
 * Generic OAuth plumbing: knows about the MCP authorization spec, nothing about this daemon's
 * HTTP callback routes, secret storage format or worker process boundaries - those are Task 4/5's
 * job to wire on top of this module.
 *
 * ## Client ID Metadata Documents (CIMD) - what this module actually implements and why
 *
 * This is the one piece of Task 3 that required reading the authoritative source rather than
 * inferring it from this codebase, per
 * https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization (fetched and read
 * in full while implementing this file - not paraphrased from memory). The load-bearing facts:
 *
 * - CIMD is a real IETF draft the MCP spec incorporates directly:
 *   draft-ietf-oauth-client-id-metadata-document-00. Its mechanism: the *client's* `client_id` IS
 *   an HTTPS URL (with a non-root path, e.g. `https://app.example.com/oauth/client-metadata.json`)
 *   that the client itself hosts. That URL points at a JSON document containing at minimum
 *   `client_id` (which MUST equal the URL exactly), `client_name` and `redirect_uris`.
 * - There is no registration call to make. The *authorization server* is the one that fetches the
 *   document, lazily, the first time it sees a URL-shaped `client_id` in an authorization request -
 *   not this module, not at registration time. Fetching/validating that document is entirely the
 *   authorization server's responsibility (spec: "Authorization Servers: SHOULD fetch metadata
 *   documents when encountering URL-formatted client_ids ... MUST validate ..."). So
 *   `registerOAuthClient` never issues an HTTP request for CIMD - it just decides *whether* to
 *   hand back a URL as the client_id, by checking whether the authorization server has advertised
 *   support for the mechanism.
 * - Advertisement is a single boolean on the authorization server's own RFC 8414 metadata:
 *   `client_id_metadata_document_supported: true`. Nothing else about server behavior can be
 *   inferred client-side; a server that omits the field MUST be treated as unsupported (spec:
 *   "MCP clients SHOULD check for this capability and MAY fall back to Dynamic Client Registration
 *   or pre-registration if unavailable").
 * - This exact mechanism is *already implemented* in the installed SDK (1.25.2) under the name
 *   "SEP-991: URL-based Client IDs" - see `isHttpsUrl()` (reused here rather than reimplemented)
 *   and the `provider.clientMetadataUrl` / `metadata?.client_id_metadata_document_supported`
 *   handling inside the SDK's own `authInternal()`. This module's CIMD branch mirrors that
 *   reference implementation's logic rather than inventing a parallel one.
 *
 * A URL client_id is only ever usable, per spec, if the client genuinely hosts a matching metadata
 * document at that address - nothing in this repository hosts one yet (no such HTTPS endpoint
 * exists in this plan's scope). `clientMetadataUrl` is therefore accepted as an option here (so
 * the chain and its priority are real and tested against a real fixture authorization server) but
 * is not yet wired to any caller; until a later task publishes an actual Agnes client metadata
 * document at a stable URL, no real caller will supply this option and the CIMD branch will not
 * fire in production. This is recorded as a known, deliberate gap - see the Task 3 report.
 *
 * ## Registration priority: pre-registered -> CIMD -> DCR -> "ask the user"
 *
 * The plan's own brief paraphrased this as "CIMD -> DCR -> static client_id", but that inverts the
 * spec's actual, unambiguous order (spec, "Client Registration Approaches" section - "Clients
 * supporting all options SHOULD follow the following priority order"):
 *
 *   1. Use pre-registered client information for the server if the client has it available
 *   2. Use Client ID Metadata Documents if the Authorization Server indicates support
 *   3. Use Dynamic Client Registration as a fallback if the Authorization Server supports it
 *   4. Prompt the user to enter the client information if no other option is available
 *
 * This is also exactly what the SDK's own reference `auth()` orchestrator does structurally:
 * `authInternal()` checks `provider.clientInformation()` first and only even *attempts* discovery
 * (CIMD-or-DCR) when that returns undefined. `registerOAuthClient` below mirrors that: a caller-
 * supplied `staticClientId` short-circuits before any network call at all (see the "zero requests"
 * assertion in the test for this case), matching "pre-registered client information" being step 1,
 * not the last resort the brief's paraphrase implied.
 */

export type RegisterOAuthClientOptions = Readonly<{
  /** A user-supplied or previously-resolved client_id (McpOAuthSecretBinding.staticClientId in
   * the protocol schema). Takes priority over CIMD/DCR discovery entirely - see module header. */
  staticClientId?: string
  /** This client's own hosted CIMD metadata document URL, if one exists. Not yet wired to any
   * real caller in this codebase - see module header "known, deliberate gap". */
  clientMetadataUrl?: string
  /** Required to attempt Dynamic Client Registration (RFC 7591 client metadata always needs at
   * least one redirect_uri). Registration is skipped, not attempted-and-failed, when absent. */
  redirectUri?: string
  fetchImpl?: FetchLike
}>

export type RegisterOAuthClientResult =
  | Readonly<{ clientId: string; clientSecret?: string | undefined }>
  | Readonly<{ pendingClientId: true }>

/**
 * Resolves a usable OAuth client_id for `serverUrl` (an MCP server acting as an OAuth 2.1
 * resource server), trying pre-registered -> CIMD -> DCR in that order and falling back to
 * `{ pendingClientId: true }` (the caller must prompt the user for a static client_id and retry)
 * when nothing works. Never throws for an authorization-server-side failure - discovery and
 * registration errors are swallowed and treated as "this option is unavailable", since a server
 * that doesn't support one registration mechanism is an expected, not exceptional, outcome.
 */
export async function registerOAuthClient(
  serverUrl: URL,
  opts: RegisterOAuthClientOptions,
): Promise<RegisterOAuthClientResult> {
  if (opts.staticClientId) return { clientId: opts.staticClientId }

  const authorizationServerUrl = await resolveAuthorizationServerUrl(serverUrl, opts.fetchImpl)
  const metadata = await tryDiscoverAuthorizationServerMetadata(authorizationServerUrl, opts.fetchImpl)

  if (
    metadata?.client_id_metadata_document_supported === true &&
    opts.clientMetadataUrl &&
    isHttpsUrl(opts.clientMetadataUrl)
  ) {
    // SEP-991 / CIMD: the URL itself is the client_id. No registration call - see module header.
    return { clientId: opts.clientMetadataUrl }
  }

  if (metadata?.registration_endpoint && opts.redirectUri) {
    try {
      const info = await registerClient(authorizationServerUrl, {
        metadata,
        clientMetadata: buildDcrClientMetadata(opts.redirectUri),
        // SDK's fetchFn?: FetchLike has no explicit `| undefined` in its property type, so under
        // this repo's exactOptionalPropertyTypes the property must be omitted rather than set to
        // undefined - conditional spread does that instead of `fetchFn: opts.fetchImpl`.
        ...(opts.fetchImpl ? { fetchFn: opts.fetchImpl } : {}),
      })
      return { clientId: info.client_id, clientSecret: info.client_secret }
    } catch {
      // Registration endpoint exists but rejected us (unreachable, malformed response, policy
      // refusal, ...) - fall through to pendingClientId rather than propagating a discovery-time
      // error out of what is meant to be a best-effort chain.
    }
  }

  return { pendingClientId: true }
}

/**
 * RFC 9728 Protected Resource Metadata discovery. `discoverOAuthProtectedResourceMetadata` throws
 * (rather than returning undefined) when the resource server doesn't implement it, so a server
 * with no PRM support falls back to the legacy MCP 2025-03-26 behavior: the MCP server's own
 * origin acts as the authorization server. This mirrors the SDK's own `authInternal()` fallback.
 *
 * Exported (Task 4's addition; originally private to this module) so `oauth-http-handler.ts`'s
 * `/start` route can resolve the same authorization server URL and metadata it needs for
 * `startAuthorization()` without re-deriving this PRM/RFC 8414 fallback dance a second, independent
 * time - the same "reuse the canonicalizer, don't reimplement it" reasoning documented at the top
 * of packages/daemon/src/local/auth.ts applies here: a second hand-written copy of this discovery
 * fallback is exactly the kind of thing that quietly drifts from this one the day either changes.
 */
export async function resolveAuthorizationServerUrl(serverUrl: URL, fetchImpl?: FetchLike): Promise<URL> {
  try {
    const resourceMetadata = await discoverOAuthProtectedResourceMetadata(serverUrl, {}, fetchImpl)
    const first = resourceMetadata.authorization_servers?.[0]
    if (first) {
      const candidate = new URL(first)
      // SSRF guard (found by independent security review of Task 4, fixed here since this is the
      // one place the value is produced): `first` is attacker/compromised-resource-server-controlled
      // content straight out of this PRM response body, not something `serverUrl` itself being
      // validated at MCP definition registration time (resource-control-runtime/src/mcp.ts's
      // `validateManagedTransport`) ever covered - a resource server naming an arbitrary internal
      // host here would otherwise have every subsequent OAuth network call (RFC 8414 discovery, DCR,
      // token exchange) aimed at it from inside the daemon's own network position. `httpPolicy:
      // undefined` enforces HTTPS-only with no loopback exception - the right default for an
      // authorization server, which should never legitimately be loopback (unlike an MCP resource
      // server itself, which a local-daemon deployment may explicitly opt into over loopback HTTP -
      // see runtime-bootstrap.ts's own policy plumbing). An invalid candidate here is treated exactly
      // like "no PRM support" (falls through to the same legacy same-origin default below) rather
      // than propagating an error, matching this function's own "never throws" contract.
      validateManagedHttpUrl(candidate, undefined)
      return candidate
    }
  } catch {
    // No RFC 9728 Protected Resource Metadata, or the resource server named an authorization server
    // this function refuses to trust - legacy fallback below either way.
  }
  return new URL('/', serverUrl)
}

/** Exported alongside `resolveAuthorizationServerUrl` - see that function's doc comment. */
export async function tryDiscoverAuthorizationServerMetadata(
  authorizationServerUrl: URL,
  fetchImpl?: FetchLike,
): Promise<AuthorizationServerMetadata | undefined> {
  let metadata: AuthorizationServerMetadata | undefined
  try {
    metadata = await discoverAuthorizationServerMetadata(authorizationServerUrl, {
      ...(fetchImpl ? { fetchFn: fetchImpl } : {}),
    })
  } catch {
    // No RFC 8414 / OpenID discovery metadata at all - every downstream branch that depends on
    // `metadata` degrades to "unsupported", which is the correct outcome (not a fatal error).
    return undefined
  }
  // `discoverAuthorizationServerMetadata` itself can resolve to `undefined` (not only throw) - a
  // 404 with no fallback candidate left, per the SDK's own return type.
  if (!metadata) return undefined
  // SSRF guard (same finding as resolveAuthorizationServerUrl above): `token_endpoint` (required by
  // the SDK's own OAuthMetadataSchema) and `registration_endpoint` (optional) are both attacker/
  // compromised-server-controlled values straight out of this response body, each later handed
  // directly to a fetch call with no validation of its own inside the SDK - `token_endpoint` drives
  // `exchangeAuthorization`/`refreshAuthorization`'s token request, `registration_endpoint` drives
  // DCR's `registerClient` POST. Neither field can simply be stripped in place: `token_endpoint` is
  // a *required* string field of `AuthorizationServerMetadata` (setting it to `undefined` would not
  // type-check), so an untrusted document naming an unsafe endpoint for either is discarded
  // wholesale rather than surgically. Every caller already has an established, already-validated
  // fallback for "no RFC 8414 metadata at all" (the legacy 2025-03-26 same-origin behavior, or DCR
  // simply being skipped) - degrading to that path here is exactly the same safe default a server
  // that never implemented discovery gets treated to, not a new failure mode.
  try {
    validateManagedHttpUrl(new URL(metadata.token_endpoint), undefined)
    if (metadata.registration_endpoint)
      validateManagedHttpUrl(new URL(metadata.registration_endpoint), undefined)
  } catch {
    return undefined
  }
  return metadata
}

function buildDcrClientMetadata(redirectUri: string): OAuthClientMetadata {
  return {
    redirect_uris: [redirectUri],
    client_name: 'Agnes',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }
}

/**
 * The long-lived credential this module persists through caller-supplied callbacks (never through
 * `credential-store.ts` directly - `createAgnesOAuthClientProvider` takes plain `read`/`write`
 * functions so it can be unit-tested with an in-memory fake, per the Task 3 brief's hard
 * requirement). Deliberately camelCase and decoupled from `packages/host`'s own `OAuthCredential`
 * shape (which has a *required* `refreshToken`): a real authorization server is not guaranteed to
 * issue a refresh token (RFC 6749 makes it optional), and forcing that field to be required here
 * would make this module either fabricate one or throw on a legitimate response. Reconciling this
 * shape with `packages/host`'s persisted envelope is left to whichever task actually wires
 * `credential-store.ts` underneath these callbacks.
 */
export type OAuthCredential = Readonly<{
  accessToken: string
  refreshToken?: string | undefined
  tokenType: string
  /** Absolute epoch ms, converted from the token response's relative `expires_in` at save time. */
  expiresAt?: number | undefined
  scope?: string | undefined
}>

export type OAuthCredentialCallbacks = Readonly<{
  read(): Promise<OAuthCredential | undefined>
  write(value: OAuthCredential): Promise<void>
}>

export type CreateAgnesOAuthClientProviderOptions = Readonly<{
  /** Already resolved, e.g. via `registerOAuthClient` (or a user-supplied static client_id). This
   * provider never re-runs discovery/registration itself. */
  clientId: string
  clientSecret?: string
  redirectUri: string
  credentials: OAuthCredentialCallbacks
}>

/**
 * The SDK's `OAuthClientProvider` plus one Agnes-specific extension: `authorizationUrl`, the
 * escape hatch `redirectToAuthorization` uses instead of navigating anywhere (see below).
 */
export interface AgnesOAuthClientProvider extends OAuthClientProvider {
  /** Set by the most recent `redirectToAuthorization()` call; undefined until then. */
  readonly authorizationUrl: URL | undefined
}

/**
 * Builds an `OAuthClientProvider` for the SDK's `auth()`/`startAuthorization()`/`fetchToken()`
 * functions to drive the authorization_code flow against one MCP server, backed entirely by the
 * caller-supplied `credentials` callbacks (see `OAuthCredential`'s doc comment for why this is not
 * `packages/host`'s `credential-store.ts` shape) and an already-resolved client_id.
 *
 * `redirectToAuthorization` deliberately does nothing browser-like: this runs inside a headless
 * daemon process with no user-agent to hand a URL to. It only records the URL on
 * `provider.authorizationUrl` for the caller (the daemon's HTTP layer, out of this task's scope)
 * to read back and hand to the user out-of-band - never opens a browser, never writes to stdout
 * expecting interaction.
 *
 * `state()` is intentionally left unimplemented (it is optional on `OAuthClientProvider`): signing
 * and verifying the `state` parameter is Task 2's `sealOAuthState`/`openOAuthState`, which need a
 * signing secret, a nonce and a `serverId` this provider is never given (by design - it has no
 * business holding a signing secret). Whoever drives the actual authorization_code flow supplies
 * `state` at a layer above this provider, not through it.
 *
 * `codeVerifier()`/`saveCodeVerifier()` are backed by a private in-memory field, valid only for
 * this provider instance's lifetime. That is sufficient for a single request/response cycle within
 * one daemon process; a flow that must survive a process boundary already carries `codeVerifier`
 * through the signed `OAuthStatePayload` round-trip (Task 2's `OAuthStatePayload.codeVerifier`)
 * instead, and the caller re-seeds it via `saveCodeVerifier()` before resuming.
 */
export function createAgnesOAuthClientProvider(
  opts: CreateAgnesOAuthClientProviderOptions,
): AgnesOAuthClientProvider {
  let capturedAuthorizationUrl: URL | undefined
  let pendingCodeVerifier: string | undefined

  return {
    get redirectUrl(): string {
      return opts.redirectUri
    },

    get clientMetadata(): OAuthClientMetadata {
      return {
        redirect_uris: [opts.redirectUri],
        client_name: 'Agnes',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: opts.clientSecret ? 'client_secret_post' : 'none',
      }
    },

    clientInformation() {
      return { client_id: opts.clientId, client_secret: opts.clientSecret }
    },

    async tokens(): Promise<OAuthTokens | undefined> {
      const credential = await opts.credentials.read()
      return credential ? credentialToTokens(credential) : undefined
    },

    async saveTokens(tokens: OAuthTokens): Promise<void> {
      await opts.credentials.write(tokensToCredential(tokens))
    },

    redirectToAuthorization(authorizationUrl: URL): void {
      capturedAuthorizationUrl = authorizationUrl
    },

    saveCodeVerifier(codeVerifier: string): void {
      pendingCodeVerifier = codeVerifier
    },

    codeVerifier(): string {
      if (pendingCodeVerifier === undefined) {
        throw new Error('no PKCE code verifier saved for this authorization flow')
      }
      return pendingCodeVerifier
    },

    get authorizationUrl(): URL | undefined {
      return capturedAuthorizationUrl
    },
  }
}

function tokensToCredential(tokens: OAuthTokens): OAuthCredential {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    tokenType: tokens.token_type,
    expiresAt: tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000,
    scope: tokens.scope,
  }
}

function credentialToTokens(credential: OAuthCredential): OAuthTokens {
  return {
    access_token: credential.accessToken,
    refresh_token: credential.refreshToken,
    token_type: credential.tokenType,
    expires_in:
      credential.expiresAt === undefined
        ? undefined
        : Math.max(0, Math.round((credential.expiresAt - Date.now()) / 1000)),
    scope: credential.scope,
  }
}
