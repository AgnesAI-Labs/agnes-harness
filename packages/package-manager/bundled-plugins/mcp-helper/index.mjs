import { array, enumeration, object, optional, string } from './src/schema.mjs'

export const mcpHelper = {
  inject: ['extension'],
  apply(ctx) {
    ctx.extension().registerTool({
      name: 'mcp_manage',
      description:
        'Connect MCP servers to this Agnes Harness (AGH), visible in Settings → MCP. Use prepare with a definition, then commit its proposalId for native user confirmation. Default target is AGH, not another client. Dependencies/add-ons alone are not registration. End this turn after submission; tools become available on later turns. Use list/status to verify actual results. Credentials belong in AGH secure settings, never chat.',
      parameters: object({
        action: enumeration('prepare', 'commit', 'status', 'cancel', 'list'),
        definition: optional(
          object({
            serverId: string(128),
            displayName: string(256),
            transport: {
              [Symbol.for('TypeBox.Kind')]: 'Union',
              anyOf: [
                object({ kind: enumeration('stdio'), executable: string(), args: array(string(), 256) }),
                object({ kind: enumeration('http', 'sse'), url: string() }),
              ],
            },
            secretBinding: object({ kind: enumeration('none') }),
          }),
        ),
        proposalId: optional(string(80)),
      }),
      meta: {
        isReadOnly: false,
        isDestructive: false,
        isConcurrencySafe: false,
        isOpenWorld: true,
        replay: 'never',
        costHint: {},
        deferLoading: false,
        requiresApproval: 'never',
      },
      async execute(input, ctx) {
        if (!ctx.mcpManage) throw new Error('AGH_MCP_MANAGEMENT_UNAVAILABLE: use AGH Settings → MCP')
        const result = await ctx.mcpManage.request(input)
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      },
    })
  },
}
