import type { HostSession } from '@agnes/host'
import type { McpRowRuntime } from './mcp-row-runtime.js'

/** Servers each session was already told about, so a slow server is announced once, not per turn. */
const announcedConnecting = new WeakMap<object, Set<string>>()

/**
 * A turn waits only boundedly for a newly enabled MCP server (`FIRST_ATTEMPT_TIMEOUT_MS`). A server
 * still connecting after that starts the turn without its tools; this writes one quiet session
 * notice naming it, so a missing tool is explained rather than silent. A diagnostic row: never part
 * of the model's view, and a failed write never blocks the turn.
 */
export async function noticeConnectingMcp(
  session: Pick<HostSession, 'diag'>,
  rows: Pick<McpRowRuntime, 'connecting'> | undefined,
): Promise<void> {
  const connecting = rows?.connecting?.() ?? []
  const announced = announcedConnecting.get(session) ?? new Set<string>()
  announcedConnecting.set(session, announced)
  const now = new Set(connecting.map((server) => server.serverId))
  for (const serverId of announced) if (!now.has(serverId)) announced.delete(serverId)
  const fresh = connecting.filter((server) => !announced.has(server.serverId))
  if (fresh.length === 0) return
  for (const server of fresh) announced.add(server.serverId)
  await session.diag('tool-source-pending', {
    kind: 'mcp',
    sources: fresh.map((server) => server.displayName),
  })
}
