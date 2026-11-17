/**
 * Shape of the per-server MCP OAuth credential file and the store that owns every write to it.
 * Types only: the implementation lives in `@agnes/host-infrastructure`, which re-declares the same
 * shapes because it must not depend on this package.
 */
export type McpOAuthClient = Readonly<{
  clientId: string
  clientSecret?: string
  tokenEndpointAuthMethod?: string
  redirectUri: string
}>

export type McpOAuthServer = Readonly<{
  endpoint: string
  authorizationServer: string
  tokenEndpoint: string
  issuer?: string
  resource: string
}>

export type McpOAuthTokens = Readonly<{
  accessToken: string
  refreshToken?: string
  expiresAt: number
  scope: readonly string[]
}>

/** A record without `client`, `server` and `tokens` is the logged-out record. */
export type McpOAuthRecord = Readonly<{
  version: 2
  kind: 'oauth'
  /** Grows only when the user logs out. */
  epoch: number
  /** Grows by one on every write. */
  rev: number
  client?: McpOAuthClient
  server?: McpOAuthServer
  tokens?: McpOAuthTokens
  requiredScope: readonly string[]
}>

/** `legacy` is a credential file written before this record existed; it needs a fresh login. */
export type McpOAuthRead = McpOAuthRecord | Readonly<{ legacy: true }> | null

export type McpOAuthNext = Omit<McpOAuthRecord, 'version' | 'kind' | 'rev'>

export type McpOAuthUpdateOptions = Readonly<{
  /**
   * A file that exists but cannot be read (damaged JSON or an invalid record) is handed to `change`
   * as `null`, so a fresh sign-in can replace it. Without this, such a file makes `update` throw.
   */
  replaceUnreadable?: boolean
}>

export type McpOAuthStore = Readonly<{
  read(serverId: string): Promise<McpOAuthRead>
  /** Locks the server, re-reads, runs `change`; writes `next` with rev + 1 when it returns one. */
  update<T>(
    serverId: string,
    change: (current: McpOAuthRead) => Promise<Readonly<{ value: T; next?: McpOAuthNext }>>,
    options?: McpOAuthUpdateOptions,
  ): Promise<T>
}>
