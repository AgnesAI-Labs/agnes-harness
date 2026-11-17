import type { McpServerDescriptor } from '@agnes/protocol'
import type { ResourceAuthority, ResourceControlService } from '@agnes/resource-control-store'

/** Reads one MCP server definition for the daemon's OAuth sign-in completion; nothing else. */
const MCP_OAUTH_AUTHORITY: ResourceAuthority = Object.freeze({
  audience: 'admin',
  principalId: 'system:mcp-oauth',
  clientId: 'mcp-oauth',
  permissions: Object.freeze(['mcp.read'] as const),
})

/** The resource store's answers for "no such server" and "not this daemon's profile". */
const NO_SERVER = new Set(['MCP_NOT_FOUND', 'PROFILE_SCOPE'])

function noServer(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('data' in error)) return false
  const data = (error as { data?: unknown }).data
  return typeof data === 'object' && data !== null && NO_SERVER.has(String((data as { code?: unknown }).code))
}

/**
 * Looks a server definition up through the resource-control service. An unknown server or profile
 * is `undefined`; any other failure (storage, permission) is rethrown so its cause is not lost.
 */
export function mcpOAuthServerLookup(service: ResourceControlService) {
  return async (
    profile: string,
    serverId: string,
  ): Promise<McpServerDescriptor['definition'] | undefined> => {
    try {
      const descriptor = (await service.call(
        '_agnes/v1/mcp.servers.get',
        { profile, serverId },
        MCP_OAUTH_AUTHORITY,
      )) as McpServerDescriptor
      return descriptor.definition
    } catch (error) {
      if (noServer(error)) return undefined
      throw error
    }
  }
}
