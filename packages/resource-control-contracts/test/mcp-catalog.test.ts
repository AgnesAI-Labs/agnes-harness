import { describe, expect, it } from 'vitest'
import { validateResourceControlCall, validateResourceControlData } from '../src/index.js'

const page = (properties: Record<string, unknown>) => ({
  serverId: 'pager',
  catalogRevision: 'a'.repeat(64),
  items: [
    {
      name: 'tool120',
      description: 'Fixture',
      inputSchema: {
        type: 'object',
        properties,
        required: ['marker'],
        additionalProperties: false,
      } as Record<string, unknown>,
    },
  ],
})

describe('MCP catalog JSON schema references', () => {
  it('accepts nonempty remote tool properties through data and RPC result validators', () => {
    const catalog = page({ marker: { type: 'string' } })
    expect(validateResourceControlData('McpToolCatalogPage', catalog).ok).toBe(true)
    expect(validateResourceControlCall('_agnes/v1/mcp.servers.tools.list', 'result', catalog).ok).toBe(true)
  })

  it('accepts an object schema without the optional properties table', () => {
    const catalog = page({})
    const tool = catalog.items[0]
    if (!tool) throw new Error('missing fixture tool')
    tool.inputSchema = { type: 'object' }
    expect(validateResourceControlData('McpToolCatalogPage', catalog).ok).toBe(true)
    expect(validateResourceControlCall('_agnes/v1/mcp.servers.tools.list', 'result', catalog).ok).toBe(true)
  })

  it('accepts recursively nested JSON schema object, array and scalar values', () => {
    const catalog = page({
      marker: {
        type: 'object',
        properties: { nested: { type: 'array', items: { enum: [null, true, 2, 'value'] } } },
        required: ['nested'],
        additionalProperties: false,
      },
    })
    expect(validateResourceControlData('McpToolCatalogPage', catalog).ok).toBe(true)
  })

  it('preserves an upstream object schema with annotations, formats, defaults and open properties', () => {
    const catalog = page({})
    const tool = catalog.items[0]
    if (!tool) throw new Error('missing fixture tool')
    tool.inputSchema = {
      type: 'object',
      title: 'Fetch',
      description: 'Parameters for fetching a URL.',
      properties: {
        url: { type: 'string', format: 'uri', minLength: 1, title: 'Url' },
        max_length: { type: 'integer', default: 5000, exclusiveMinimum: 0 },
      },
      required: ['url'],
    }
    expect(validateResourceControlData('McpToolCatalogPage', catalog).ok).toBe(true)
    expect(validateResourceControlCall('_agnes/v1/mcp.servers.tools.list', 'result', catalog).ok).toBe(true)
  })

  it.each([undefined, () => undefined, Number.NaN, BigInt(1)])(
    'rejects non-JSON schema values %s',
    (value) => {
      expect(validateResourceControlData('McpToolCatalogPage', page({ marker: value })).ok).toBe(false)
    },
  )

  it('rejects a non-JSON value in an upstream top-level annotation', () => {
    const catalog = page({})
    const tool = catalog.items[0]
    if (!tool) throw new Error('missing fixture tool')
    tool.inputSchema.title = () => undefined
    expect(validateResourceControlData('McpToolCatalogPage', catalog).ok).toBe(false)
  })

  it('continues to reject unexpected catalog fields and a non-object properties table', () => {
    expect(validateResourceControlData('McpToolCatalogPage', { ...page({}), unexpected: true }).ok).toBe(
      false,
    )
    const catalog = page({ marker: { type: 'string' } })
    const tool = catalog.items[0]
    if (!tool) throw new Error('missing fixture tool')
    ;(tool.inputSchema as Record<string, unknown>).properties = []
    expect(validateResourceControlData('McpToolCatalogPage', catalog).ok).toBe(false)
  })
})
