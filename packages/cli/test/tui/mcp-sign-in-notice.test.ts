import type { NodeClient } from '@agnes/sdk'
import { describe, expect, it } from 'vitest'
import { mcpSignInNotice } from '../../src/tui/app.js'

type Row = Record<string, unknown>
const row = (serverId: string, extra: Row = {}): Row => ({
  kind: 'mcp',
  serverId,
  desired: 'enabled',
  secretBindingKind: 'none',
  ...extra,
})
const clientWith = (pages: readonly (readonly Row[])[]): NodeClient =>
  ({
    mcp: {
      servers: {
        list: async ({ cursor }: { cursor?: string }) => {
          const index = cursor ? Number(cursor) : 0
          const next = index + 1 < pages.length ? String(index + 1) : undefined
          return { items: pages[index] ?? [], ...(next ? { nextCursor: next } : {}) }
        },
      },
    },
  }) as unknown as NodeClient

describe('mcpSignInNotice', () => {
  it('lists only servers that need sign-in', async () => {
    const client = clientWith([
      [
        row('alpha', { secretBindingKind: 'oauth', authorizationStatus: 'pending' }),
        row('beta', { secretBindingKind: 'oauth', authorizationStatus: 'authorized' }),
        row('gamma', { secretBindingKind: 'oauth', authorizationStatus: 'needs-reconnect' }),
        row('delta', { lastSafeError: { code: 'MCP_AUTH_REQUIRED', message: 'x' } }),
        row('epsilon', { lastSafeError: { code: 'MCP_CONNECT_FAILED', message: 'x' } }),
        row('zeta', { secretBindingKind: 'oauth', authorizationStatus: 'pending', desired: 'disabled' }),
      ],
    ])
    await expect(mcpSignInNotice(client, 'lists-only', 'en')).resolves.toBe(
      'MCP servers that need sign-in: alpha, gamma, delta. Run /mcp to see them.',
    )
  })

  it('says it in Chinese with the Chinese list separator', async () => {
    const client = clientWith([
      [
        row('a', { lastSafeError: { code: 'MCP_OAUTH_NEEDS_RECONNECT', message: 'x' } }),
        row('b', { lastSafeError: { code: 'MCP_AUTH_REQUIRED', message: 'x' } }),
      ],
    ])
    await expect(mcpSignInNotice(client, 'zh', 'zh-CN')).resolves.toBe(
      '这些 MCP 服务需要登录：a、b。运行 /mcp 查看。',
    )
  })

  it('reads every page of servers', async () => {
    const client = clientWith([
      [row('one', { lastSafeError: { code: 'MCP_AUTH_REQUIRED', message: 'x' } })],
      [row('two', { lastSafeError: { code: 'MCP_AUTH_REQUIRED', message: 'x' } })],
    ])
    await expect(mcpSignInNotice(client, 'pages', 'en')).resolves.toContain('one, two')
  })

  it('says nothing when none do', async () => {
    const client = clientWith([
      [row('fine'), row('signed-in', { secretBindingKind: 'oauth', authorizationStatus: 'authorized' })],
    ])
    await expect(mcpSignInNotice(client, 'none', 'en')).resolves.toBeUndefined()
  })

  it('says nothing when the daemon cannot list servers', async () => {
    const client = {
      mcp: {
        servers: {
          list: async () => {
            throw new Error('method not found')
          },
        },
      },
    } as unknown as NodeClient
    await expect(mcpSignInNotice(client, 'broken', 'en')).resolves.toBeUndefined()
  })

  it('a second call in the same process lists no server again', async () => {
    const client = clientWith([[row('once', { lastSafeError: { code: 'MCP_AUTH_REQUIRED', message: 'x' } })]])
    await expect(mcpSignInNotice(client, 'twice', 'en')).resolves.toContain('once')
    await expect(mcpSignInNotice(client, 'twice', 'en')).resolves.toBeUndefined()
  })

  it('names only the servers not yet announced when new ones appear later', async () => {
    const needs = { lastSafeError: { code: 'MCP_AUTH_REQUIRED', message: 'x' } }
    await mcpSignInNotice(clientWith([[row('old', needs)]]), 'later', 'en')
    await expect(
      mcpSignInNotice(clientWith([[row('old', needs), row('new', needs)]]), 'later', 'en'),
    ).resolves.toBe('MCP servers that need sign-in: new. Run /mcp to see them.')
  })
})
