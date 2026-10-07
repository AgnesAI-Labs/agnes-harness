import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineAgnesPlugin, type Context } from '@agnes/plugin-runtime'
import type { McpServerDefinitionInput } from '@agnes/protocol'
import type {} from '@agnes/resource-control-runtime'

/** Register this reviewed definition separately through MCP management. */
export const mcpServer: McpServerDefinitionInput = {
  serverId: 'community-evidence',
  displayName: 'Community evidence',
  transport: { kind: 'stdio', executable: process.execPath, args: [fileURLToPath(new URL('../mcp/server.mjs', import.meta.url))] },
  secretBinding: { kind: 'none' },
}

export const main = defineAgnesPlugin({
  inject: ['skills'],
  apply(ctx: Context) {
    const body = readFileSync(new URL('../skills/mcp-skills/SKILL.md', import.meta.url), 'utf8')
    // Runtime contributions have no disk directory. The same packaged asset is
    // addressable through the MCP resource bridge rather than skill_read_file.
    ctx.skills.register({
      name: 'mcp-skills',
      description: 'Answer with evidence from the bundled local MCP server.',
      body: body.replace('](assets/reference.txt)', '](evidence://reference)'),
    })
  },
})
