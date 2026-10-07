import { readFileSync } from 'node:fs'
import { type Context, defineAgnesPlugin } from '@agnes/plugin-runtime'
import type { McpServerDefinitionInput } from '@agnes/protocol'
import '@agnes/resource-control-runtime'

export const mcpServer: McpServerDefinitionInput = {
  serverId: '__SKILL_NAME__',
  displayName: '__PACKAGE_NAME__',
  transport: { kind: 'http', url: 'http://127.0.0.1:3001/mcp' },
  secretBinding: { kind: 'none' },
}
export const main = defineAgnesPlugin({
  inject: ['skills'],
  apply(ctx: Context) {
    const body = readFileSync(new URL('../skills/__SKILL_NAME__/SKILL.md', import.meta.url), 'utf8')
    ctx.skills.register({
      name: '__SKILL_NAME__',
      description: 'Use the bundled MCP integration to answer with evidence.',
      body,
    })
  },
})
