import { resolve } from 'node:path'
import { AGNES_ERRORS } from '@agnes/protocol'
import type { NodeClient } from '@agnes/sdk'
import { CommandError, ExitCode, UsageError } from '../errors.js'
import type { ParsedArgs } from '../types.js'
import { oneLine } from './sessions-manage.js'

const USAGE = 'usage: agh plugins grants [list [<package>]] | grant|revoke <package> <workspace> [--json]'

// Fixed text per refusal code; the daemon's message and data never reach stderr.
const REFUSALS: Readonly<Record<string, string>> = {
  CAPABILITY_DENIED:
    'CAPABILITY_DENIED: only the local owner can manage workspace grants, over the local admin connection.',
  PACKAGE_NOT_INSTALLED:
    'PACKAGE_NOT_INSTALLED: no installed plugin has that package id; see `agh package status`.',
  PACKAGE_WITHOUT_MANAGED_SESSIONS:
    'PACKAGE_WITHOUT_MANAGED_SESSIONS: that plugin declares no managed service with sessions, so there is nothing to grant.',
  WORKSPACE_NOT_REGISTERED:
    'WORKSPACE_NOT_REGISTERED: that path is not a registered, present workspace; register it first by starting `agh` in it or adding it in the Web workbench.',
  PLUGIN_ROW_AMBIGUOUS:
    'PLUGIN_ROW_AMBIGUOUS: another installed plugin declares the same plugin row id, so a grant cannot name one plugin; remove one of them.',
  MANAGED_SESSIONS_UNAVAILABLE: 'MANAGED_SESSIONS_UNAVAILABLE: this backend does not store managed sessions.',
}

function refusal(error: unknown): never {
  const value = error as { kind?: unknown; code?: unknown; data?: { code?: unknown } } | null
  const code = value?.data?.code
  if (
    value?.kind === 'json-rpc' &&
    (value.code === AGNES_ERRORS.SEMANTIC_REJECTED || value.code === AGNES_ERRORS.CAPABILITY_DENIED) &&
    typeof code === 'string' &&
    Object.hasOwn(REFUSALS, code)
  )
    throw new CommandError(REFUSALS[code] as string)
  throw error
}

/**
 * `agh plugins grants`: the workspaces the owner authorized for a plugin's managed sessions. Only
 * this command writes them; the plugin has no route to the admin methods it calls.
 */
export async function pluginGrantsCommand(
  p: ParsedArgs,
  client: NodeClient,
  write: (t: string) => void,
): Promise<number> {
  const [, action = 'list', packageId, workspace, ...extra] = p.positional
  if (extra.length) throw new UsageError(USAGE)
  if (action === 'list') {
    if (workspace !== undefined) throw new UsageError(USAGE)
    const result = await client
      .request('_agnes/v1/admin.managedWorkspaces.list', packageId === undefined ? {} : { packageId })
      .catch(refusal)
    if (p.json) write(`${JSON.stringify(result)}\n`)
    else if (!result.items.length) write('No workspace grants.\n')
    else for (const item of result.items) write(`${oneLine(item.packageId)}\t${oneLine(item.workspace)}\n`)
    return ExitCode.OK
  }
  if ((action !== 'grant' && action !== 'revoke') || !packageId || !workspace) throw new UsageError(USAGE)
  const params = { packageId, workspace: resolve(p.cwd ?? process.cwd(), workspace) }
  const result = await client
    .request(
      action === 'grant'
        ? '_agnes/v1/admin.managedWorkspaces.grant'
        : '_agnes/v1/admin.managedWorkspaces.revoke',
      params,
    )
    .catch(refusal)
  if (p.json) write(`${JSON.stringify(result)}\n`)
  else {
    const where = `${oneLine(result.packageId)}\t${oneLine(result.workspace)}`
    const verb = action === 'grant' ? 'granted' : 'revoked'
    write(
      `${result.changed ? verb : `already ${action === 'grant' ? 'granted' : 'not granted'}`}\t${where}\n`,
    )
  }
  return ExitCode.OK
}
