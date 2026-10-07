import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

/** An ordinary trusted connector. It owns its stdio process and closes it on plugin unload. */
export function fixtureConnector(serverUrl) {
  let connection
  let closed = false
  async function open() {
    if (closed) throw new Error('MCP fixture connector is disposed')
    if (!connection)
      connection = (async () => {
        const client = new Client({ name: 'fde-fixture-client', version: '1.0.0' }, { capabilities: {} })
        try {
          await client.connect(
            new StdioClientTransport({
              command: process.execPath,
              args: [fileURLToPath(serverUrl)],
              stderr: 'pipe',
            }),
          )
          if (closed) {
            await client.close()
            throw new Error('MCP fixture connector is disposed')
          }
          return client
        } catch (error) {
          await client.close().catch(() => {})
          throw error
        }
      })()
    return connection
  }
  return {
    async call(name, args, signal) {
      signal.throwIfAborted()
      const client = await open()
      signal.throwIfAborted()
      return client.callTool({ name, arguments: args }, undefined, { signal, timeout: 5000 })
    },
    async close() {
      closed = true
      const client = await connection?.catch(() => undefined)
      await client?.close()
    },
  }
}
