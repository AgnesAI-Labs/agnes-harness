import { type Context, defineAgnesPlugin, defineTool } from '@agnes/plugin-runtime'
import { Type } from '@sinclair/typebox'
import { runSharedMcpResource } from '../../../src/mcp/resources.js'

const readOnly = Object.freeze({
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: true,
  replay: 'safe' as const,
  costHint: Object.freeze({}),
  // Only servers that expose resources need these; they wait behind tool_search as one group.
  deferLoading: true,
  discoveryGroup: 'MCP resources (list and read resources a connected server exposes)',
})

const server = Type.String({ minLength: 1, maxLength: 256 })
const cursor = Type.Optional(Type.String({ maxLength: 1024 }))

export default defineAgnesPlugin({
  inject: ['tools'],
  apply(plugin: Context) {
    const disposers = [
      plugin.tools.register(
        defineTool({
          name: 'list_mcp_resources',
          description:
            'List one page of resources from a connected MCP server. Pass the server id, and pass nextCursor back as cursor.',
          parameters: Type.Object({ server, cursor }, { additionalProperties: false }),
          meta: readOnly,
          execute: (args, ctx) => runSharedMcpResource('list', args, ctx),
        }),
      ),
      plugin.tools.register(
        defineTool({
          name: 'list_mcp_resource_templates',
          description:
            'List one page of resource URI templates from a connected MCP server. Pass the server id, and pass nextCursor back as cursor.',
          parameters: Type.Object({ server, cursor }, { additionalProperties: false }),
          meta: readOnly,
          execute: (args, ctx) => runSharedMcpResource('templates', args, ctx),
        }),
      ),
      plugin.tools.register(
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
  },
})
