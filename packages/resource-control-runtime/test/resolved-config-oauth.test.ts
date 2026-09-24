import { describe, expect, it } from 'vitest'
import { type McpOAuthCredential, McpOAuthNeedsReconnectError, resolvedConfig } from '../src/mcp.js'

/**
 * Unit coverage for `resolvedConfig()`'s `secretBinding.kind === 'oauth'` branch
 * . This exercises
 * only the worker-side lazy-refresh decision logic through a fake `oauthCredentials` resolver -- the
 * real resolver's discovery/refreshAuthorization/credential-store wiring is covered separately by
 * mcp-oauth-credentials.test.ts (fixture authorization server, real SDK calls, real guarded fetch).
 */

const policies = { stdioPolicy: { allowedExecutables: [] } }
const resolver = async (): Promise<string> => {
  throw new Error('oauth-bound server must not use the string SecretRef resolver')
}
const baseEnv = {}

function managedInput(staticClientId?: string) {
  return {
    definition: {
      serverId: 'remote-server',
      displayName: 'Remote',
      transport: { kind: 'http' as const, url: 'https://mcp.example.com/mcp' },
      secretBinding: { kind: 'oauth' as const, ...(staticClientId ? { staticClientId } : {}) },
    },
    revision: 'a'.repeat(64),
    desired: 'enabled' as const,
    trust: 'trusted' as const,
  }
}

function credential(overrides: Partial<McpOAuthCredential>): McpOAuthCredential {
  return {
    provider: 'mcp-oauth',
    accessToken: 'tok',
    refreshToken: 'refresh',
    expiresAt: Date.now() + 60_000,
    scope: [],
    grantId: 'remote-server',
    ...overrides,
  }
}

describe('resolvedConfig() oauth secretBinding', () => {
  it('resolves a valid, non-expired oauth token directly without calling refresh', async () => {
    const fresh = credential({ accessToken: 'tok-1', expiresAt: Date.now() + 60_000 })
    const oauthCredentials = async () => ({
      credential: fresh,
      refresh: async (): Promise<McpOAuthCredential> => {
        throw new Error('should not be called')
      },
    })
    const config = await resolvedConfig(
      managedInput(),
      resolver,
      new AbortController().signal,
      baseEnv,
      policies,
      { oauthCredentials },
    )
    expect(config.headers?.authorization).toBe('Bearer tok-1')
  })

  it('refreshes an expired token before connecting', async () => {
    const expired = credential({ accessToken: 'old', expiresAt: Date.now() - 1_000 })
    const refreshed = credential({ accessToken: 'new', expiresAt: Date.now() + 60_000 })
    const oauthCredentials = async () => ({ credential: expired, refresh: async () => refreshed })
    const config = await resolvedConfig(
      managedInput(),
      resolver,
      new AbortController().signal,
      baseEnv,
      policies,
      { oauthCredentials },
    )
    expect(config.headers?.authorization).toBe('Bearer new')
  })

  it('refreshes a token inside the leeway window even though it has not strictly expired yet', async () => {
    // 10s left, leeway is 30s (see OAUTH_REFRESH_LEEWAY_MS in mcp.ts) -- must refresh now, not wait
    // for the connection attempt itself to race the expiry.
    const almostExpired = credential({ accessToken: 'old', expiresAt: Date.now() + 10_000 })
    const refreshed = credential({ accessToken: 'new', expiresAt: Date.now() + 3_600_000 })
    const oauthCredentials = async () => ({ credential: almostExpired, refresh: async () => refreshed })
    const config = await resolvedConfig(
      managedInput(),
      resolver,
      new AbortController().signal,
      baseEnv,
      policies,
      { oauthCredentials },
    )
    expect(config.headers?.authorization).toBe('Bearer new')
  })

  it('retries with the freshly-read value when refresh fails but another worker already refreshed it (M4)', async () => {
    const stale = credential({ accessToken: 'stale', expiresAt: Date.now() - 1_000 })
    const alreadyRefreshedByAnotherWorker = credential({
      accessToken: 'newer',
      expiresAt: Date.now() + 60_000,
    })
    let readCount = 0
    const oauthCredentials = async () => ({
      credential: readCount++ === 0 ? stale : alreadyRefreshedByAnotherWorker,
      refresh: async (): Promise<McpOAuthCredential> => {
        throw new Error('refresh_token invalid, rotated by another worker')
      },
    })
    const config = await resolvedConfig(
      managedInput(),
      resolver,
      new AbortController().signal,
      baseEnv,
      policies,
      { oauthCredentials },
    )
    expect(config.headers?.authorization).toBe('Bearer newer')
    expect(readCount).toBe(2)
  })

  it('throws McpOAuthNeedsReconnectError when refresh fails and the re-read value is unchanged', async () => {
    const stale = credential({ accessToken: 'stale', expiresAt: Date.now() - 1_000 })
    const oauthCredentials = async () => ({
      credential: stale,
      refresh: async (): Promise<McpOAuthCredential> => {
        throw new Error('refresh_token revoked')
      },
    })
    await expect(
      resolvedConfig(managedInput(), resolver, new AbortController().signal, baseEnv, policies, {
        oauthCredentials,
      }),
    ).rejects.toBeInstanceOf(McpOAuthNeedsReconnectError)
  })

  it('throws McpOAuthNeedsReconnectError when no oauthCredentials resolver is configured', async () => {
    await expect(
      resolvedConfig(managedInput(), resolver, new AbortController().signal, baseEnv, policies, {}),
    ).rejects.toBeInstanceOf(McpOAuthNeedsReconnectError)
  })

  it('throws McpOAuthNeedsReconnectError when the resolver has no stored credential yet', async () => {
    const oauthCredentials = async () => undefined
    await expect(
      resolvedConfig(managedInput(), resolver, new AbortController().signal, baseEnv, policies, {
        oauthCredentials,
      }),
    ).rejects.toBeInstanceOf(McpOAuthNeedsReconnectError)
  })

  it('passes the definition serverUrl and staticClientId through to the resolver', async () => {
    let seen: [string, URL, string | undefined] | undefined
    const fresh = credential({ accessToken: 'tok-1' })
    const oauthCredentials = async (
      serverId: string,
      _signal: AbortSignal,
      serverUrl: URL,
      clientId?: string,
    ) => {
      seen = [serverId, serverUrl, clientId]
      return { credential: fresh, refresh: async () => fresh }
    }
    await resolvedConfig(
      managedInput('static-client'),
      resolver,
      new AbortController().signal,
      baseEnv,
      policies,
      { oauthCredentials },
    )
    expect(seen?.[0]).toBe('remote-server')
    expect(seen?.[1]?.toString()).toBe('https://mcp.example.com/mcp')
    expect(seen?.[2]).toBe('static-client')
  })
})
