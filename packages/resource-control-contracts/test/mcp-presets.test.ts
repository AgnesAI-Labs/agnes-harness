import { describe, expect, it } from 'vitest'
import { createMcpPreset, MCP_PRESETS } from '../src/mcp-presets.js'
import { validateResourceControlData } from '../src/resource-control.js'

describe('managed MCP preset catalog', () => {
  it('creates a pinned, isolated, headless Playwright definition accepted by the managed contract', () => {
    const definition = createMcpPreset('playwright')
    expect(definition).toEqual({
      serverId: 'playwright',
      displayName: 'Playwright MCP',
      transport: {
        kind: 'stdio',
        executable: 'npx',
        args: ['--yes', '@playwright/mcp@0.0.83', '--headless', '--isolated'],
      },
      sandboxProfile: 'network',
      secretBinding: { kind: 'none' },
    })
    expect(validateResourceControlData('McpServerDefinitionInput', definition).ok).toBe(true)
    expect(definition).not.toHaveProperty('trust')
    expect(definition).not.toHaveProperty('desired')
    expect(MCP_PRESETS[0].description.en).toBeTruthy()
    expect(MCP_PRESETS[0].description['zh-CN']).toBeTruthy()
  })

  it('validates custom identities and workspace paths and returns independent editable definitions', () => {
    const definition = createMcpPreset('playwright', {
      serverId: 'billing',
      workspacePath: '/workspace/project',
    })
    expect(definition).toMatchObject({ serverId: 'billing', workspacePath: '/workspace/project' })
    if (definition.transport.kind !== 'stdio') throw new Error('expected stdio')
    definition.transport.args.push('--browser', 'chromium')
    expect(createMcpPreset('playwright').transport).not.toEqual(definition.transport)
    expect(() => createMcpPreset('unknown')).toThrow('Unknown MCP preset')
    expect(() => createMcpPreset('playwright', { serverId: 'Invalid' })).toThrow('Invalid MCP preset')
    expect(() => createMcpPreset('playwright', { workspacePath: 'relative/path' })).toThrow(
      'Invalid MCP preset',
    )
  })
})
