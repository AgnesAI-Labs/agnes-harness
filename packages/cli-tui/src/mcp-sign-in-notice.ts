import type { McpServerDescriptor } from '@agnes/protocol'
import type { NodeClient } from '@agnes/sdk'
import type { Locale } from './locale.js'

const MAX_PAGES = 10
const SIGN_IN_CODES: ReadonlySet<string> = new Set(['MCP_OAUTH_NEEDS_RECONNECT', 'MCP_AUTH_REQUIRED'])

const TEXT: Record<Locale, { notice(names: string): string; separator: string }> = {
  en: {
    notice: (names) => `MCP servers that need sign-in: ${names}. Run /mcp to see them.`,
    separator: ', ',
  },
  'zh-CN': { notice: (names) => `这些 MCP 服务需要登录：${names}。运行 /mcp 查看。`, separator: '、' },
}

/** Servers already announced by this process, so each is mentioned once however often this runs. */
const announced = new Set<string>()

/** An enabled server that cannot connect until someone signs in: an OAuth server that is not
 *  authorized, or one that last answered that it requires a sign-in. */
function needsSignIn(server: McpServerDescriptor): boolean {
  if (server.desired !== 'enabled') return false
  if (server.lastSafeError && SIGN_IN_CODES.has(server.lastSafeError.code)) return true
  return server.authorizationStatus === 'pending' || server.authorizationStatus === 'needs-reconnect'
}

/** The one-time start notice naming MCP servers that need sign-in, or `undefined` when there is
 *  nothing new to say (or the daemon cannot list servers: a notice is never worth failing a start). */
export async function mcpSignInNotice(
  client: NodeClient,
  profile: string,
  locale: Locale,
): Promise<string | undefined> {
  const names: string[] = []
  try {
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await client.mcp.servers.list({ profile, ...(cursor ? { cursor } : {}) })
      for (const server of result.items) {
        const key = `${profile}/${server.serverId}`
        if (!needsSignIn(server) || announced.has(key)) continue
        announced.add(key)
        names.push(server.serverId)
      }
      cursor = result.nextCursor
      if (!cursor) break
    }
  } catch {
    return undefined
  }
  const text = TEXT[locale]
  return names.length > 0 ? text.notice(names.join(text.separator)) : undefined
}
