import { ToolRegistry } from '@agnes/core'
import type { ExtensionAPI, ToolDef } from '@agnes/extension-api'
import { validateAgainst } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { type McpConnection, type McpSkippedTool, registerRemoteToolsStrict } from '../../src/mcp/register.js'
import { remoteInputSchema } from '../../src/mcp-json-schema.js'

async function registered(inputSchema: Record<string, unknown>): Promise<ToolDef> {
  const { tool } = await attempted(inputSchema)
  if (!tool) throw new Error('tool was not registered')
  return tool
}

async function attempted(
  inputSchema: Record<string, unknown>,
): Promise<{ tool?: ToolDef; skipped: readonly McpSkippedTool[] }> {
  let captured: ToolDef | undefined
  let skipped: readonly McpSkippedTool[] = []
  const conn: McpConnection = {
    id: 'schema',
    listTools: async () => [{ name: 'probe', description: 'schema probe', inputSchema }],
    callTool: vi.fn(async () => ({ content: [] })),
    close: vi.fn(async () => undefined),
  }
  const api = {
    registerResource: () => () => undefined,
    registerTool: (tool: ToolDef) => {
      captured = tool
      return () => undefined
    },
  } as unknown as ExtensionAPI
  await registerRemoteToolsStrict(
    api,
    conn,
    {
      id: 'schema',
      transport: 'stdio',
      cmd: ['fixture'],
      defer: true,
    },
    {
      onRemoteCatalog: (_remote, reported) => {
        skipped = reported
      },
    },
  )
  return captured ? { tool: captured, skipped } : { skipped }
}

describe('MCP remote schema in the core argument validator', () => {
  it('accepts empty object arguments and preserves the provider JSON schema', async () => {
    const schema = { type: 'object', properties: {}, additionalProperties: false }
    const tool = await registered(schema)
    expect(validateAgainst(tool.parameters, {}).ok).toBe(true)
    expect(validateAgainst(tool.parameters, { injected: true }).ok).toBe(false)
    expect(JSON.parse(JSON.stringify(tool.parameters))).toEqual(schema)
  })

  it('validates nested required fields, arrays, ranges and additional properties without mutation', async () => {
    const tool = await registered({
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: { name: { type: 'string', minLength: 2 }, age: { type: 'integer', minimum: 1 } },
          required: ['name'],
          additionalProperties: false,
        },
        tags: { type: 'array', items: { enum: ['a', 'b'] }, minItems: 1, uniqueItems: true },
      },
      required: ['user'],
      additionalProperties: false,
    })
    const valid = { user: { name: 'Ada', age: 2 }, tags: ['a', 'b'] }
    const before = JSON.stringify(valid)
    expect(validateAgainst(tool.parameters, valid).ok).toBe(true)
    expect(JSON.stringify(valid)).toBe(before)
    for (const invalid of [
      {},
      { user: {} },
      { user: { name: 'A' } },
      { user: { name: 'Ada', age: '2' } },
      { user: { name: 'Ada', age: 0 } },
      { user: { name: 'Ada', injected: true } },
      { user: { name: 'Ada' }, tags: [] },
      { user: { name: 'Ada' }, tags: ['a', 'a'] },
      { user: { name: 'Ada' }, tags: ['c'] },
      { user: { name: 'Ada' }, injected: true },
    ])
      expect(validateAgainst(tool.parameters, invalid).ok).toBe(false)
  })

  it('validates the standard uri format without changing the provider schema', async () => {
    const schema = {
      type: 'object',
      properties: { url: { type: 'string', format: 'uri', minLength: 1 } },
      required: ['url'],
      additionalProperties: false,
    }
    const tool = await registered(schema)
    const valid = { url: 'https://example.com/path?query=value#fragment' }
    const before = JSON.stringify(valid)
    expect(validateAgainst(tool.parameters, valid).ok).toBe(true)
    expect(JSON.stringify(valid)).toBe(before)
    expect(validateAgainst(tool.parameters, { url: 'not a uri' }).ok).toBe(false)
    expect(JSON.parse(JSON.stringify(tool.parameters))).toEqual(schema)
  })

  it.each([
    { type: 'bogus' },
    { type: 'object', properties: { x: { type: 'string', minLength: -1 } } },
    { type: 'object', properties: { x: { type: 'string', pattern: '[' } } },
    { type: 'object', properties: { x: { type: 'string', unknownConstraint: true } } },
    { type: 'object', $async: true },
    { type: 'object', $ref: 'https://example.invalid/private-schema' },
    { type: 'object', properties: { x: { type: 'string', format: 'unknown-format' } } },
  ])('skips a tool with an invalid or unsupported schema before registration: %j', async (schema) => {
    await expect(attempted(schema)).resolves.toEqual({ skipped: [{ code: 'invalid-schema', name: 'probe' }] })
  })
})

it('retains validation in real core registry snapshots and copied parameter objects', async () => {
  const tool = await registered({
    type: 'object',
    properties: { count: { type: 'integer' } },
    required: ['count'],
    additionalProperties: false,
  })
  const registry = new ToolRegistry()
  registry.add(tool, { source: 'mcp-schema-test', trust: 'builtin' })
  const parameters = registry.snapshot(0).byName.get(tool.name)?.parameters
  expect(parameters).toBeDefined()
  if (!parameters) throw new Error('missing snapshot schema')
  expect(validateAgainst(parameters, { count: 1 }).ok).toBe(true)
  expect(validateAgainst({ ...parameters }, { count: '1' }).ok).toBe(false)
  expect(JSON.stringify(parameters)).not.toContain('AgnesMcp')
})

it('enforces schema-valued extra properties and does not insert schema defaults', async () => {
  const tool = await registered({
    type: 'object',
    properties: { count: { type: 'integer', default: 3 } },
    additionalProperties: { type: 'string' },
  })
  const args = { extra: 'allowed' }
  expect(validateAgainst(tool.parameters, args).ok).toBe(true)
  expect(args).toEqual({ extra: 'allowed' })
  expect(validateAgainst(tool.parameters, { extra: false }).ok).toBe(false)
})

it('does not expose remote schema content in compiler errors or skip reports', async () => {
  const schema = { type: 'object', $ref: 'https://private.invalid/synthetic-secret' }
  expect(() => remoteInputSchema(schema)).toThrow(/^invalid synchronous MCP JSON schema$/)
  expect(JSON.stringify(await attempted(schema))).not.toContain('synthetic-secret')
})
