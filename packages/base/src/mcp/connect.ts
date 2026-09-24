import { type CloseObservableTransport, observeTransportDisconnect } from '@agnes/mcp-transport-health'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
// SSEClientTransport is the legacy pre-2025-03-26 MCP SSE transport. The SDK marks it @deprecated in
// favor of Streamable HTTP, but it is deliberately kept here as a backward-compat path for remote
// servers that still only speak SSE -- not an oversight.
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import {
  getDefaultEnvironment,
  StdioClientTransport,
  type StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ElicitRequestSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import type { McpServerConfig } from './config.js'
import type { McpConnection } from './register.js'

type SdkTool = {
  name: string
  description?: string | undefined
  inputSchema: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean | undefined } | undefined
}
type SdkTransport = CloseObservableTransport
type SdkClient = {
  setElicitationHandler(handler: () => { action: 'decline' }): void
  /** Fires on the server's `notifications/tools/list_changed`. Set once; a client that reconnects
   * gets a fresh SdkClient (and so a fresh handler registration) rather than resubscribing. */
  setToolListChangedHandler(handler: () => void): void
  connect(transport: SdkTransport): Promise<void>
  listTools(params?: { cursor?: string }): Promise<{ tools: SdkTool[]; nextCursor?: string | undefined }>
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    schema: undefined,
    options: { signal: AbortSignal },
  ): Promise<{ content: unknown[]; isError?: boolean | undefined }>
  close(): Promise<void>
}

export type McpSdkDeps = {
  createClient(): SdkClient
  createStdioTransport(params: StdioServerParameters): SdkTransport
  createHttpTransport(url: URL, init?: { headers?: Record<string, string>; fetch?: FetchLike }): SdkTransport
  createSseTransport(url: URL, init?: { requestInit?: RequestInit; fetch?: FetchLike }): SdkTransport
  defaultEnvironment(): Record<string, string>
}

export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 10_000
export const DEFAULT_MCP_CATALOG_TIMEOUT_MS = 10_000
export const MAX_MCP_CATALOG_PAGES = 32
export const MAX_MCP_CATALOG_TOOLS = 1_000
// A redirect chain this long is never a legitimate gateway/load-balancer hop and only serves to
// stall the connect timeout or loop forever; 5 mirrors curl/browser fetch's conventional cap.
export const MAX_MCP_REDIRECTS = 5
// The actual HTTP redirect status set. A plain range check (300 <= status < 400) also catches 304
// Not Modified and other non-redirect 3xx codes that may legally carry an unrelated Location header.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
// Per the Fetch spec, 303 downgrades every method except GET/HEAD to a bodyless GET (the MCP SDK's
// only non-GET/POST method is the DELETE `terminateSession()` issues); 301 and 302 conventionally
// downgrade only a POST (legacy browser behavior every mainstream HTTP client still follows). 307
// and 308 are deliberately excluded from all of this: they preserve the original method and body.
const METHOD_DOWNGRADE_STATUSES = new Set([301, 302, 303])
const METHOD_DOWNGRADE_ANY_NON_GET_STATUS = 303
// Never follow these across an origin change: the bearer/session credential this connection was
// configured with, plus anything that could carry ambient auth. httpTransport() adds this server's
// own configured credential header name(s) (e.g. a custom `x-api-key`) on top of this fixed set.
const CROSS_ORIGIN_STRIPPED_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'mcp-session-id',
])

function aborted(): DOMException {
  return new DOMException('MCP operation aborted', 'AbortError')
}

function headerEntries(headers: HeadersInit | undefined): Array<[string, string]> {
  if (!headers) return []
  if (headers instanceof Headers) return [...headers.entries()]
  if (Array.isArray(headers)) return headers.map(([name, value]) => [name, value] as [string, string])
  return Object.entries(headers)
}

function withoutHeaders(headers: HeadersInit | undefined, drop: ReadonlySet<string>): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [name, value] of headerEntries(headers)) if (!drop.has(name.toLowerCase())) kept[name] = value
  return kept
}

/**
 * Wraps the real fetch with manual redirect handling. Two independent checks run on every hop,
 * because they catch different things:
 *  - `validateRedirectUrl` -- the same managed-transport policy already applied to the configured
 *    URL -- answers "is this host/scheme ever acceptable for a managed MCP server", closing the SSRF
 *    gap where a compromised server bounces the connection to a host policy would have refused
 *    outright. A caller with no policy to apply (`validateRedirectUrl` undefined) gets the prior
 *    strict behavior: any redirect is refused.
 *  - The origin comparison below answers "is this the same party the user handed the credential to".
 *    A redirect target can pass the general host/scheme policy (any HTTPS host does) while still
 *    being a different, untrusted party -- e.g. an attacker's own HTTPS endpoint -- so the
 *    Authorization/session/custom-credential headers are stripped on any hop that crosses an origin
 *    boundary. A same-origin hop (the path-rewrite case this fix exists for) keeps every header.
 */
function policedHttpFetch(
  serverId: string,
  validateRedirectUrl: ((url: URL) => void) | undefined,
  credentialHeaderNames: ReadonlySet<string>,
): FetchLike {
  const strippedOnCrossOrigin = new Set([...CROSS_ORIGIN_STRIPPED_HEADERS, ...credentialHeaderNames])
  return async (input, init) => {
    const originalOrigin = (input instanceof URL ? input : new URL(String(input))).origin
    let url = input instanceof URL ? input : new URL(String(input))
    let requestInit = init
    let redirectsFollowed = 0
    for (;;) {
      // Deliberately per-hop, not sticky: `crossOrigin` compares this hop's target against the
      // *original* origin every time, recomputed from the untouched `requestInit`/`init`, rather
      // than latching "once cross-origin, always stripped" once a chain leaves the original origin
      // (which is what browsers do for Authorization on a redirect chain). A chain that bounces
      // A -> B (stripped) -> back to A therefore has its credential restored on the third hop. That
      // is safe here specifically because the credential only ever reaches the origin it was
      // configured for in the first place -- it is never handed to B, and A is where the caller
      // already intended it to go -- so there is no additional party the credential could leak to.
      const crossOrigin = url.origin !== originalOrigin
      const hopInit: RequestInit = crossOrigin
        ? { ...requestInit, headers: withoutHeaders(requestInit?.headers, strippedOnCrossOrigin) }
        : { ...requestInit }
      const response = await fetch(url, { ...hopInit, redirect: 'manual' })
      const location = response.headers.get('location')
      const isRedirect = REDIRECT_STATUSES.has(response.status) && location !== null
      if (!isRedirect) return response
      if (redirectsFollowed >= MAX_MCP_REDIRECTS) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error(`MCP server ${serverId} exceeded the maximum of ${MAX_MCP_REDIRECTS} HTTP redirects`)
      }
      let target: URL
      try {
        target = new URL(location as string, url)
      } catch (error) {
        await response.body?.cancel().catch(() => undefined)
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(
          `MCP server ${serverId} sent an HTTP redirect with an invalid Location header ` +
            `${JSON.stringify(location)}: ${reason}`,
        )
      }
      if (!validateRedirectUrl) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error(
          `MCP server ${serverId} returned an HTTP redirect to ${target.href}; redirects are not permitted`,
        )
      }
      validateRedirectUrl(target)
      await response.body?.cancel().catch(() => undefined)
      redirectsFollowed += 1
      // The downgrade is a protocol fact about this hop's method/body, not about trust, so it
      // persists in `requestInit` for every later hop rather than being recomputed like the
      // per-hop credential stripping above.
      const hopMethod = (hopInit.method ?? 'GET').toUpperCase()
      const downgrades = METHOD_DOWNGRADE_STATUSES.has(response.status)
        ? response.status === METHOD_DOWNGRADE_ANY_NON_GET_STATUS
          ? hopMethod !== 'GET' && hopMethod !== 'HEAD'
          : hopMethod === 'POST'
        : false
      if (downgrades) {
        // Drop `body` entirely (not `body: undefined`) -- exactOptionalPropertyTypes distinguishes
        // "key absent" from "key present with value undefined", and fetch's RequestInit only
        // accepts the former for a bodyless request.
        const { body: _droppedBody, ...withoutBody } = requestInit ?? {}
        requestInit = {
          ...withoutBody,
          method: 'GET',
          headers: withoutHeaders(requestInit?.headers, new Set(['content-type', 'content-length'])),
        }
      }
      url = target
    }
  }
}

async function bounded<T>(
  operation: Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number },
): Promise<T> {
  const timeoutMs = options.timeoutMs
  if (options.signal?.aborted) throw aborted()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await new Promise<T>((resolve, reject) => {
      onAbort = () => reject(aborted())
      options.signal?.addEventListener('abort', onAbort, { once: true })
      if (timeoutMs !== undefined)
        timer = setTimeout(() => reject(new Error('MCP operation timed out')), timeoutMs)
      operation.then(resolve, reject)
    })
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) options.signal?.removeEventListener('abort', onAbort)
  }
}

const realSdk: McpSdkDeps = {
  createClient: () => {
    const client = new Client({ name: 'agnes', version: '0.0.0' }, { capabilities: { elicitation: {} } })
    return {
      setElicitationHandler: (handler) => client.setRequestHandler(ElicitRequestSchema, handler),
      setToolListChangedHandler: (handler) =>
        client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
          handler()
        }),
      connect: (transport) => client.connect(transport as Parameters<typeof client.connect>[0]),
      async listTools(params) {
        const page = await client.listTools(params)
        return {
          tools: page.tools.map((tool) => ({
            name: tool.name,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            inputSchema: tool.inputSchema,
            ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
          })),
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        }
      },
      async callTool(params, schema, options) {
        const result = await client.callTool(params, schema, options)
        const content = (result as { content?: unknown }).content
        const isError = (result as { isError?: unknown }).isError
        if (!Array.isArray(content)) throw new TypeError('MCP tool result content is not an array')
        if (isError !== undefined && typeof isError !== 'boolean')
          throw new TypeError('MCP tool result isError is not a boolean')
        return {
          content,
          ...(isError === undefined ? {} : { isError }),
        }
      },
      close: () => client.close(),
    }
  },
  createStdioTransport: (params) => new StdioClientTransport(params),
  createHttpTransport: (url, init) =>
    new StreamableHTTPClientTransport(
      url,
      init === undefined
        ? undefined
        : {
            ...(init.headers === undefined ? {} : { requestInit: { headers: init.headers } }),
            ...(init.fetch === undefined ? {} : { fetch: init.fetch }),
          },
    ),
  // SSEClientTransportOptions already takes { requestInit, fetch } directly, so unlike
  // createHttpTransport above, no headers -> requestInit adaptation is needed here.
  createSseTransport: (url, init) => new SSEClientTransport(url, init),
  defaultEnvironment: getDefaultEnvironment,
}

function stdioTransport(cfg: McpServerConfig, deps: McpSdkDeps): SdkTransport {
  const [command, ...args] = cfg.cmd ?? []
  if (!command) throw new TypeError(`MCP server ${cfg.id} has no stdio cmd`)
  return deps.createStdioTransport({
    command,
    args,
    env: { ...(cfg.baseEnv ?? deps.defaultEnvironment()), ...(cfg.env ?? {}) },
  })
}

function httpTransport(
  cfg: McpServerConfig,
  deps: McpSdkDeps,
  validateRedirectUrl: ((url: URL) => void) | undefined,
): SdkTransport {
  if (!cfg.url) throw new TypeError(`MCP server ${cfg.id} has no http url`)
  const url = new URL(cfg.url)
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new TypeError(`MCP server ${cfg.id} url must use http or https`)
  // Every header this config carries is credential-derived (resolvedConfig only ever populates it
  // from a resolved SecretRef), so its own key names are exactly the extra headers a cross-origin
  // redirect hop must not carry -- whatever name the http-header secret binding was configured with.
  const credentialHeaderNames = new Set(Object.keys(cfg.headers ?? {}).map((name) => name.toLowerCase()))
  return deps.createHttpTransport(url, {
    ...(cfg.headers === undefined ? {} : { headers: { ...cfg.headers } }),
    fetch: policedHttpFetch(cfg.id, validateRedirectUrl, credentialHeaderNames),
  })
}

/**
 * The legacy SSE transport's connection-safety needs are identical to httpTransport()'s above -- same
 * URL/scheme validation, same cross-origin credential-header stripping, same managed-redirect-policy
 * re-check -- so this deliberately calls the exact same policedHttpFetch() rather than growing a
 * parallel, independently-maintained copy of that redirect/credential logic for SSE.
 *
 * One SSE-specific attack surface `policedHttpFetch` and `validateRedirectUrl` do NOT cover: the
 * POST message endpoint is sent by the SERVER in-band, via the SSE `endpoint` event -- it is not a
 * redirect (`validateRedirectUrl` only fires on a 3xx hop) and it is not cross-origin relative to
 * itself (`policedHttpFetch`'s origin check anchors each fetch call to that call's OWN initial URL,
 * so a malicious `endpoint` URL is "same-origin" by definition on the fetch it starts). The only
 * thing standing between a malicious/compromised SSE server and redirecting the credentialed POST to
 * an arbitrary third-party origin is the MCP SDK's OWN same-origin check, internal to
 * `SSEClientTransport` (`@modelcontextprotocol/sdk`'s `client/sse.js`, around the line that compares
 * `this._endpoint.origin` to `this._url.origin` and throws on a mismatch -- verified present and
 * effective in the installed 1.25.2 build as of this plan). This repo has no test or redirect-policy
 * code that would catch a regression here: if a future SDK upgrade weakens or removes that check, or
 * a caller starts passing `eventSourceInit`/a custom endpoint override that bypasses it, this
 * function's safety argument silently degrades with no compiler or test signal. Re-verify this
 * SDK-internal check any time `@modelcontextprotocol/sdk` is upgraded.
 */
function sseTransport(
  cfg: McpServerConfig,
  deps: McpSdkDeps,
  validateRedirectUrl: ((url: URL) => void) | undefined,
): SdkTransport {
  if (!cfg.url) throw new TypeError(`MCP server ${cfg.id} has no sse url`)
  const url = new URL(cfg.url)
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new TypeError(`MCP server ${cfg.id} url must use http or https`)
  // Same reasoning as httpTransport() above: every header this config carries is credential-derived,
  // so its key names are exactly what a cross-origin redirect hop must not carry.
  const credentialHeaderNames = new Set(Object.keys(cfg.headers ?? {}).map((name) => name.toLowerCase()))
  return deps.createSseTransport(url, {
    ...(cfg.headers === undefined ? {} : { requestInit: { headers: { ...cfg.headers } } }),
    fetch: policedHttpFetch(cfg.id, validateRedirectUrl, credentialHeaderNames),
  })
}

function callArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('MCP tool arguments must be an object')
  return value as Record<string, unknown>
}

function callContent(
  value: unknown,
): { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string } {
  if (typeof value !== 'object' || value === null) throw new TypeError('unsupported content from MCP server')
  const item = value as Record<string, unknown>
  if (item.type === 'text' && typeof item.text === 'string') return { type: 'text', text: item.text }
  if (item.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string')
    return { type: 'image', data: item.data, mimeType: item.mimeType }
  throw new TypeError(`unsupported content from MCP server: ${String(item.type)}`)
}

/** Opens one trusted-profile MCP server directly; stdio intentionally does not pass through sandbox. */
export async function connectMcp(
  cfg: McpServerConfig,
  deps: McpSdkDeps = realSdk,
  options: {
    signal?: AbortSignal
    connectTimeoutMs?: number
    catalogTimeoutMs?: number
    /**
     * Re-checks an HTTP redirect target with the same managed-transport policy the caller already
     * applied to the configured URL, before the transport follows it. Omitted, any redirect is
     * refused -- following one blind is the SSRF gap this option exists to close.
     */
    validateRedirectUrl?: (url: URL) => void
  } = {},
): Promise<McpConnection> {
  // Exhaustive over McpServerConfig's transport discriminant (currently 'stdio' | 'http' | 'sse'):
  // mirrors validateManagedTransport()'s switch+never pattern in
  // resource-control-runtime/src/mcp.ts, so a fourth transport kind fails loudly here too, instead
  // of a three-way ternary's implicit "else" silently routing it through Streamable HTTP the way
  // resolvedConfig() once did before that was fixed one layer up.
  let transport: SdkTransport
  switch (cfg.transport) {
    case 'stdio':
      transport = stdioTransport(cfg, deps)
      break
    case 'http':
      transport = httpTransport(cfg, deps, options.validateRedirectUrl)
      break
    case 'sse':
      transport = sseTransport(cfg, deps, options.validateRedirectUrl)
      break
    default: {
      const exhaustive: never = cfg.transport
      throw new TypeError(`unsupported MCP transport kind: ${JSON.stringify(exhaustive)}`)
    }
  }
  const client = deps.createClient()
  client.setElicitationHandler(() => ({ action: 'decline' }))
  try {
    await bounded(client.connect(transport), {
      timeoutMs: options.connectTimeoutMs ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (error) {
    await client.close().catch(() => undefined)
    throw error
  }

  let closed = false
  const closeListeners = new Set<() => void>()
  const reportUnexpectedClose = (): void => {
    if (closed) return
    for (const listener of [...closeListeners]) listener()
  }
  // Client.connect installs its own transport callbacks. Chain them after the handshake so SDK
  // request bookkeeping remains intact while resource lifecycle can observe an unexpected disconnect.
  const stopTransportHealth = observeTransportDisconnect(transport, reportUnexpectedClose)
  const toolsChangedListeners = new Set<() => void>()
  client.setToolListChangedHandler(() => {
    if (closed) return
    for (const listener of [...toolsChangedListeners]) listener()
  })
  return {
    id: cfg.id,
    async listTools(listOptions = {}) {
      const tools: Awaited<ReturnType<McpConnection['listTools']>> = []
      const cursors = new Set<string>()
      let cursor: string | undefined
      for (;;) {
        const page = await bounded(client.listTools(cursor === undefined ? undefined : { cursor }), {
          timeoutMs: listOptions.timeoutMs ?? options.catalogTimeoutMs ?? DEFAULT_MCP_CATALOG_TIMEOUT_MS,
          ...(listOptions.signal === undefined ? {} : { signal: listOptions.signal }),
        })
        for (const tool of page.tools)
          tools.push({
            name: tool.name,
            description: tool.description ?? '',
            inputSchema: tool.inputSchema,
            ...(typeof tool.annotations?.readOnlyHint === 'boolean'
              ? { annotations: { readOnlyHint: tool.annotations.readOnlyHint } }
              : {}),
          })
        if (tools.length > MAX_MCP_CATALOG_TOOLS) throw new Error('MCP tool catalog exceeds Host limit')
        if (page.nextCursor === undefined) return tools
        if (cursors.has(page.nextCursor) || cursors.size >= MAX_MCP_CATALOG_PAGES)
          throw new Error(`MCP server ${cfg.id} returned a cyclic tool cursor`)
        cursors.add(page.nextCursor)
        cursor = page.nextCursor
      }
    },
    async callTool(name, args, opts) {
      const result = await client.callTool({ name, arguments: callArguments(args) }, undefined, {
        signal: opts.signal,
      })
      const content = result.content.map(callContent)
      return result.isError === true ? { content, isError: true } : { content }
    },
    async close() {
      if (closed) return
      closed = true
      stopTransportHealth()
      closeListeners.clear()
      toolsChangedListeners.clear()
      await client.close()
    },
    onClose(listener) {
      if (closed) {
        queueMicrotask(listener)
        return () => undefined
      }
      closeListeners.add(listener)
      return () => closeListeners.delete(listener)
    },
    onToolsChanged(listener) {
      if (closed) return () => undefined
      toolsChangedListeners.add(listener)
      return () => toolsChangedListeners.delete(listener)
    },
  }
}
