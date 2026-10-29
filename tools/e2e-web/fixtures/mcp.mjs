// Synthetic dependency-free stdio MCP fixture. stdout is exclusively JSON-RPC.
import { createInterface } from 'node:readline'

const lines = createInterface({ input: process.stdin })
for await (const line of lines) {
  const message = JSON.parse(line)
  if (message.id === undefined) continue
  let result
  switch (message.method) {
    case 'initialize':
      result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'e2e', version: '1.0.0' },
      }
      break
    case 'ping':
      result = {}
      break
    case 'tools/list':
      result = {
        tools: [
          {
            name: 'echo',
            description: 'Echo synthetic test input',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
              additionalProperties: false,
            },
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
          },
        ],
      }
      break
    case 'tools/call':
      result = { content: [{ type: 'text', text: message.params.arguments.text }] }
      break
    default:
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })}\n`,
      )
      continue
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
}
