import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import {
  McpOAuthDiscoveryFailed,
  McpOAuthEndpointNotAllowed,
  McpOAuthLoginEndpointChanged,
  McpOAuthLoginSuperseded,
} from './mcp-oauth-login.js'
import { McpOAuthClientAuthUnsupported } from './mcp-oauth-protocol.js'

/** Why a sign-in step failed, in words a client can show. Never carries a code, token or secret. */
export type McpOAuthFailureReason = Readonly<
  | {
      reason:
        | 'MCP_OAUTH_LOGIN_SUPERSEDED'
        | 'MCP_OAUTH_LOGIN_ENDPOINT_CHANGED'
        | 'MCP_OAUTH_DISCOVERY_FAILED'
        | 'MCP_OAUTH_GRANT_REJECTED'
    }
  | { reason: 'MCP_OAUTH_ENDPOINT_NOT_ALLOWED'; endpoint: string }
  | { reason: 'MCP_OAUTH_CLIENT_AUTH_UNSUPPORTED'; method: string }
>

/**
 * The readable reason for a known sign-in failure, or undefined for anything else. The method of
 * an unsupported client authentication comes from the server's metadata; a refused grant keeps
 * only its kind, since the server's description may quote the code.
 */
export function mcpOAuthFailureReason(error: unknown): McpOAuthFailureReason | undefined {
  if (error instanceof McpOAuthLoginSuperseded || error instanceof McpOAuthLoginEndpointChanged)
    return { reason: error.code }
  if (error instanceof McpOAuthDiscoveryFailed) return { reason: 'MCP_OAUTH_DISCOVERY_FAILED' }
  if (error instanceof McpOAuthEndpointNotAllowed)
    return { reason: 'MCP_OAUTH_ENDPOINT_NOT_ALLOWED', endpoint: error.endpoint }
  if (error instanceof McpOAuthClientAuthUnsupported)
    return { reason: 'MCP_OAUTH_CLIENT_AUTH_UNSUPPORTED', method: error.method }
  if (error instanceof InvalidGrantError) return { reason: 'MCP_OAUTH_GRANT_REJECTED' }
  return undefined
}
