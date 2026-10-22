import { escapeControl } from '@agnes/cli-tui'
import type { SessionPreferences } from '@agnes/protocol'
import type { NodeClient } from '@agnes/sdk'
import { ExitCode, UsageError } from '../errors.js'
import type { ParsedArgs } from '../types.js'

type IO = { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream }

/** Titles, snippets and workspaces are external text: one inert line each. */
export const oneLine = (text: string | undefined): string =>
  text === undefined ? '-' : escapeControl(text).replace(/\n/g, ' ')

export const MANAGE_ACTIONS = ['pin', 'unpin', 'rename', 'archive', 'unarchive', 'search', 'groups'] as const

/** Preference writes echo what the daemon stored, so a refusal or clamp is visible, never assumed. */
async function preference(p: ParsedArgs, client: NodeClient, action: string): Promise<SessionPreferences> {
  const id = p.positional[1]
  if (action === 'rename') {
    const title = p.positional.slice(2).join(' ')
    if (!id || !title) throw new UsageError('sessions rename expects <id> <title...>')
    return client.session.rename(id, title)
  }
  if (!id || p.positional.length > 2) throw new UsageError(`sessions ${action} expects <id>`)
  if (action === 'pin' || action === 'unpin') return client.session.pin(id, action === 'pin')
  return client.session.archive(id, action === 'archive')
}

export async function manageSessions(
  action: (typeof MANAGE_ACTIONS)[number],
  p: ParsedArgs,
  client: NodeClient,
  io: IO,
): Promise<number> {
  if (action === 'groups') {
    if (p.positional.length > 1) throw new UsageError('sessions groups takes no positional arguments')
    const result = await client.session.groups()
    if (p.json) io.stdout.write(`${JSON.stringify(result)}\n`)
    else if (result.items.length === 0) io.stdout.write('no session groups\n')
    else
      io.stdout.write(
        `${result.items.map((g) => `${g.groupId}\t${g.total}\t${g.lastMessageAt ?? '-'}`).join('\n')}\n`,
      )
    return ExitCode.OK
  }
  if (action === 'search') {
    const query = p.positional.slice(1).join(' ')
    if (!query) throw new UsageError('sessions search expects <query...>')
    // admin tier: a client-tier daemon refuses, and that refusal is shown as it comes.
    const result = await client.call<{
      items: Array<{ sessionId: string; title: string; workspace: string; snippet: string; ts: string }>
      truncated: boolean
    }>('_agnes/v1/admin.history.search', { query, title: '', workspace: p.cwd ?? '' })
    if (p.json) {
      io.stdout.write(`${JSON.stringify(result)}\n`)
      return ExitCode.OK
    }
    if (result.items.length === 0) {
      io.stdout.write('no matches\n')
      return ExitCode.OK
    }
    const groups = new Map<string, typeof result.items>()
    for (const hit of result.items) groups.set(hit.sessionId, [...(groups.get(hit.sessionId) ?? []), hit])
    const out: string[] = []
    for (const [id, hits] of groups) {
      out.push(`${id}\t${oneLine(hits[0]?.title)}\t${oneLine(hits[0]?.workspace)}`)
      for (const hit of hits) out.push(`  ${hit.ts}  ${oneLine(hit.snippet)}`)
    }
    if (result.truncated) out.push('(truncated)')
    io.stdout.write(`${out.join('\n')}\n`)
    return ExitCode.OK
  }
  const prefs = await preference(p, client, action)
  if (p.json) io.stdout.write(`${JSON.stringify(prefs)}\n`)
  else {
    const id = escapeControl(p.positional[1] ?? '')
    const state =
      action === 'rename'
        ? `title ${oneLine(prefs.title)}`
        : action === 'pin' || action === 'unpin'
          ? prefs.pinnedAt
            ? 'pinned'
            : 'unpinned'
          : prefs.archived
            ? 'archived'
            : 'unarchived'
    io.stdout.write(`${id}: ${state}\n`)
  }
  return ExitCode.OK
}
