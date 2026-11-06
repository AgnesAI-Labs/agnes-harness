import type { McpStatus } from '@agnes/protocol'
import { applyMcpRowChange } from './commands.js'

/**
 * The worker side of `resourceMcpSignOut`: after the stored sign-in was removed, drops this server's
 * row right away instead of waiting for its next refused request, and starts no new connection for
 * it (a reconnect would start one, and keep the old one when it fails). Goes through the same
 * run-admission barrier as `resourceMcpApply`, so a turn in flight finishes first; its requests
 * are refused already, since the stored sign-in moved on. Returns the status the row is left with.
 */
export async function signOutMcpRow(
  o: Parameters<typeof applyMcpRowChange>[0],
  serverId: unknown,
): Promise<McpStatus> {
  if (typeof serverId !== 'string') throw new TypeError('invalid MCP sign-out request')
  const rows = o.resources?.mcpRows
  if (!rows) throw new Error('MCP rows are unavailable in this worker')
  rows.signOut(serverId)
  const status = await applyMcpRowChange(o, serverId, false)
  if (!status) throw new Error(`MCP server ${serverId} is not part of the current snapshot`)
  return status
}
