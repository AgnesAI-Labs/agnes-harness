/**
 * Local MCP server with one tool and a few resources. Tests spawn it over stdio and also
 * attach the same server to Streamable HTTP and legacy SSE.
 */
const { Server } = require('@modelcontextprotocol/sdk/server/index.js')
const {
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js')

function createFixtureServer() {
  const server = new Server({ name: 'mcp-fixture', version: '1' }, { capabilities: { tools: {}, resources: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'echo',
        description: 'Echo text',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      },
    ],
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: 'text', text: String(request.params.arguments?.text ?? '') }],
  }))
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: 'memo://readme', name: 'readme', mimeType: 'text/plain' }],
  }))
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [{ uriTemplate: 'memo://item/{id}', name: 'item' }],
  }))
  server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
    const uri = request.params.uri
    if (uri === 'memo://slow') {
      await new Promise((resolve, reject) => {
        const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        if (extra?.signal?.aborted) {
          fail()
          return
        }
        const timer = setTimeout(resolve, 30_000)
        extra?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            fail()
          },
          { once: true },
        )
      })
    }
    if (uri === 'memo://readme') return { contents: [{ uri, mimeType: 'text/plain', text: 'fixture readme' }] }
    const item = /^memo:\/\/item\/(.+)$/.exec(uri)
    if (item) return { contents: [{ uri, mimeType: 'text/plain', text: `item ${item[1]}` }] }
    throw new Error(`unknown resource ${uri}`)
  })
  return server
}

module.exports = { createFixtureServer }

if (require.main === module) {
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
  const server = createFixtureServer()
  server.connect(new StdioServerTransport()).catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
