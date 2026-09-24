import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
/**
 * Consumption-only port for Base's MCP library (packages/base/src/mcp). Host neither constructs an MCP client nor imports a
 * package implementation: composition injects Base connectMcp/inspectRemoteCatalog.
 */
export type McpServerConfig = {
  id: string
  transport: 'stdio' | 'http' | 'sse'
  cmd?: string[]
  url?: string
  baseEnv?: Record<string, string>
  env?: Record<string, string>
  headers?: Record<string, string>
  allowedTools?: readonly string[]
  defer: boolean
}
export type McpRemoteTool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean }
}
export type McpConnection = {
  id: string
  listTools(): Promise<McpRemoteTool[]>
  callTool(
    name: string,
    args: unknown,
    opts: { signal: AbortSignal },
  ): Promise<{
    content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
    isError?: boolean
  }>
  close(): Promise<void>
  /** Invoked after an unexpected connection close/error. */
  onClose?(listener: () => void): () => void
}
export type McpRuntimeServer = Readonly<{
  config: McpServerConfig
  connection: McpConnection
  catalog?: readonly McpRemoteTool[]
}>
export type McpRuntimeInput = Readonly<{ list(): readonly McpRuntimeServer[] }>
export type McpConnectOptions = Readonly<{ signal: AbortSignal; timeoutMs: number }>
export type McpInspectOptions = Readonly<{ signal: AbortSignal; timeoutMs: number }>
export type McpConnector = (config: McpServerConfig, options: McpConnectOptions) => Promise<McpConnection>
export type McpCatalogInspector = (
  connection: McpConnection,
  config: McpServerConfig,
  options: McpInspectOptions,
) => Promise<readonly McpRemoteTool[]>
export type McpStdioPolicy = Readonly<{ allowedExecutables: readonly string[] }>
/**
 * Deployment capability only. A persisted/request definition cannot widen either switch.
 * `localDaemon` identifies the transport endpoint's machine, rather than using a mutable
 * profile name as a proxy for locality.
 */
export type McpHttpPolicy = Readonly<{ localDaemon?: boolean; allowLoopbackHttp?: boolean }>

import type {
  DesiredState,
  McpServerDefinitionInput,
  McpServerDescriptor,
  McpStatus,
  McpTool,
  McpToolCatalogPage,
  SafeError,
  TrustState,
} from '@agnes/protocol'
import { inspectJsonData, jcs } from '@agnes/protocol'
import type { ResourceActivationBarrier, ResourceActivationPermit } from './activation.js'

export type McpManagedInput = Readonly<{
  definition: McpServerDefinitionInput
  revision: string
  desired: DesiredState
  trust: TrustState
}>
export type McpCredentialResolver = (ref: string, signal: AbortSignal) => Promise<string>

/**
 * A resolved OAuth 2.1 credential for one managed MCP server, worker-side
 * with a structural
 * counterpart of `packages/host/src/adapters/credential-store.ts`'s `OAuthCredential`, deliberately
 * NOT imported from `@agnes/host` -- this package has no dependency on it today, matching the same
 * decoupling `oauth-http-handler.ts`'s own `OAuthStoredCredential` type documents for the identical
 * shape.
 */
export type McpOAuthCredential = Readonly<{
  provider: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  scope: readonly string[]
  grantId: string
}>

/**
 * Reads (and, when `resolvedConfig()` below decides a refresh is due, refreshes) the OAuth
 * credential stored for one managed MCP server. Read and refresh are bundled into a single resolver
 * call instead of two independently-injected options because a caller that has to retry a failed
 * refresh (spec §1.6/§3.5's concurrent-refresh optimistic retry -- another worker process may have
 * already rotated the refresh token) must compare the refreshed value against the *exact* credential
 * this same call read, not a value some other, possibly stale, closure captured earlier.
 *
 * `serverUrl`/`staticClientId` are threaded through explicitly (a deliberate, brief-permitted
 * adjustment: the brief's sketch passed only `serverId`) rather than requiring the real
 * implementation to look the managed definition back up by `serverId` a second time -- a refresh has
 * to run OAuth discovery against the authorization server, which needs the MCP server's URL, and
 * neither that nor an optional pre-registered client_id is derivable from `serverId` alone.
 * `resolvedConfig()` already has both in hand from the definition it is resolving.
 */
export type McpOAuthCredentialResolver = (
  serverId: string,
  signal: AbortSignal,
  serverUrl: URL,
  staticClientId: string | undefined,
) => Promise<Readonly<{ credential: McpOAuthCredential; refresh(): Promise<McpOAuthCredential> }> | undefined>

/**
 * Thrown by `resolvedConfig()` when an `oauth`-bound MCP server's credential cannot be resolved or
 * refreshed: no resolver configured, no credential stored yet, or refresh failed even after the
 * optimistic re-read retry (spec §3.5's "刷新失败" outcome, and M3's "must not silently keep trying
 * with a stale/expired token" requirement). Distinctly typed rather than a bare `Error` so a caller
 * can recognize "this connection failed because the user needs to re-authorize" instead of folding
 * it into every other candidate()/connect failure, and react by surfacing `needs-reconnect` --
 * `connectManaged()` below is that caller (traced per the brief's own instruction to find
 * `resolvedConfig()`'s actual call site rather than guess at a daemon-side file).
 */
export class McpOAuthNeedsReconnectError extends Error {
  readonly serverId: string
  constructor(serverId: string, options?: { cause?: unknown }) {
    super(`MCP OAuth credential for server "${serverId}" requires re-authorization`, options)
    this.name = 'McpOAuthNeedsReconnectError'
    this.serverId = serverId
  }
}

export type McpApply = (input: McpRuntimeInput, permit: ResourceActivationPermit) => Promise<void>
export type McpLifecycleAdapter = Readonly<{
  reconcile(input: {
    profile: string
    serverId: string
    definition: McpServerDefinitionInput
    enabled: boolean
    signal: AbortSignal
  }): Promise<{ status: McpStatus; tools?: McpToolCatalogPage; error?: SafeError }>
  test(input: {
    profile: string
    serverId: string
    definition: McpServerDefinitionInput
    signal: AbortSignal
  }): Promise<{ toolCount: number; catalogRevision: string; error?: SafeError }>
  reconnect(input: {
    profile: string
    serverId: string
    definition: McpServerDefinitionInput
    signal: AbortSignal
  }): Promise<{ status: McpStatus; tools?: McpToolCatalogPage; error?: SafeError }>
}>

type Active = Readonly<{
  input: McpManagedInput
  config: McpServerConfig
  connection: McpConnection
  remote: readonly McpRemoteTool[]
  tools: readonly McpTool[]
  catalogRevision: string
}>
type Observed = Readonly<{ state: McpStatus['connectionState']; at: string; error?: SafeError }>
type Options = Readonly<{
  barrier: ResourceActivationBarrier
  /** A manager is bound to exactly one daemon profile. */
  profile: string
  credentials: McpCredentialResolver
  /**
   * Parallel injection path for `secretBinding.kind === 'oauth'`, worker-side (spec §3.2/§3.5). Not
   * folded into `credentials` above: that resolver's contract is string-in-string-out (a plain
   * SecretRef), while OAuth needs a structured access/refresh-token object plus a refresh callback --
   * widening the existing resolver's return type would leak OAuth-specific shape into every other
   * secretBinding kind's resolution path for no benefit. Optional: a resource generation with no
   * oauth-bound MCP servers never needs one configured, and an oauth-bound server resolved with none
   * configured fails closed (`McpOAuthNeedsReconnectError`), not silently.
   */
  oauthCredentials?: McpOAuthCredentialResolver
  /** Fixed deployment environment only. Definitions cannot add raw values or override reserved names. */
  baseEnvironment?: Readonly<Record<string, string>>
  /** Explicit deployment allowlist. Stdio is refused if an executable is not named here. */
  stdioPolicy: McpStdioPolicy
  /** Plain HTTP requires a local daemon deployment plus an explicit loopback policy. */
  httpPolicy?: McpHttpPolicy
  connectTimeoutMs?: number
  inspectTimeoutMs?: number
  /** Base connectMcp (packages/base/src/mcp/connect.ts), injected by composition. */
  connect: McpConnector
  /** Base inspectRemoteCatalog, injected with the same strict rules as registration. */
  inspectCatalog: McpCatalogInspector
  /** Publishes the manager's generation at the barrier. The manager never claims this is automatic. */
  apply: McpApply
  now?: () => Date
  /** Worker-only safe observation sink; never receives definitions or resolved credentials. */
  onStatus?(status: McpStatus): void
}>

/**
 * How long before an OAuth access token's real `expiresAt` `resolvedConfig()` treats it as already
 * expired and refreshes eagerly (spec §3.5: "留一个短的提前量...由实现者参照已有的类似超时常量风格给出并
 * 注释理由"). 30s covers the gap between resolvedConfig() reading the credential and the actual MCP
 * connect request landing on the wire -- normally milliseconds, not seconds -- without refreshing on
 * every single connection attempt the way a near-zero leeway would once a token is within its final
 * seconds of life.
 */
const OAUTH_REFRESH_LEEWAY_MS = 30_000

const ZERO_REVISION = '0'.repeat(64)
const RESERVED_ENV = new Set(['PATH', 'HOME', 'SHELL', 'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES'])
const HOST_BASE_ENV = new Set(['PATH', 'HOME', 'TMP', 'TEMP', 'LANG', 'LC_ALL'])
const safeError = (code: string, message: string): SafeError => Object.freeze({ code, message })
const cloneDefinition = (definition: McpServerDefinitionInput): McpServerDefinitionInput =>
  structuredClone(definition)
const cloneInput = (input: McpManagedInput): McpManagedInput =>
  Object.freeze({ ...input, definition: cloneDefinition(input.definition) })
const sameDefinition = (left: McpServerDefinitionInput, right: McpServerDefinitionInput) =>
  jcs(left) === jcs(right)
const resourceId = (serverId: string) => `mcp/${serverId}`

function fixedEnvironment(input: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const output: Record<string, string> = {}
  for (const [name, value] of Object.entries(input ?? {})) {
    if (!HOST_BASE_ENV.has(name) || typeof value !== 'string' || value.includes('\0')) continue
    output[name] = value
  }
  return output
}

function isLoopbackHost(hostname: string): boolean {
  // URL.hostname retains brackets for IPv6 in some Node versions. Do not use a
  // loose `127.*` pattern: invalid or alternate-address forms must never turn a
  // remote clear-text endpoint into a locally trusted one.
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'))
}

/**
 * The HTTPS/loopback + credential-in-URL policy `validateManagedTransport` applies to a definition's
 * configured URL. Exported so the HTTP transport can re-run the identical check against an HTTP
 * redirect target before following it: the configured URL is validated once, at registration time,
 * but a malicious or compromised server can otherwise bounce the live connection anywhere -- every
 * hop needs the same gate, not just the first one.
 */
export function validateManagedHttpUrl(url: URL, httpPolicy: McpHttpPolicy | undefined): void {
  const queryNames = [...url.searchParams.keys()]
  if (
    url.username ||
    url.password ||
    url.hash ||
    queryNames.some((name) => /(?:token|secret|password|api[_-]?key|credential)/i.test(name))
  )
    throw new Error('MCP HTTP URL contains prohibited credential material')
  if (url.protocol === 'https:') return
  if (
    url.protocol === 'http:' &&
    httpPolicy?.localDaemon === true &&
    httpPolicy.allowLoopbackHttp === true &&
    isLoopbackHost(url.hostname)
  )
    return
  // Message is deliberately transport-agnostic: this function is shared by both the 'http' and 'sse'
  // transport.kind cases in validateManagedTransport() below, and a Web/CLI user who picked SSE and
  // hit this rejection should not be told they picked the wrong transport.
  throw new Error('this MCP transport requires HTTPS, or a local daemon with explicit loopback policy')
}

function validateManagedTransport(
  definition: McpServerDefinitionInput,
  stdioPolicy: McpStdioPolicy,
  httpPolicy: McpHttpPolicy | undefined,
): void {
  // Exhaustive over McpServerDefinitionInput's transport.kind discriminant (currently
  // 'stdio' | 'http' | 'sse'): the `default` branch's `never` assignment makes the compiler flag
  // this function the moment a fourth transport kind is added, instead of silently falling through
  // an `else` that assumed "anything that isn't stdio must be URL-based".
  switch (definition.transport.kind) {
    case 'stdio': {
      const executable = definition.transport.executable
      if (!stdioPolicy.allowedExecutables.includes(executable))
        throw new Error('stdio executable is not allowed by profile policy')
      const normalized = (executable.split(/[\\/]/).at(-1) ?? '').toLowerCase().replace(/\.exe$/, '')
      if (
        normalized === 'sh' ||
        normalized === 'bash' ||
        normalized === 'zsh' ||
        normalized === 'fish' ||
        normalized === 'cmd' ||
        normalized === 'powershell' ||
        normalized === 'pwsh'
      )
        throw new Error('shell executable is not allowed for MCP')
      if (definition.transport.args.some((arg) => /^(-c|\/c)$/i.test(arg)))
        throw new Error('shell command arguments are not allowed for MCP')
      return
    }
    case 'http':
    case 'sse':
      // http and sse share the exact same URL policy: both are plain URL-addressed remote
      // transports, and the HTTPS/loopback/credential-in-URL boundary does not depend on which
      // wire protocol runs over that URL (spec: 2026-09-18-mcp-sse-transport-plan, §1.3).
      validateManagedHttpUrl(new URL(definition.transport.url), httpPolicy)
      return
    default: {
      const exhaustive: never = definition.transport
      throw new TypeError(
        `unsupported MCP transport kind: ${JSON.stringify((exhaustive as { kind?: unknown })?.kind)}`,
      )
    }
  }
}

/**
 * Resolves the `Authorization` header value for an `oauth`-bound MCP server: returns the stored
 * access token directly if it is not near expiry, otherwise refreshes it first (spec §3.5). On a
 * refresh failure, performs exactly one optimistic re-read-and-compare retry before giving up (spec
 * §1.6/§3.5, M4's hard requirement): another worker process connecting to the same MCP server may
 * have already refreshed and persisted a new credential between this call's initial read and its
 * failed refresh attempt, and the credential store has no file lock -- re-reading once and checking
 * whether the access token actually changed is cheaper and safer than either locking or giving up
 * on a token another worker already fixed.
 */
async function resolveOAuthAuthorization(
  serverId: string,
  serverUrl: URL,
  staticClientId: string | undefined,
  oauthCredentials: McpOAuthCredentialResolver | undefined,
  signal: AbortSignal,
): Promise<string> {
  if (!oauthCredentials) throw new McpOAuthNeedsReconnectError(serverId)
  const resolved = await oauthCredentials(serverId, signal, serverUrl, staticClientId)
  if (!resolved) throw new McpOAuthNeedsReconnectError(serverId)
  const { credential } = resolved
  if (credential.expiresAt - OAUTH_REFRESH_LEEWAY_MS > Date.now()) return credential.accessToken
  try {
    const refreshed = await resolved.refresh()
    return refreshed.accessToken
  } catch (refreshError) {
    const retried = await oauthCredentials(serverId, signal, serverUrl, staticClientId)
    if (retried && retried.credential.accessToken !== credential.accessToken)
      return retried.credential.accessToken
    throw new McpOAuthNeedsReconnectError(serverId, { cause: refreshError })
  }
}

export async function resolvedConfig(
  input: McpManagedInput,
  resolver: McpCredentialResolver,
  signal: AbortSignal,
  baseEnv: Readonly<Record<string, string>>,
  policies: Pick<Options, 'stdioPolicy' | 'httpPolicy'>,
  oauth?: Pick<Options, 'oauthCredentials'>,
): Promise<McpServerConfig> {
  if (signal.aborted) throw new DOMException('operation aborted', 'AbortError')
  const definition = input.definition
  validateManagedTransport(definition, policies.stdioPolicy, policies.httpPolicy)
  const allowedTools = Object.freeze([...(definition.toolPolicy?.allow ?? [])])
  if (definition.transport.kind === 'stdio') {
    const binding = definition.secretBinding
    const env: Record<string, string> = {}
    if (binding.kind === 'stdio-env')
      for (const [name, ref] of Object.entries(binding.env)) {
        if (RESERVED_ENV.has(name)) throw new Error('reserved environment binding')
        const value = await resolver(ref, signal)
        if (typeof value !== 'string' || value.includes('\0')) throw new Error('invalid resolved credential')
        env[name] = value
      }
    return Object.freeze({
      id: definition.serverId,
      transport: 'stdio',
      cmd: [definition.transport.executable, ...definition.transport.args],
      baseEnv: fixedEnvironment(baseEnv),
      ...(Object.keys(env).length ? { env: Object.freeze(env) } : {}),
      allowedTools,
      defer: false,
    })
  }
  const binding = definition.secretBinding
  const headers: Record<string, string> = {}
  if (binding.kind === 'http-bearer') {
    const value = await resolver(binding.credentialRef, signal)
    if (typeof value !== 'string' || value.includes('\0') || value.includes('\r') || value.includes('\n'))
      throw new Error('invalid resolved credential')
    headers.authorization = `Bearer ${value}`
  } else if (binding.kind === 'http-header') {
    const value = await resolver(binding.credentialRef, signal)
    if (typeof value !== 'string' || value.includes('\0') || value.includes('\r') || value.includes('\n'))
      throw new Error('invalid resolved credential')
    headers[binding.headerName] = value
  } else if (binding.kind === 'oauth') {
    const value = await resolveOAuthAuthorization(
      definition.serverId,
      new URL(definition.transport.url),
      binding.staticClientId,
      oauth?.oauthCredentials,
      signal,
    )
    if (typeof value !== 'string' || value.includes('\0') || value.includes('\r') || value.includes('\n'))
      throw new Error('invalid resolved credential')
    headers.authorization = `Bearer ${value}`
  }
  return Object.freeze({
    id: definition.serverId,
    // definition.transport.kind is narrowed to 'http' | 'sse' here (the 'stdio' branch above
    // already returned) and its values line up exactly with McpServerConfig's non-stdio transport
    // labels, so this carries the definition's actual wire protocol through instead of collapsing
    // both into 'http' -- Base's connectMcp() dispatches on this field to pick
    // StreamableHTTPClientTransport vs. the legacy SSEClientTransport.
    transport: definition.transport.kind,
    url: definition.transport.url,
    ...(Object.keys(headers).length ? { headers: Object.freeze(headers) } : {}),
    allowedTools,
    defer: false,
  })
}

function protocolTool(tool: McpRemoteTool): McpTool {
  const inspected = inspectJsonData(tool.inputSchema, 256 * 1024)
  const schema = inspected.ok ? inspected.value : undefined
  if (
    typeof schema !== 'object' ||
    schema === null ||
    Array.isArray(schema) ||
    schema.type !== 'object' ||
    (schema.properties !== undefined &&
      (typeof schema.properties !== 'object' ||
        schema.properties === null ||
        Array.isArray(schema.properties))) ||
    (schema.required !== undefined &&
      (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== 'string'))) ||
    (schema.description !== undefined &&
      (typeof schema.description !== 'string' || schema.description.length > 2048))
  )
    throw new Error('tool schema is not a protocol parameters schema')
  if (tool.name.length > 128 || tool.description.length > 1024)
    throw new Error('tool metadata exceeds protocol limits')
  return Object.freeze({
    name: tool.name,
    description: tool.description,
    inputSchema: schema as McpTool['inputSchema'],
  })
}

function catalogFor(
  remote: readonly McpRemoteTool[],
): Readonly<{ tools: readonly McpTool[]; catalogRevision: string }> {
  const tools = Object.freeze(remote.map(protocolTool).sort((a, b) => a.name.localeCompare(b.name)))
  const catalogRevision = createHash('sha256').update(jcs(tools), 'utf8').digest('hex')
  return Object.freeze({ tools, catalogRevision })
}
function catalogPage(
  serverId: string,
  catalogRevision: string,
  tools: readonly McpTool[],
  cursor?: string,
): McpToolCatalogPage {
  const offset = cursor === undefined ? 0 : /^(?:0|[1-9][0-9]*)$/.test(cursor) ? Number(cursor) : -1
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > tools.length)
    throw new TypeError('invalid MCP tool cursor')
  const items = tools.slice(offset, offset + 100)
  return Object.freeze({
    serverId,
    catalogRevision,
    items: [...items],
    ...(offset + items.length < tools.length ? { nextCursor: String(offset + items.length) } : {}),
  })
}
function runtime(active: ReadonlyMap<string, Active>): McpRuntimeInput {
  const servers = Object.freeze(
    [...active.values()].map(
      (entry): McpRuntimeServer =>
        Object.freeze({ config: entry.config, connection: entry.connection, catalog: entry.remote }),
    ),
  )
  return Object.freeze({ list: () => servers })
}
async function closeOnce(connection: McpConnection, closed: WeakSet<object>): Promise<void> {
  if (closed.has(connection)) return
  closed.add(connection)
  await connection.close().catch(() => undefined)
}

/**
 * Host-only lifecycle. Definitions, desired state, trust decisions and SecretRefs arrive from the
 * daemon; this object resolves credentials only while opening a candidate and never serializes them.
 */
export function createMcpResourceManager(options: Options) {
  const now = options.now ?? (() => new Date())
  const staged = new Map<string, McpManagedInput>()
  let active = new Map<string, Active>()
  const observed = new Map<string, Observed>()
  const closed = new WeakSet<object>()
  const healthUnsubscribers = new WeakMap<object, () => void>()

  const status = (serverId: string, input = staged.get(serverId)): McpStatus => {
    const entry = active.get(serverId)
    const seen = observed.get(serverId)
    return Object.freeze({
      serverId,
      connectionState: entry
        ? 'ready'
        : (seen?.state ?? (input?.desired === 'disabled' ? 'disabled' : 'unavailable')),
      observedRevision: entry?.input.revision ?? null,
      catalogRevision: entry?.catalogRevision ?? null,
      toolCount: entry?.tools.length ?? 0,
      observedAt: seen?.at ?? new Date(0).toISOString(),
      ...(seen?.error ? { lastSafeError: seen.error } : {}),
    })
  }
  const reportStatus = (serverId: string): void => {
    try {
      options.onStatus?.(status(serverId))
    } catch {
      // Worker-to-daemon health reporting cannot change the lifecycle decision it reports.
    }
  }
  const stopHealthMonitoring = (entry: Active | undefined): void => {
    if (!entry) return
    healthUnsubscribers.get(entry.connection)?.()
    healthUnsubscribers.delete(entry.connection)
  }
  const retireDisconnected = async (serverId: string, entry: Active): Promise<void> => {
    // A late close from a retired generation must never erase a newly-published connection.
    if (active.get(serverId) !== entry) return
    const next = new Map(active)
    next.delete(serverId)
    active = next
    observed.set(
      serverId,
      Object.freeze({
        state: 'unavailable',
        at: now().toISOString(),
        error: safeError('MCP_CONNECTION_LOST', 'MCP transport closed unexpectedly'),
      }),
    )
    reportStatus(serverId)
    try {
      await options.barrier.quiesce(`mcp-disconnect:${serverId}`, async (permit) => {
        await options.apply(runtime(next), permit)
      })
    } catch {
      // The closed transport is already absent from actual state. A later reconcile can rebuild it.
    }
  }
  const startHealthMonitoring = (serverId: string, entry: Active): void => {
    if (!entry.connection.onClose) return
    const stop = entry.connection.onClose(() => {
      void retireDisconnected(serverId, entry)
    })
    healthUnsubscribers.set(entry.connection, stop)
  }
  const descriptor = (input: McpManagedInput): McpServerDescriptor => {
    const entry = active.get(input.definition.serverId)
    const seen = observed.get(input.definition.serverId)
    return Object.freeze({
      kind: 'mcp',
      resourceId: resourceId(input.definition.serverId),
      serverId: input.definition.serverId,
      displayName: input.definition.displayName,
      revision: input.revision,
      definition: cloneDefinition(input.definition),
      transportKind: input.definition.transport.kind,
      secretBindingKind: input.definition.secretBinding.kind,
      trust: input.trust,
      desired: input.desired,
      actual: entry
        ? entry.input.revision === input.revision
          ? 'ready'
          : 'degraded'
        : input.desired === 'disabled'
          ? 'disabled'
          : 'unavailable',
      source: 'managed',
      ...(seen?.error ? { lastSafeError: seen.error } : {}),
    })
  }
  const failed = (serverId: string, code: string, message: string, input = staged.get(serverId)) => {
    const error = safeError(code, message)
    observed.set(serverId, Object.freeze({ state: 'unavailable', at: now().toISOString(), error }))
    reportStatus(serverId)
    return Object.freeze({ status: status(serverId, input), error })
  }
  const candidate = async (input: McpManagedInput, signal: AbortSignal): Promise<Active> => {
    const config = await resolvedConfig(
      input,
      options.credentials,
      signal,
      options.baseEnvironment ?? {},
      options,
      options,
    )
    if (signal.aborted) throw new DOMException('operation aborted', 'AbortError')
    let connection: McpConnection | undefined
    try {
      connection = await options.connect(config, { signal, timeoutMs: options.connectTimeoutMs ?? 10_000 })
      if (signal.aborted) throw new DOMException('operation aborted', 'AbortError')
      const remote = await options.inspectCatalog(connection, config, {
        signal,
        timeoutMs: options.inspectTimeoutMs ?? 10_000,
      })
      if (signal.aborted) throw new DOMException('operation aborted', 'AbortError')
      const catalog = catalogFor(remote)
      return Object.freeze({
        input,
        config,
        connection,
        remote,
        tools: catalog.tools,
        catalogRevision: catalog.catalogRevision,
      })
    } catch (error) {
      if (connection) await closeOnce(connection, closed)
      throw error
    }
  }
  const applyActive = async (
    serverId: string,
    nextEntry: Active | undefined,
    operationId: string,
  ): Promise<{ status: McpStatus; tools?: McpToolCatalogPage; error?: SafeError }> => {
    const old = active.get(serverId)
    try {
      await options.barrier.quiesce(operationId, async (permit) => {
        const next = new Map(active)
        if (nextEntry) next.set(serverId, nextEntry)
        else next.delete(serverId)
        await options.apply(runtime(next), permit)
        active = next
      })
    } catch {
      if (nextEntry && nextEntry !== old) await closeOnce(nextEntry.connection, closed)
      return failed(serverId, 'MCP_APPLY_FAILED', 'MCP runtime activation failed')
    }
    if (old && old !== nextEntry) {
      stopHealthMonitoring(old)
      await closeOnce(old.connection, closed)
    }
    observed.set(
      serverId,
      Object.freeze({ state: nextEntry ? 'ready' : 'disabled', at: now().toISOString() }),
    )
    if (nextEntry) startHealthMonitoring(serverId, nextEntry)
    reportStatus(serverId)
    const current = status(serverId)
    if (!nextEntry) return Object.freeze({ status: current })
    return Object.freeze({
      status: current,
      tools: catalogPage(serverId, nextEntry.catalogRevision, nextEntry.tools),
    })
  }
  const assertProfile = (profile: string) => {
    if (profile !== options.profile) throw new TypeError('MCP resource manager profile mismatch')
  }
  const verify = (serverId: string, definition: McpServerDefinitionInput) => {
    const input = staged.get(serverId)
    return input && input.definition.serverId === serverId && sameDefinition(input.definition, definition)
      ? input
      : undefined
  }
  const connectManaged = async (
    serverId: string,
    definition: McpServerDefinitionInput,
    signal: AbortSignal,
    operationId: string,
  ) => {
    const input = verify(serverId, definition)
    if (!input)
      return failed(serverId, 'MANAGED_DEFINITION_REQUIRED', 'MCP managed definition is unavailable')
    if (input.desired !== 'enabled') return applyActive(serverId, undefined, `${operationId}:disable`)
    if (input.trust === 'rejected')
      return failed(serverId, 'TRUST_REJECTED', 'MCP revision was rejected', input)
    if (input.trust !== 'trusted')
      return failed(serverId, 'UNTRUSTED_REVISION', 'MCP revision requires trust', input)
    let next: Active
    try {
      next = await candidate(input, signal)
    } catch (error) {
      // A distinct SafeError code for the oauth-needs-reauthorization case (this IS the
      // "resolvedConfig()'s caller" the brief's §Step-4 instruction pointed at -- traced, not
      // guessed): downstream reporting (onStatus -> worker hello/resourceStatus -> daemon) carries
      // this SafeError over the wire, so whatever later wires McpServerDescriptor.authorizationStatus
      // end to end (see oauth-http-handler.ts's module header on why that plumbing lives outside this
      // worker-side package) can distinguish "the user needs to re-authorize" from every other
      // connect failure by this code, without this file needing to touch the daemon's journal itself.
      if (error instanceof McpOAuthNeedsReconnectError)
        return failed(
          serverId,
          'MCP_OAUTH_NEEDS_RECONNECT',
          'MCP OAuth credential requires re-authorization',
          input,
        )
      return failed(serverId, 'MCP_CONNECT_FAILED', 'MCP connection or catalog health check failed', input)
    }
    return applyActive(serverId, next, operationId)
  }

  return Object.freeze({
    /** Daemon supplies only durable control data; Host snapshots it before network/process work. */
    stage(input: McpManagedInput) {
      if (input.definition.serverId.length === 0 || !/^[a-f0-9]{64}$/.test(input.revision))
        throw new TypeError('invalid managed MCP input')
      const snapshot = cloneInput(input)
      staged.set(input.definition.serverId, snapshot)
      if (!active.has(snapshot.definition.serverId))
        observed.set(
          snapshot.definition.serverId,
          Object.freeze({
            state: snapshot.desired === 'disabled' ? 'disabled' : 'unavailable',
            at: now().toISOString(),
          }),
        )
    },
    async unstage(serverId: string) {
      // Definition ownership remains with the Daemon until the Host has stopped exposing this
      // generation. Deleting staged first would orphan a live connection when apply fails.
      if (active.has(serverId)) {
        const result = await applyActive(serverId, undefined, `mcp-remove:${serverId}`)
        if (result.error) throw new Error('MCP retirement failed; managed definition was retained')
      }
      staged.delete(serverId)
      observed.delete(serverId)
    },
    list: () => Object.freeze([...staged.values()].map(descriptor)),
    get: (serverId: string) => {
      const input = staged.get(serverId)
      return input ? descriptor(input) : undefined
    },
    status,
    tools(serverId: string, cursor?: string) {
      const entry = active.get(serverId)
      return entry ? catalogPage(serverId, entry.catalogRevision, entry.tools, cursor) : undefined
    },
    snapshot: () => runtime(active),
    async reconcile(input: {
      profile: string
      serverId: string
      definition: McpServerDefinitionInput
      enabled: boolean
      signal: AbortSignal
    }) {
      assertProfile(input.profile)
      if (!verify(input.serverId, input.definition))
        return failed(input.serverId, 'MANAGED_DEFINITION_REQUIRED', 'MCP managed definition is unavailable')
      if (!input.enabled) return applyActive(input.serverId, undefined, `mcp-disable:${input.serverId}`)
      return connectManaged(input.serverId, input.definition, input.signal, `mcp-enable:${input.serverId}`)
    },
    async reconnect(input: {
      profile: string
      serverId: string
      definition: McpServerDefinitionInput
      signal: AbortSignal
    }) {
      assertProfile(input.profile)
      return connectManaged(input.serverId, input.definition, input.signal, `mcp-reconnect:${input.serverId}`)
    },
    async test(input: {
      profile: string
      serverId: string
      definition: McpServerDefinitionInput
      signal: AbortSignal
    }) {
      assertProfile(input.profile)
      const managed = verify(input.serverId, input.definition)
      if (!managed)
        return Object.freeze({
          toolCount: 0,
          catalogRevision: ZERO_REVISION,
          error: safeError('MANAGED_DEFINITION_REQUIRED', 'MCP managed definition is unavailable'),
        })
      try {
        const transient = await candidate(managed, input.signal)
        await closeOnce(transient.connection, closed)
        return Object.freeze({
          toolCount: transient.tools.length,
          catalogRevision: transient.catalogRevision,
        })
      } catch {
        return Object.freeze({
          toolCount: 0,
          catalogRevision: ZERO_REVISION,
          error: safeError('MCP_TEST_FAILED', 'MCP test health check failed'),
        })
      }
    },
    async close() {
      const entries = [...active.values()]
      let removed = false
      await options.barrier.quiesce('mcp-close', async (permit) => {
        await options.apply(runtime(new Map()), permit)
        active = new Map()
        removed = true
      })
      // If Host extension retirement fails, the old generation must remain usable. In particular,
      // never close its connections while `active` still points at them.
      if (removed)
        for (const entry of entries) {
          stopHealthMonitoring(entry)
          await closeOnce(entry.connection, closed)
        }
    },
  } satisfies McpLifecycleAdapter & {
    stage(input: McpManagedInput): void
    unstage(serverId: string): Promise<void>
    list(): readonly McpServerDescriptor[]
    get(serverId: string): McpServerDescriptor | undefined
    status(serverId: string): McpStatus
    tools(serverId: string, cursor?: string): McpToolCatalogPage | undefined
    snapshot(): McpRuntimeInput
    close(): Promise<void>
  })
}

/** Read-only migration input. It never calls stage(), writes desired state, or opens a connection. */
export function legacyPresetSeed(
  definition: McpServerDefinitionInput,
  revision: string,
  state: Partial<Pick<McpManagedInput, 'desired' | 'trust'>> = {},
): Readonly<McpManagedInput & { source: 'legacy-preset' }> {
  return Object.freeze({
    definition: cloneDefinition(definition),
    revision,
    desired: state.desired ?? 'disabled',
    trust: state.trust ?? 'untrusted',
    source: 'legacy-preset',
  })
}
