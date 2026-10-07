import { randomUUID } from 'node:crypto'
import type { Booted, ParsedArgs } from '../types.js'

/** Creating an explicit fresh inspection session observes the latest published generation. */
export async function toolsCommand(boot: Booted, args: ParsedArgs, cwd: string): Promise<string> {
  await boot.client.workspace.add(cwd)
  const session = args.key
    ? await boot.client.session.load(args.key)
    : await boot.client.session.new({
        cwd,
        sessionKey: `agnes:local:${boot.profileName}:cli:tools:${randomUUID()}`,
        ...(args.preset ? { preset: args.preset } : {}),
        ...(args.loop ? { loop: args.loop } : {}),
      })
  const catalog = await session.tools()
  if (args.json) return JSON.stringify(catalog, null, 2)
  return [
    `Session: ${session.id}`,
    'Tools:',
    ...catalog.tools.map(
      (tool) => `  ${tool.name} (${tool.source}${tool.deferred ? ', deferred' : ''}) — ${tool.description}`,
    ),
    'Resources (MCP / skills):',
    ...catalog.resources.map(
      (resource) => `  ${resource.kind}: ${resource.name} (${resource.id}) — ${resource.description}`,
    ),
  ].join('\n')
}
