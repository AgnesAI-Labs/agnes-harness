import type { McpServerDefinitionInput } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { mcpServerConfigFromDefinition } from '../src/opener.js'

const stdio = (
  overrides: Partial<McpServerDefinitionInput & { secretBinding: unknown }> = {},
): McpServerDefinitionInput =>
  ({
    serverId: 'gh',
    displayName: 'GitHub',
    transport: { kind: 'stdio', executable: '/usr/local/bin/gh-mcp', args: ['--stdio'] },
    secretBinding: { kind: 'stdio-env', env: { GH_TOKEN: 'secret:gh-token' } },
    ...overrides,
  }) as McpServerDefinitionInput

const http = (overrides: Partial<McpServerDefinitionInput> = {}): McpServerDefinitionInput =>
  ({
    serverId: 'remote',
    displayName: 'Remote',
    transport: { kind: 'http', url: 'https://mcp.example.com/mcp' },
    secretBinding: { kind: 'http-bearer', credentialRef: 'secret:remote-token' },
    ...overrides,
  }) as McpServerDefinitionInput

describe('mcpServerConfigFromDefinition', () => {
  it('builds a stdio config from the executable and args, with no resolved secret material', () => {
    const cfg = mcpServerConfigFromDefinition(stdio())
    expect(cfg).toEqual({
      id: 'gh',
      transport: 'stdio',
      cmd: ['/usr/local/bin/gh-mcp', '--stdio'],
      defer: false,
    })
    // The SecretRef in secretBinding.env never becomes a resolved value here.
    expect(cfg.env).toBeUndefined()
  })

  it('builds an http config from the url, with no resolved credential', () => {
    const cfg = mcpServerConfigFromDefinition(http())
    expect(cfg).toEqual({
      id: 'remote',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      defer: false,
    })
    expect(cfg.headers).toBeUndefined()
  })

  it('carries the sse transport kind through unchanged', () => {
    const cfg = mcpServerConfigFromDefinition(
      http({
        transport: { kind: 'sse', url: 'https://mcp.example.com/sse' },
      } as Partial<McpServerDefinitionInput>),
    )
    expect(cfg.transport).toBe('sse')
    expect(cfg.url).toBe('https://mcp.example.com/sse')
  })

  it('carries an allowedTools policy through when the definition declares one', () => {
    const cfg = mcpServerConfigFromDefinition(
      stdio({ toolPolicy: { allow: ['list_prs', 'merge'] } } as Partial<McpServerDefinitionInput>),
    )
    expect(cfg.allowedTools).toEqual(['list_prs', 'merge'])
  })

  it('omits allowedTools entirely when the definition declares no tool policy', () => {
    const cfg = mcpServerConfigFromDefinition(stdio())
    expect(cfg.allowedTools).toBeUndefined()
  })

  it('is a pure function: the same definition always derives the same config', () => {
    const definition = stdio({ toolPolicy: { allow: ['list_prs'] } } as Partial<McpServerDefinitionInput>)
    expect(mcpServerConfigFromDefinition(definition)).toEqual(mcpServerConfigFromDefinition(definition))
  })
})
