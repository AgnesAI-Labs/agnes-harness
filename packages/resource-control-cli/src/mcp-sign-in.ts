import type { McpServerDescriptor } from '@agnes/protocol'

const SIGN_IN_CODES: ReadonlySet<string> = new Set(['MCP_OAUTH_NEEDS_RECONNECT', 'MCP_AUTH_REQUIRED'])

/** Whether a listed MCP server cannot connect until someone signs in: an OAuth server that is not
 *  authorized (never signed in, or the sign-in expired), or a server the daemon last saw answer
 *  that it requires one. */
export function mcpNeedsSignIn(server: McpServerDescriptor): boolean {
  if (server.lastSafeError && SIGN_IN_CODES.has(server.lastSafeError.code)) return true
  return server.authorizationStatus === 'pending' || server.authorizationStatus === 'needs-reconnect'
}

/** The suffix a server's list line carries when it needs sign-in, with the ways to sign in. */
export const mcpSignInMark = (server: McpServerDescriptor): string =>
  mcpNeedsSignIn(server)
    ? ` needs sign-in (agh mcp login ${server.serverId}, /mcp login ${server.serverId} in the TUI, or the web MCP page)`
    : ''
