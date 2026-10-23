import { UsageError } from '../errors.js'
import { tt } from '../tui/locale-extended.js'
import type { ParsedArgs } from '../types.js'

type Capable = {
  initialize(): Promise<{ capabilities: Record<string, unknown> }>
  workspace: { add(path: string): Promise<unknown> }
}

/**
 * The `session.new` fields for `--add-dir`: refuses before anything is created when the daemon does
 * not advertise `additionalDirectories` (an old daemon would silently ignore the list), then
 * registers each directory as a workspace, which is what the daemon requires of an extra directory.
 */
export async function addDirectoriesFor(
  client: Capable,
  p: ParsedArgs,
  locale: string,
): Promise<{ additionalDirectories?: string[] }> {
  if (!p.addDir?.length) return {}
  const caps = (await client.initialize()).capabilities.sessionCapabilities as
    | { additionalDirectories?: unknown }
    | undefined
  if (!caps?.additionalDirectories) throw new UsageError(tt('adddir.unsupported', locale))
  for (const dir of p.addDir) await client.workspace.add(dir)
  return { additionalDirectories: p.addDir }
}
