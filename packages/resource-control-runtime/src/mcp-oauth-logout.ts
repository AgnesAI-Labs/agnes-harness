import type { McpOAuthStore } from './mcp-oauth-store.js'

/**
 * Signs a server out. Under the store's lock the credential becomes the signed-out record: no
 * client, server, tokens or required scope, and `epoch` one higher, so a refresh or a sign-in that
 * started before can no longer write (both compare `epoch` under the same lock). Nothing is sent to
 * the authorization server.
 *
 * With no credential file there is nothing to sign out, and nothing is written. A file that cannot be
 * read makes the store throw; `replaceUnreadable` turns it into a signed-out record instead.
 */
export async function signOutMcpOAuth(input: {
  serverId: string
  store: McpOAuthStore
  replaceUnreadable?: boolean
}): Promise<{ epoch: number }> {
  return input.store.update(
    input.serverId,
    async (current) => {
      // Under `replaceUnreadable` a null is the unreadable file, which is replaced like any other.
      if (current === null && !input.replaceUnreadable) return { value: { epoch: 0 } }
      const epoch = (current && !('legacy' in current) ? current.epoch : 0) + 1
      return { value: { epoch }, next: { epoch, requiredScope: [] } }
    },
    input.replaceUnreadable ? { replaceUnreadable: true } : undefined,
  )
}
