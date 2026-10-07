#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema, ReadResourceRequestSchema, McpError, ErrorCode,
} from '@modelcontextprotocol/sdk/types.js'
import { callTool, readResource, resourceCatalog, toolCatalog } from './fixture.mjs'

const server = new Server({ name: 'community-evidence', version: '0.1.0' }, { capabilities: { tools: {}, resources: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolCatalog }))
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: resourceCatalog }))
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }))
server.setRequestHandler(CallToolRequestSchema, async request => {
  try { return callTool(request.params.name, request.params.arguments) }
  catch (error) { throw new McpError(ErrorCode.InvalidParams, error.message) }
})
server.setRequestHandler(ReadResourceRequestSchema, async request => {
  try { return readResource(request.params.uri) }
  catch (error) { throw new McpError(ErrorCode.InvalidParams, error.message) }
})
process.once('SIGTERM', () => { void server.close() })
process.once('SIGINT', () => { void server.close() })
await server.connect(new StdioServerTransport())
// stdout is exclusively the MCP transport; diagnostics must use stderr.
