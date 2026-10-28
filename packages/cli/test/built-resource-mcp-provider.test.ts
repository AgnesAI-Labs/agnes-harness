import { describe, expect, it } from 'vitest'
import { latestMcpCase, mcpChatProvider } from './built-resource-mcp-provider.js'

describe('built MCP chat provider', () => {
  it('keeps the latest MCP case when runtime context follows the user instruction', () => {
    expect(
      latestMcpCase([
        { role: 'user', content: 'MC_CASE:first:ok' },
        { role: 'user', content: '[runtime context]\n{"environment":{"model":"test"}}' },
      ]),
    ).toEqual({ marker: 'first', behavior: 'ok', userIndex: 0 })
  })

  it('finishes a dispatched tool outcome even when its error includes the tool name', async () => {
    const provider = await mcpChatProvider()
    try {
      const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'fixture',
          tools: [{ function: { name: 'mcp__pager__tool120' } }],
          messages: [
            { role: 'user', content: 'MC_CASE:lostConnection:disconnect' },
            {
              role: 'assistant',
              tool_calls: [{ id: 'mcp-call', type: 'function', function: { name: 'mcp__pager__tool120' } }],
            },
            {
              role: 'tool',
              tool_call_id: 'mcp-call',
              content: 'the outcome of mcp__pager__tool120 is unknown after dispatch. Do not run it again.',
            },
          ],
        }),
      })
      const events = (await response.text())
        .split('\n')
        .filter((line) => line.startsWith('data: {'))
        .map((line) => JSON.parse(line.slice(6)))
      expect(events[0].choices[0].delta).toEqual({ content: 'UNAVAILABLE_lostConnection' })
      expect(events.at(-1).choices[0].finish_reason).toBe('stop')
    } finally {
      await provider.close()
    }
  })
})
