/**
 * How long before an access token's `expiresAt` it is treated as expired and refreshed first: it
 * covers the gap between reading the token and the request reaching the server, without refreshing
 * on every request once a token is in its last seconds.
 *
 * Lives in this leaf module (re-exported by `mcp.ts`) because modules that `mcp.ts` itself imports
 * read it while they load.
 */
export const OAUTH_REFRESH_LEEWAY_MS = 30_000

export type McpOAuthLoginReason = 'login-required' | 'insufficient-scope' | 'endpoint-changed'

/**
 * An OAuth MCP server cannot be used until the user signs in (again): no usable stored sign-in, a
 * refresh that failed, a server address that changed since sign-in, or a token without the scope
 * a call needs. Recognized by its `code`, which survives into connection status and tool results.
 *
 * The message is written for the model: it says what to ask the user, not what failed inside.
 */
export class McpOAuthNeedsReconnectError extends Error {
  readonly code = 'MCP_OAUTH_NEEDS_RECONNECT'
  readonly serverId: string
  readonly reason: McpOAuthLoginReason
  constructor(
    serverId: string,
    reason: McpOAuthLoginReason = 'login-required',
    options?: { cause?: unknown },
  ) {
    super(
      reason === 'insufficient-scope'
        ? `MCP server "${serverId}" needs more permissions. Ask the user to sign in to it again: /mcp login ${serverId} in the TUI, agh mcp login ${serverId} in a terminal, or the MCP page in the web UI.`
        : `MCP server "${serverId}" needs sign-in. Ask the user to run /mcp login ${serverId} in the TUI or agh mcp login ${serverId} in a terminal, or to sign in from the MCP page in the web UI.`,
      options,
    )
    this.name = 'McpOAuthNeedsReconnectError'
    this.serverId = serverId
    this.reason = reason
  }
}
