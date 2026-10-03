import { startMcpHttpServer } from '../../../../../tools/acceptance/runtime/fixtures/mcp-http-server.js'

const remote = await startMcpHttpServer()
process.send?.({ port: remote.port })
process.on('message', (message) => {
  if (message.op === 'rotate') remote.rotate()
  process.send?.({ id: message.id, calls: remote.calls() })
})
process.on('disconnect', () => {
  void remote.close().then(() => process.exit(0))
})
