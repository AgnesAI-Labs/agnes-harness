import { describe, expect, it } from 'vitest'
import { resourceFailureCatalog, resourceFailureKey } from '../src/resource-failure.js'

describe('resourceFailureKey', () => {
  it.each([
    ['RESOURCE_REMOVE_BLOCKED', 'resource.error.removeBlocked'],
    ['MCP_STDIO_ENV_MISSING', 'resource.error.mcpEnv'],
    ['MCP_STDIO_RUNTIME_UNAVAILABLE', 'resource.error.mcpRuntime'],
    ['MCP_STDIO_ACCESS_DENIED', 'resource.error.mcpAccess'],
    ['MCP_STDIO_NETWORK_FAILED', 'resource.error.mcpNetwork'],
    ['MCP_STDIO_CLOSED', 'resource.error.mcpClosed'],
    ['MCP_CONNECT_TIMEOUT', 'resource.error.mcpTimeout'],
    ['MCP_AUTH_FAILED', 'resource.error.mcpAuth'],
    ['E_MCP_SANDBOX_UNAVAILABLE', 'resource.error.mcpSandbox'],
  ])('names the actionable cause for %s', (code, expected) => {
    const key = resourceFailureKey(code)
    expect(key).toBe(expected)
    for (const catalog of Object.values(resourceFailureCatalog)) expect(catalog).toHaveProperty(key)
  })

  it('keeps unknown codes on the generic failure', () => {
    expect(resourceFailureKey('SOMETHING_ELSE')).toBe('resource.error.operation')
  })
})
