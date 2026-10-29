import { randomUUID } from 'node:crypto'
import { escapeControl } from '@agnes/cli-tui'
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
        ...(args.permission !== undefined || !args.agent ? { permission: args.permission ?? 'default' } : {}),
        ...(args.loop ? { loop: args.loop } : {}),
        ...(args.agent ? { agent: args.agent } : {}),
      })
  const catalog = await session.tools()
  if (args.json) return JSON.stringify(catalog, null, 2)
  // Names and descriptions come from MCP servers, skills and plugins: one line each, no escapes.
  const line = (s: string) => escapeControl(s).replace(/\n/g, ' ')
  return [
    `Session: ${session.id}`,
    'Tools:',
    ...catalog.tools.map(
      (tool) =>
        `  ${line(tool.name)} (${line(tool.source)}${tool.deferred ? ', deferred' : ''}) — ${line(tool.description)}`,
    ),
    'Resources (MCP / skills):',
    ...catalog.resources.map(
      (resource) =>
        `  ${line(resource.kind)}: ${line(resource.name)} (${line(resource.id)}) — ${line(resource.description)}`,
    ),
  ].join('\n')
}
