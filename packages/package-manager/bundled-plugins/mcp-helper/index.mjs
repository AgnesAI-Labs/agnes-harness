import { array, described, enumeration, object, optional, string } from './src/schema.mjs'

// Providers accept only a plain object root, so "proposalId is required for commit, status and
// cancel" cannot be a schema branch. The descriptions say it, and execute() answers a call that
// leaves it out with a definite error before anything is sent.
const NEEDS_PROPOSAL = new Set(['commit', 'status', 'cancel'])
const missingField = (input) =>
  input.action === 'prepare' && !input.definition
    ? 'definition'
    : NEEDS_PROPOSAL.has(input.action) && !input.proposalId
      ? 'proposalId'
      : undefined

export const mcpHelper = {
  inject: ['tools'],
  apply(ctx) {
    ctx.tools.register({
      name: 'mcp_manage',
      description:
        'Connect MCP servers to this Agnes Harness (AGH), visible in Settings → MCP. Use prepare with a definition, then commit its proposalId for native user confirmation. Default target is AGH, not another client. Dependencies/add-ons alone are not registration. End this turn after submission; tools become available on later turns. Use list/status to verify actual results. Community stdio defaults to strict sandbox; declare its absolute workspacePath and request workspace-write or network only when needed. off-with-warning requires explicit approval of full host access. Credentials belong in AGH secure settings, never chat.',
      parameters: object({
        action: described(
          enumeration('prepare', 'commit', 'status', 'cancel', 'list'),
          'prepare needs definition; commit, status and cancel need the proposalId prepare returned; list needs nothing.',
        ),
        definition: described(
          optional(
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
              sandboxProfile: optional(
                enumeration('strict', 'workspace-write', 'network', 'off-with-warning'),
              ),
              workspacePath: optional(string()),
              secretBinding: object({ kind: enumeration('none') }),
            }),
          ),
          'Required for prepare.',
        ),
        proposalId: described(
          optional(string(80)),
          'Required for commit, status and cancel: the proposalId returned by prepare.',
        ),
      }),
      meta: {
        isReadOnly: false,
        isDestructive: false,
        isConcurrencySafe: false,
        isOpenWorld: true,
        replay: 'never',
        costHint: {},
        deferLoading: true,
        discoveryGroup: 'MCP connections',
        requiresApproval: 'never',
      },
      async execute(input, ctx) {
        const missing = missingField(input)
        if (missing)
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `mcp_manage ${input.action} needs ${missing}; nothing was sent. Call prepare first and pass its proposalId, or use list to see connected servers.`,
              },
            ],
          }
        if (!ctx.mcpManage) throw new Error('AGH_MCP_MANAGEMENT_UNAVAILABLE: use AGH Settings → MCP')
        const result = await ctx.mcpManage.request(input)
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      },
    })
  },
}
