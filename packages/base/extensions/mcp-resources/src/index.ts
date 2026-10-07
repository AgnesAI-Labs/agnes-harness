import { defineExtension, defineTool } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import { runSharedMcpResource } from '../../../src/mcp/resources.js'

const readOnly = Object.freeze({
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: true,
  replay: 'safe' as const,
  costHint: Object.freeze({}),
  deferLoading: false,
  requiresApproval: undefined,
})

const server = Type.String({ minLength: 1, maxLength: 256 })
const cursor = Type.Optional(Type.String({ maxLength: 1024 }))

export default defineExtension((agnes) => {
  const disposers = [
    agnes.registerTool(
      defineTool({
        name: 'list_mcp_resources',
        description:
          'List one page of resources from a connected MCP server. Pass the server id, and pass nextCursor back as cursor.',
        parameters: Type.Object({ server, cursor }, { additionalProperties: false }),
        meta: readOnly,
        execute: (args, ctx) => runSharedMcpResource('list', args, ctx),
      }),
    ),
    agnes.registerTool(
      defineTool({
        name: 'list_mcp_resource_templates',
        description:
          'List one page of resource URI templates from a connected MCP server. Pass the server id, and pass nextCursor back as cursor.',
        parameters: Type.Object({ server, cursor }, { additionalProperties: false }),
        meta: readOnly,
        execute: (args, ctx) => runSharedMcpResource('templates', args, ctx),
      }),
    ),
    agnes.registerTool(
      defineTool({
        name: 'read_mcp_resource',
        description: 'Read one resource or expanded template URI from a connected MCP server.',
        parameters: Type.Object(
          { server, uri: Type.String({ minLength: 1, maxLength: 4096 }) },
          { additionalProperties: false },
        ),
        meta: readOnly,
        execute: (args, ctx) => runSharedMcpResource('read', args, ctx),
      }),
    ),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
})
