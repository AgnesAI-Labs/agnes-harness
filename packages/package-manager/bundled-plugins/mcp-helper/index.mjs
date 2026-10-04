import { array, enumeration, object, optional, string, union } from './src/schema.mjs'

const definition = object({
  serverId: string(128),
  displayName: string(256),
  transport: union(
    object({ kind: enumeration('stdio'), executable: string(), args: array(string(), 256) }),
    object({ kind: enumeration('http', 'sse'), url: string() }),
  ),
  secretBinding: object({ kind: enumeration('none') }),
})
definition.description = 'Credential-free server definition for prepare; credentials use AGH secure settings.'
const proposalId = {
  ...string(80),
  description: 'Exact proposalId returned by prepare; required for commit, status and cancel.',
}
// Retain historical optional fields accepted by the Host, while requiring the selected action's input.
const optionalFields = { definition: optional(definition), proposalId: optional(proposalId) }

export const mcpHelper = {
  inject: ['extension'],
  apply(ctx) {
    ctx.extension().registerTool({
      name: 'mcp_manage',
      description:
        'Manage MCP servers in this AGH, visible in Settings → MCP. prepare requires a credential-free definition and returns prepared plus proposalId; it does not connect. commit requires that proposalId and requests native user confirmation to register, trust and enable the exact definition. status requires proposalId and reports actual connection state; cancel requires proposalId and requests cancellation; list needs only action and returns server items. registered/submitted are pending: end this turn, then query status on a later turn. ready establishes backend connection; use the actual turn tool catalog to check callable tools. changed/blocked/disabled require Settings review; failed/cancelled or denial require reporting and stopping, not automatic retry or bypass. Default target is AGH, not another client; dependencies/add-ons alone are not registration. Credentials belong in secure settings, never chat.',
      parameters: {
        // Providers require an object root. Keep Union's TypeBox tag so native validation also
        // enforces the action-specific branches rather than treating anyOf as an ignored annotation.
        ...object({
          ...optionalFields,
          action: enumeration('prepare', 'commit', 'status', 'cancel', 'list'),
        }),
        ...union(
          object({ ...optionalFields, action: enumeration('prepare'), definition }),
          ...['commit', 'status', 'cancel'].map((action) =>
            object({ ...optionalFields, action: enumeration(action), proposalId }),
          ),
          object({ ...optionalFields, action: enumeration('list') }),
        ),
      },
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
