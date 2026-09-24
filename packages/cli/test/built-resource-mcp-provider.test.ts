import { describe, expect, it } from 'vitest'
import { latestMcpCase } from './built-resource-mcp-provider.js'

describe('built MCP chat provider', () => {
  it('keeps the latest MCP case when runtime context follows the user instruction', () => {
    expect(
      latestMcpCase([
        { role: 'user', content: 'MC_CASE:first:ok' },
        { role: 'user', content: '[runtime context]\n{"environment":{"model":"test"}}' },
      ]),
    ).toEqual({ marker: 'first', behavior: 'ok', userIndex: 0 })
  })
})
