import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const ledger = process.argv[2]
const mode = process.argv[3]
const reader = createInterface({ input: process.stdin })
reader.on('close', () => process.exit(0))
reader.on('line', (line) => {
  const message = JSON.parse(line)
  if (ledger)
    appendFileSync(
      ledger,
      `${JSON.stringify({ method: message.method, name: message.params?.name ?? null })}\n`,
    )
  if (message.method === 'notifications/initialized') return
  let result
  if (message.method === 'initialize')
    result = {
      protocolVersion: mode === 'wrong-version' ? '2025-03-25' : '2025-03-26',
      capabilities: { tools: {}, ...(mode === 'no-resources' ? {} : { resources: {} }) },
      serverInfo: { name: 'fixture', version: '1' },
    }
  else if (message.method === 'tools/list')
    result = {
      tools: (mode === 'duplicate-catalog' ? ['echo', 'echo'] : ['echo', 'hang', 'state']).map((name) => ({
        name,
        inputSchema: { type: 'object' },
      })),
    }
  else if (message.method === 'resources/read')
    result = { contents: [{ uri: message.params.uri, text: 'fixture-resource' }] }
  else if (message.method === 'tools/call') {
    if (message.params.name === 'hang') return
    if (!['echo', 'state'].includes(message.params.name)) {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Unknown tool' } })}\n`,
      )
      return
    }
    result = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            value: message.params.arguments?.value ?? null,
            pid: process.pid,
            environment: Object.keys(process.env),
          }),
        },
      ],
    }
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
})
