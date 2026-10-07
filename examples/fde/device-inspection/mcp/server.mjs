import { createInterface } from 'node:readline'
import { createFixture, toolCatalog } from './fixture.mjs'

const fixture = createFixture()
// A small local MCP stdio fixture: stdout contains only JSON-RPC messages.
const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  let request
  try {
    request = JSON.parse(line)
    if (request.id === undefined) return
    let result
    switch (request.method) {
      case 'initialize':
        result = {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'fde-local-fixture', version: '1.0.0' },
        }
        break
      case 'ping':
        result = {}
        break
      case 'tools/list':
        result = { tools: toolCatalog }
        break
      case 'tools/call':
        result = fixture.call(request.params.name, request.params.arguments ?? {})
        break
      default:
        throw new Error('Unsupported fixture method')
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
  } catch (error) {
    if (request?.id !== undefined)
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: error.message } }) +
          '\n',
      )
  }
})
