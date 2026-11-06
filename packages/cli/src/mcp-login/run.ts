import { randomBytes, randomUUID } from 'node:crypto'
import type { McpServerDefinitionInput, McpServerDescriptor } from '@agnes/protocol'
import {
  beginMcpOAuthLogin,
  guardedOAuthFetch,
  McpOAuthDiscoveryFailed,
  type McpOAuthSummary,
} from '@agnes/resource-control-runtime'
import type { NodeClient } from '@agnes/sdk'
import { openMcpLoginBrowser } from './browser.js'
import { type LoopbackCallback, startLoopbackCallback } from './loopback.js'
import { parsePastedCallback } from './paste.js'

/** How long a sign-in waits for the browser or a paste. */
export const MCP_LOGIN_TIMEOUT_MS = 5 * 60_000
const OPERATION_POLLS = 300
const OPERATION_POLL_MS = 100

type FetchLike = NonNullable<Parameters<typeof beginMcpOAuthLogin>[0]['fetchImpl']>

/** Where a sign-in shows its address and progress, and reads a pasted callback address. */
export type McpLoginUi = Readonly<{
  show(input: { serverId: string; authorizationUrl: string }): void
  /** The pasted text; undefined when nothing can be pasted (wait for the browser only). Stops when `signal` aborts. */
  paste(signal: AbortSignal): Promise<string | undefined>
  progress(text: string): void
}>

export type McpLoginOutcome = Readonly<{
  kind: 'signed-in' | 'already-signed-in' | 'cancelled' | 'timed-out'
  /** The sign-in is saved, but the server could not be brought up with it; says why. */
  reconnectFailed?: string
}>

/** A sign-in that cannot go on; the message is meant for the user. */
export class McpLoginError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpLoginError'
  }
}

/** A daemon refusal or a sign-in failure, in one plain sentence. */
export function mcpLoginFailureText(serverId: string, error: unknown): string {
  if (error instanceof McpOAuthDiscoveryFailed) return discoveryFailed(serverId)
  const data = (error as { data?: { reason?: unknown; code?: unknown; method?: unknown } } | null)?.data
  switch (data?.reason ?? data?.code) {
    case 'MCP_OAUTH_LOGIN_SUPERSEDED':
      return `"${serverId}" was signed out during sign-in; run the command again`
    case 'MCP_OAUTH_LOGIN_ENDPOINT_CHANGED':
      return `the OAuth settings of "${serverId}" changed during sign-in; run the command again`
    case 'MCP_OAUTH_DISCOVERY_FAILED':
      return discoveryFailed(serverId)
    case 'MCP_OAUTH_GRANT_REJECTED':
      return 'the authorization server refused the sign-in code (it may have expired or been used); run the command again'
    case 'MCP_OAUTH_CLIENT_AUTH_UNSUPPORTED':
      return `the authorization server of "${serverId}" requires a client authentication method AGH does not support: ${String(data?.method ?? 'unknown')}`
    case 'MCP_OAUTH_SERVER_UNAVAILABLE':
      return `"${serverId}" is not an HTTP server that can sign in with OAuth`
    case 'CONFIG_CREDENTIAL_NOT_FOUND':
      return `the client secret of "${serverId}" is not in the credential store; save it under its secret:// reference and try again`
  }
  return error instanceof Error ? error.message : String(error)
}

const discoveryFailed = (serverId: string) =>
  `the OAuth settings of "${serverId}" could not be read from the server; check its address and try again`

/**
 * Signs in to one MCP server from this process: a saved sign-in is refreshed first (unless more
 * scope is needed); otherwise the browser sign-in runs with a loopback callback and a paste of the
 * callback address, whichever comes first, for up to 5 minutes. The daemon exchanges the code and
 * stores the sign-in; a server without credentials becomes an OAuth server; then the server is
 * reconnected so the sign-in takes effect.
 */
export async function runMcpLogin(input: {
  client: NodeClient
  profile: string
  serverId: string
  ui: McpLoginUi
  signal: AbortSignal
  fetchImpl?: FetchLike
  openBrowser?: (url: string) => void
  timeoutMs?: number
}): Promise<McpLoginOutcome> {
  const { client, profile, serverId, ui } = input
  const descriptor = await httpServer(client, profile, serverId)
  const summary: McpOAuthSummary = await client.request('_agnes/v1/admin.mcp.oauth.get', {
    profile,
    serverId,
  })
  if (summary.refreshable && summary.requiredScope.length === 0) {
    ui.progress(`Refreshing the saved sign-in of ${serverId}`)
    const { signedIn } = await daemonStep(serverId, () =>
      client.request('_agnes/v1/admin.mcp.oauth.refresh', { profile, serverId }),
    )
    if (signedIn) return { kind: 'already-signed-in', ...(await afterSignIn(input, descriptor)) }
  }
  const done = new AbortController()
  const stop = () => done.abort()
  input.signal.addEventListener('abort', stop, { once: true })
  if (input.signal.aborted) stop()
  // Checked by this process only; 32 random bytes, like the PKCE verifier.
  const state = randomBytes(32).toString('base64url')
  let listener: LoopbackCallback | undefined
  try {
    listener = await startLoopbackCallback({
      ...callbackPort(descriptor, summary),
      state,
      signal: done.signal,
    })
    return await browserSignIn(input, { descriptor, summary, listener, state }, done.signal)
  } finally {
    stop()
    input.signal.removeEventListener('abort', stop)
    await listener?.close()
  }
}

type LoginInput = Parameters<typeof runMcpLogin>[0]
type Attempt = Readonly<{
  descriptor: McpServerDescriptor
  summary: McpOAuthSummary
  listener: LoopbackCallback
  state: string
}>

async function browserSignIn(
  input: LoginInput,
  attempt: Attempt,
  signal: AbortSignal,
): Promise<McpLoginOutcome> {
  const { client, profile, serverId, ui } = input
  const { descriptor, summary, listener, state } = attempt
  const { transport, secretBinding } = descriptor.definition
  const binding = secretBinding.kind === 'oauth' ? secretBinding : undefined
  const start = await daemonStep(serverId, () =>
    beginMcpOAuthLogin({
      serverId,
      serverUrl: new URL((transport as { url: string }).url),
      ...(binding?.staticClientId ? { staticClientId: binding.staticClientId } : {}),
      summary,
      redirectUri: listener.redirectUri,
      fetchImpl: input.fetchImpl ?? guardedOAuthFetch,
    }),
  )
  if ('pendingClientId' in start)
    throw new McpLoginError(
      `the authorization server of "${serverId}" does not register clients by itself; add a client ID to the server (agh mcp update ${serverId} ... --oauth-client-id <id>) and sign in again`,
    )
  start.authorizationUrl.searchParams.set('state', state)
  const authorizationUrl = start.authorizationUrl.href
  ui.show({ serverId, authorizationUrl })
  ;(input.openBrowser ?? openMcpLoginBrowser)(authorizationUrl)

  const got = await firstCode(input, listener, state, signal)
  if (got === 'cancelled' || got === 'timed-out') {
    listener.finish(got === 'cancelled' ? 'cancelled' : 'state-expired')
    return { kind: got }
  }
  ui.progress(`Completing the sign-in of ${serverId}`)
  try {
    await client.request('_agnes/v1/admin.mcp.oauth.complete', {
      profile,
      serverId,
      expectedEpoch: start.expectedEpoch,
      code: got.code,
      codeVerifier: start.codeVerifier,
      redirectUri: listener.redirectUri,
      client: { ...start.client },
      requestedScope: [...start.requestedScope],
      authorization: { ...start.authorization },
    })
  } catch (error) {
    const text = mcpLoginFailureText(serverId, error)
    listener.finish('failed', text)
    throw new McpLoginError(text)
  }
  listener.finish('signed-in')
  return { kind: 'signed-in', ...(await afterSignIn(input, descriptor)) }
}

/** The browser's callback, a pasted address, the timeout or a cancel, whichever comes first. */
async function firstCode(
  input: LoginInput,
  listener: LoopbackCallback,
  state: string,
  signal: AbortSignal,
): Promise<Readonly<{ code: string }> | 'cancelled' | 'timed-out'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise((resolve, reject) => {
      if (signal.aborted) return resolve('cancelled')
      timer = setTimeout(() => resolve('timed-out'), input.timeoutMs ?? MCP_LOGIN_TIMEOUT_MS)
      signal.addEventListener('abort', () => resolve('cancelled'), { once: true })
      listener.code.then((code) => resolve({ code }), reject)
      input.ui
        .paste(signal)
        .then((text) => {
          // Nothing can be pasted here: only the browser can finish the sign-in.
          if (text === undefined || signal.aborted) return
          const pasted = parsePastedCallback(text, { redirectUri: listener.redirectUri, state })
          resolve(pasted === 'cancel' ? 'cancelled' : pasted)
        })
        .catch(reject)
    })
  } finally {
    clearTimeout(timer)
  }
}

/** Reads the server and refuses one that cannot sign in with OAuth. */
async function httpServer(
  client: NodeClient,
  profile: string,
  serverId: string,
): Promise<McpServerDescriptor> {
  const descriptor = await client.mcp.servers.get({ profile, serverId })
  const { transport, secretBinding } = descriptor.definition
  if (transport.kind === 'stdio') throw new McpLoginError(`"${serverId}" is not an HTTP server`)
  if (secretBinding.kind !== 'oauth' && secretBinding.kind !== 'none')
    throw new McpLoginError(
      `"${serverId}" uses a saved bearer or header credential; OAuth sign-in does not apply to it`,
    )
  return descriptor
}

/** The server's fixed callback port, else the port a stored registration was made for, else any. */
function callbackPort(
  descriptor: McpServerDescriptor,
  summary: McpOAuthSummary,
): Readonly<{ port: number; fixedPort: boolean }> {
  const binding = descriptor.definition.secretBinding
  if (binding.kind === 'oauth' && binding.callbackPort !== undefined)
    return { port: binding.callbackPort, fixedPort: true }
  try {
    const stored = summary.client ? new URL(summary.client.redirectUri) : undefined
    if (stored?.hostname === 'localhost' && stored.pathname === '/callback' && stored.port)
      return { port: Number(stored.port), fixedPort: false }
  } catch {
    // A stored address that is not a URL is simply not reused.
  }
  return { port: 0, fixedPort: false }
}

/** Runs a step whose failure the user should read as a sentence. */
async function daemonStep<T>(serverId: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step()
  } catch (error) {
    throw new McpLoginError(mcpLoginFailureText(serverId, error))
  }
}

/**
 * A server without credentials becomes an OAuth server; the sign-in is marked authorized; the
 * server is reconnected, since a signed-out server stays down until then. A failure after the
 * sign-in was saved is returned, not thrown, so the sign-in still counts.
 */
async function afterSignIn(
  input: LoginInput,
  descriptor: McpServerDescriptor,
): Promise<Pick<McpLoginOutcome, 'reconnectFailed'>> {
  const { client, profile, serverId, ui } = input
  try {
    if (descriptor.definition.secretBinding.kind === 'none') {
      ui.progress(`Switching ${serverId} to OAuth sign-in`)
      await settled(
        client,
        profile,
        await client.mcp.servers.update({
          profile,
          serverId,
          expectedRevision: descriptor.revision,
          // An HTTP or SSE definition (checked on entry); only the credential kind changes.
          definition: {
            ...descriptor.definition,
            secretBinding: { kind: 'oauth' },
          } as McpServerDefinitionInput,
          clientId: await client.clientId(),
          commandId: `mcp-oauth-binding-${randomUUID()}`,
        }),
      )
    }
    // Best effort, like the web sign-in: the reconnect below reports the state anyway.
    await client.mcp.servers.oauth
      .statusSet({ profile, serverId, status: 'authorized' })
      .catch(() => undefined)
    ui.progress(`Reconnecting ${serverId}`)
    const current = await client.mcp.servers.get({ profile, serverId })
    await settled(
      client,
      profile,
      await client.mcp.servers.reconnect({
        profile,
        serverId,
        expectedRevision: current.revision,
        clientId: await client.clientId(),
        commandId: `mcp-oauth-reconnect-${randomUUID()}`,
      }),
    )
    return {}
  } catch (error) {
    return { reconnectFailed: error instanceof Error ? error.message : String(error) }
  }
}

/** Waits for a resource operation to end; a failed or cancelled one throws its safe error. */
async function settled(
  client: NodeClient,
  profile: string,
  receipt: Readonly<{ operationId: string }>,
): Promise<void> {
  for (let poll = 0; poll < OPERATION_POLLS; poll++) {
    const operation = await client.resources.operation.get({ profile, operationId: receipt.operationId })
    if (operation.state === 'succeeded') return
    if (operation.state === 'failed' || operation.state === 'cancelled')
      throw new Error(operation.lastSafeError?.message ?? `the operation was ${operation.state}`)
    await new Promise<void>((resolve) => setTimeout(resolve, OPERATION_POLL_MS))
  }
  throw new Error('the operation is still running; check it with agh mcp status')
}

/**
 * Forgets the stored sign-in (nothing is revoked at the authorization server), then closes the
 * server's live connection, so no request carries the old token.
 */
export async function runMcpLogout(input: {
  client: NodeClient
  profile: string
  serverId: string
}): Promise<void> {
  const { client, profile, serverId } = input
  const descriptor = await httpServer(client, profile, serverId)
  await daemonStep(serverId, () => client.request('_agnes/v1/admin.mcp.oauth.logout', { profile, serverId }))
  // Only an OAuth server has a connection that uses the sign-in.
  if (descriptor.definition.secretBinding.kind !== 'oauth') return
  await settled(
    client,
    profile,
    await client.mcp.servers.oauth.signOut({
      profile,
      serverId,
      expectedRevision: descriptor.revision,
      clientId: await client.clientId(),
      commandId: `mcp-oauth-sign-out-${randomUUID()}`,
    }),
  )
}
