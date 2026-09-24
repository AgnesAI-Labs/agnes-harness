import { escapeControl } from '@agnes/cli-tui'
import type { PageSessionMeta } from '@agnes/protocol'
import type { Client } from '@agnes/sdk'
import { ExitCode, UsageError } from '../errors.js'
import type { ParsedArgs } from '../types.js'

type SessionsIO = {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}

function json(page: PageSessionMeta): string {
  return `${JSON.stringify(page)}\n`
}

function line(item: PageSessionMeta['items'][number]): string {
  const preset = item.preset ?? 'default'
  return `${item.sessionId}\t${item.lastSeq}\t${preset}`
}

/** A title is model-written and a cwd is whatever the caller opened: one inert line each. */
const inert = (text: string | undefined): string =>
  text === undefined ? '-' : escapeControl(text).replace(/\n/g, ' ')

function details(item: PageSessionMeta['items'][number]): string {
  const rows: Array<[string, string]> = [
    ['id', item.sessionId],
    ...(item.parent ? [['parent', item.parent] as [string, string]] : []),
    ['title', inert(item.title)],
    ['cwd', inert(item.cwd)],
    ['created', item.createdAt],
    ['lastSeq', String(item.lastSeq)],
    ['preset', item.preset ?? 'default'],
    ['archived', item.archived ? 'yes' : 'no'],
  ]
  return rows.map(([key, value]) => `${key.padEnd(9)}${value}`).join('\n')
}

/**
 * Lists the daemon-owned session index. The command intentionally uses the SDK session.list
 * surface even for `show`: the CLI does not read sessions.db or reconstruct a second history view.
 */
export async function sessionsCommand(p: ParsedArgs, client: Client, io: SessionsIO): Promise<number> {
  const action = p.positional[0] ?? 'list'
  if (action !== 'list' && action !== 'show') throw new UsageError('sessions expects list or show')

  const id = action === 'show' ? p.positional[1] : undefined
  if (action === 'show' && (!id || p.positional.length > 2))
    throw new UsageError('sessions show expects <id>')
  if (action === 'list' && p.positional.length > 1)
    throw new UsageError('sessions list takes no positional arguments')

  const q = id || p.cwd ? { ...(id ? { text: id } : {}), ...(p.cwd ? { cwd: p.cwd } : {}) } : undefined
  const listed = await client.session.list({
    limit: action === 'show' ? 500 : 50,
    ...(q ? { q } : {}),
  })
  // `q` is a search hint in the protocol, not an equality predicate. Keep `show` from printing a
  // different session when a daemon returns a prefix match or a fuzzy match. `show` reads the
  // daemon's full page (500): a fork child's key embeds its parent's id, and the list is ordered by
  // recent activity, so a busier child can rank ahead of the exact session being asked for.
  const page = id ? { ...listed, items: listed.items.filter((item) => item.sessionId === id) } : listed
  // An id that matches nothing is a failed lookup, not an empty listing: a script has to be able to
  // tell a typo from success, so it exits 1 whether or not --json was asked for.
  if (id && page.items.length === 0) {
    io.stderr.write(`no session ${escapeControl(id)}\n`)
    return ExitCode.ERROR
  }
  if (p.json) {
    io.stdout.write(json(page))
    return ExitCode.OK
  }
  if (page.items.length === 0) {
    io.stdout.write('no sessions\n')
    return ExitCode.OK
  }
  io.stdout.write(`${(id ? page.items.map(details) : page.items.map(line)).join('\n')}\n`)
  return ExitCode.OK
}
