import { describe, expect, it } from 'vitest'
import { McpOAuthNeedsReconnectError } from '../src/mcp.js'
import { mcpConnectionFailure } from '../src/mcp-failure.js'

const httpError = (code: number) => Object.assign(new Error(`HTTP ${code}`), { code })

describe('the sign-in message the model reads', () => {
  it('names the TUI and terminal commands and the web page', () => {
    expect(new McpOAuthNeedsReconnectError('docs').message).toBe(
      'MCP server "docs" needs sign-in. Ask the user to run /mcp login docs in the TUI or agh mcp login docs in a terminal, or to sign in from the MCP page in the web UI.',
    )
    expect(new McpOAuthNeedsReconnectError('docs', 'insufficient-scope').message).toBe(
      'MCP server "docs" needs more permissions. Ask the user to sign in to it again: /mcp login docs in the TUI, agh mcp login docs in a terminal, or the MCP page in the web UI.',
    )
  })
})

describe('mcpConnectionFailure', () => {
  it.each([
    ['login-required', 'MCP server needs sign-in'],
    ['insufficient-scope', 'MCP server needs more permissions; sign in again'],
    ['endpoint-changed', 'MCP server address changed since sign-in; sign in again'],
  ] as const)('a server that needs sign-in (%s) keeps its own code', (reason, message) => {
    expect(mcpConnectionFailure(new McpOAuthNeedsReconnectError('docs', reason), 'oauth')).toEqual({
      code: 'MCP_OAUTH_NEEDS_RECONNECT',
      message,
    })
  })

  it('reads the code, not the class, so a copy from another layer counts too', () => {
    const copy = Object.assign(new Error('x'), {
      code: 'MCP_OAUTH_NEEDS_RECONNECT',
      reason: 'insufficient-scope',
    })
    expect(mcpConnectionFailure(copy)).toEqual({
      code: 'MCP_OAUTH_NEEDS_RECONNECT',
      message: 'MCP server needs more permissions; sign in again',
    })
  })

  it('a server without a credential that answers 401 or 403 requires sign-in', () => {
    for (const status of [401, 403])
      expect(mcpConnectionFailure(httpError(status), 'none')).toEqual({
        code: 'MCP_AUTH_REQUIRED',
        message: 'MCP server requires sign-in',
      })
  })

  it('an OAuth server still answering 401 after the one refresh needs sign-in', () => {
    expect(mcpConnectionFailure(httpError(401), 'oauth')).toEqual({
      code: 'MCP_OAUTH_NEEDS_RECONNECT',
      message: 'MCP server needs sign-in',
    })
    expect(mcpConnectionFailure(httpError(403), 'oauth').code).toBe('MCP_AUTH_FAILED')
  })

  it('a saved bearer or header credential that is refused stays an authentication failure', () => {
    for (const kind of ['http-bearer', 'http-header', undefined])
      for (const status of [401, 403])
        expect(mcpConnectionFailure(httpError(status), kind).code).toBe('MCP_AUTH_FAILED')
  })

  it('anything else keeps the fixed connection failure text', () => {
    expect(mcpConnectionFailure(new Error('boom'), 'oauth')).toEqual({
      code: 'MCP_CONNECT_FAILED',
      message: 'MCP connection failed',
    })
  })
})
