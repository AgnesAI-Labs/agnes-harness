import type { McpServerDescriptor } from '@agnes/protocol'
import { mcpNeedsSignIn } from '@agnes/resource-control-cli'
import type { NodeClient } from '@agnes/sdk'
import type { TuiMcpLogin } from '../tui/app.js'
import { mcpLoginFailureText, runMcpLogin, runMcpLogout } from './run.js'

const MAX_PAGES = 10

/** A server `/mcp login` can sign in to: HTTP or SSE, with OAuth or no credential yet. */
const signsInWithOAuth = (server: McpServerDescriptor): boolean =>
  server.transportKind !== 'stdio' &&
  (server.secretBindingKind === 'oauth' || server.secretBindingKind === 'none')

/**
 * The TUI's way into the sign-in code the terminal command uses. A failure rejects with one plain
 * sentence (server text cleaned of control characters), which the panel shows as it is.
 */
export function createTuiMcpLogin(
  client: NodeClient,
  options: Pick<Parameters<typeof runMcpLogin>[0], 'fetchImpl' | 'openBrowser'> = {},
): TuiMcpLogin {
  return {
    async candidates(profile) {
      const names: string[] = []
      let cursor: string | undefined
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await client.mcp.servers.list({ profile, ...(cursor ? { cursor } : {}) })
        for (const server of result.items)
          if (signsInWithOAuth(server) && mcpNeedsSignIn(server)) names.push(server.serverId)
        cursor = result.nextCursor
        if (!cursor) break
      }
      return names
    },
    async login({ profile, serverId, ui, signal }) {
      try {
        return await runMcpLogin({ client, profile, serverId, ui, signal, ...options })
      } catch (error) {
        throw new Error(mcpLoginFailureText(serverId, error))
      }
    },
    async logout(profile, serverId) {
      try {
        await runMcpLogout({ client, profile, serverId })
      } catch (error) {
        throw new Error(mcpLoginFailureText(serverId, error))
      }
    },
  }
}
