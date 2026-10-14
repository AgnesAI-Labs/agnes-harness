import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectMcp, type McpServerOpener, mcpPublicToolName } from '@agnes/base'
import { createTestHost } from '@agnes/host/testkit'
import type { InferenceEvent, JsonValue, McpServerDefinitionInput } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { createMcpRowRuntime } from '../src/mcp-row-runtime.js'

const baseDir = fileURLToPath(new URL('../../base', import.meta.url))
const baseRequire = createRequire(join(baseDir, 'package.json'))
const sdk = (file: string) => JSON.stringify(baseRequire.resolve(`@modelcontextprotocol/sdk/${file}`))
const TOOL_COUNT = 24

const call = (name: string, args: Record<string, JsonValue>): InferenceEvent[] => [
  { type: 'toolcall_end', via: 'native', call: { toolUseId: '', name, args, ordinal: 0 } },
  { type: 'done', reason: 'toolUse' },
]

/** A real stdio MCP server with many read-only tools; only `ledger_balance` answers with a marker. */
async function manyToolServer(directory: string): Promise<string> {
  const script = join(directory, 'many-tools-mcp.mjs')
  await writeFile(
    script,
    [
      "import { createRequire } from 'node:module'",
      'const require = createRequire(import.meta.url)',
      `const { Server } = require(${sdk('server/index.js')})`,
      `const { StdioServerTransport } = require(${sdk('server/stdio.js')})`,
      `const { ListToolsRequestSchema, CallToolRequestSchema } = require(${sdk('types.js')})`,
      "const server = new Server({ name: 'many-tools', version: '1.0.0' }, { capabilities: { tools: {} } })",
      `const tools = Array.from({ length: ${TOOL_COUNT - 1} }, (_, i) => ({ name: 'report_' + i, description: 'Build report number ' + i + ' for the warehouse team', inputSchema: { type: 'object', properties: { week: { type: 'integer' } } }, annotations: { readOnlyHint: true } }))`,
      "tools.push({ name: 'ledger_balance', description: 'Read the current ledger balance of an account', inputSchema: { type: 'object', properties: { account: { type: 'string' } }, required: ['account'] }, annotations: { readOnlyHint: true } })",
      'server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))',
      'server.setRequestHandler(CallToolRequestSchema, async (request) => ({',
      "  content: [{ type: 'text', text: request.params.name === 'ledger_balance' ? 'BALANCE_OK ' + request.params.arguments.account : 'report' }],",
      '}))',
      'await server.connect(new StdioServerTransport())',
    ].join('\n'),
    'utf8',
  )
  return script
}

const opener: McpServerOpener = {
  async connect(definition, signal) {
    if (definition.transport.kind !== 'stdio') throw new Error('fixture only supports stdio')
    return connectMcp(
      {
        id: definition.serverId,
        transport: 'stdio',
        cmd: [definition.transport.executable, ...definition.transport.args],
        defer: false,
      },
      undefined,
      { signal },
    )
  },
}

it('defers a large real MCP catalog, and a turn finds, loads and calls one of its tools', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mcp-deferred-'))
  const script = await manyToolServer(dataDir)
  const ledger = mcpPublicToolName('ledger', 'ledger_balance')
  const requests: { tools: string[]; system: string }[] = []
  const seen = (request: { tools: readonly { name: string }[]; system?: unknown }) =>
    requests.push({ tools: request.tools.map((tool) => tool.name), system: JSON.stringify(request.system) })
  const { host } = await createTestHost({
    dataDir,
    disableSessionTitle: true,
    packageDirs: { '@agnes/base': baseDir },
    script: [
      (request) => {
        seen(request)
        return call('tool_search', { query: 'ledger balance account' })
      },
      (request) => {
        seen(request)
        return call('tool_describe', { name: ledger })
      },
      (request) => {
        seen(request)
        return call(ledger, { account: 'ACME-7' })
      },
      (request) => {
        seen(request)
        return [
          { type: 'text_delta', delta: 'done' },
          { type: 'done', reason: 'stop' },
        ]
      },
    ],
  })
  try {
    const rows = createMcpRowRuntime({ host, opener })
    const result = await rows.apply([
      {
        definition: {
          serverId: 'ledger',
          displayName: 'Ledger Desk',
          transport: { kind: 'stdio', executable: process.execPath, args: [script] },
          secretBinding: { kind: 'none' },
        } as McpServerDefinitionInput,
        revision: 'r1',
        desired: 'enabled',
        trust: 'trusted',
      },
    ])
    expect(result.statuses.get('ledger')).toMatchObject({ connectionState: 'ready', toolCount: TOOL_COUNT })
    const session = await host.createSession({ key: 'deferred-mcp', cwd: dataDir })
    await session.enqueue('next-turn', {
      actor: session.d.actor,
      content: [{ type: 'text', text: 'What is the ledger balance of ACME-7?' }],
    })
    await session.run({ until: 'turn-end', signal: AbortSignal.timeout(20_000) })
    // Over the auto limit: no schema from this server is sent, only one line naming it.
    expect(requests[0]?.tools.some((name) => name.startsWith('mcp__ledger'))).toBe(false)
    expect(requests[0]?.system).toContain(`MCP server Ledger Desk — ${TOOL_COUNT} tools`)
    // Loaded by describe, it stays in every later request of the session.
    expect(requests[2]?.tools).toContain(ledger)
    expect(requests[3]?.tools).toContain(ledger)
    const results = JSON.stringify(
      (await session.scan({ type: 'tool/result', toSeq: session.lastSeq })).map((row) => row.data),
    )
    expect(results).toContain(ledger)
    expect(results).toContain('BALANCE_OK ACME-7')
    await session.close()
  } finally {
    await host.close()
    await rm(dataDir, { recursive: true, force: true })
  }
}, 60_000)
