import { escapeControl } from '@agnes/cli-tui'
import type { PageSessionMeta } from '@agnes/protocol'
import type { NodeClient } from '@agnes/sdk'
import { ExitCode, UsageError } from '../errors.js'
import { newPackageCommandId } from '../tui/package-admin.js'
import type { ParsedArgs } from '../types.js'
import { approvalsCommand } from './approvals.js'
import { credentialsCommand } from './credentials.js'
import { deliverablesCommand } from './deliverables.js'
import { schedulesCommand } from './schedules.js'
import { MANAGE_ACTIONS, manageSessions, oneLine } from './sessions-manage.js'
import { settingsCommand } from './settings.js'
import { triggersCommand } from './triggers.js'
import { undoCommand } from './undo.js'

type SessionsIO = {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}

function json(page: PageSessionMeta): string {
  return `${JSON.stringify(page)}\n`
}

function line(item: PageSessionMeta['items'][number]): string {
  const preset = item.preset ?? 'default'
  // Human-facing text: scripts should read --json. cwd sits before the title, which stays last.
  const pinned = item.pinnedAt ? 'pinned' : '-'
  return `${item.sessionId}\t${item.lastSeq}\t${preset}\t${pinned}\t${item.lastMessageAt ?? item.createdAt}\t${oneLine(item.cwd)}\t${oneLine(item.title)}`
}

const inert = oneLine

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

const activity = (item: PageSessionMeta['items'][number]): number => {
  const t = Date.parse(item.lastMessageAt ?? item.createdAt)
  return Number.isFinite(t) ? t : 0
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (!(n >= 1 && n <= 500)) throw new UsageError('--limit expects an integer from 1 to 500')
  return n
}

/**
 * One page, or with `walk` every page by following `next` (a repeated cursor stops the loop instead
 * of spinning). `cap` bounds the total item count; `next` is dropped when everything was read.
 */
async function listPages(
  client: NodeClient,
  q: { text?: string; cwd?: string } | undefined,
  pageSize: number,
  walk: boolean,
  cap: number | undefined,
): Promise<PageSessionMeta> {
  const items: PageSessionMeta['items'] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  while (true) {
    const size = walk ? Math.min(500, cap === undefined ? 500 : cap - items.length) : pageSize
    const page = await client.session.list({
      limit: size,
      ...(q ? { q } : {}),
      ...(cursor ? { cursor } : {}),
    })
    items.push(...page.items)
    if (!walk) return page
    if (!page.next || seen.has(page.next) || (cap !== undefined && items.length >= cap))
      return { items: cap === undefined ? items : items.slice(0, cap) }
    seen.add(page.next)
    cursor = page.next
  }
}

/**
 * Lists the daemon-owned session index. The command intentionally uses the SDK session.list
 * surface even for `show`: the CLI does not read sessions.db or reconstruct a second history view.
 */
export async function sessionsCommand(p: ParsedArgs, client: NodeClient, io: SessionsIO): Promise<number> {
  if (p.command === 'approvals') return approvalsCommand(p, client, io)
  if (p.command === 'schedules') return schedulesCommand(p, client, io)
  if (p.command === 'triggers') return triggersCommand(p, client, io)
  if (p.command === 'settings') return settingsCommand(p, client, io)
  if (p.command === 'credentials') return credentialsCommand(p, client, io)
  if (p.command === 'agents') return (await import('./agents.js')).agentsCommand(p, client, io)
  if (p.command === 'api') return (await import('./api.js')).apiCommand(p, client, io)
  if (p.command === 'queue') return (await import('./queue.js')).queueCommand(p, client, io)
  const action = p.positional[0] ?? 'list'
  if (action === 'verify') {
    const id = p.positional[1]
    if (!id || p.positional.length !== 2) throw new UsageError('sessions verify expects <id>')
    if (!p.json) io.stderr.write('Verifying history…\n')
    const result = await client.session.integrity(id, true)
    io.stdout.write(
      p.json
        ? `${JSON.stringify(result)}\n`
        : `${result.state}: through seq ${result.verifiedThroughSeq}${result.verifiedAtMs === undefined ? '' : `; verified at ${new Date(result.verifiedAtMs).toISOString()}`}${result.failureSeq === undefined ? '' : `; failed at seq ${result.failureSeq}`}\n`,
    )
    return result.state === 'verified' ? ExitCode.OK : ExitCode.ERROR
  }
  if (action === 'migrate') {
    const sessionId = p.positional[1]
    if (!sessionId) throw new UsageError('sessions migrate expects <key> [<pinned seam kind> ...]')
    // Kinds after the key are the pinned seam implementations the administrator agrees to replace.
    const repin = p.positional.slice(2)
    const result = await client.packages.migrateSession({
      profile: p.profile ?? 'local-dev',
      clientId: await client.clientId(),
      commandId: newPackageCommandId('migrate'),
      sessionId,
      ...(repin.length ? { repin } : {}),
    })
    io.stdout.write(
      p.json
        ? `${JSON.stringify(result)}\n`
        : `${escapeControl(sessionId)}: ${result.changed ? 'migrated to' : 'already bound to'} current plugins (${result.generationId})${result.repinned?.length ? `; replaced pinned ${result.repinned.join(', ')}` : ''}\n`,
    )
    return ExitCode.OK
  }
  if (action === 'deliverables') return deliverablesCommand(p, client, io)
  if (action === 'undo') return undoCommand(p, client, io)
  const managed = MANAGE_ACTIONS.find((a) => a === action)
  if (managed) return manageSessions(managed, p, client, io)
  if (action !== 'list' && action !== 'show')
    throw new UsageError(
      'sessions expects list, show, pin, unpin, rename, archive, unarchive, search, groups, deliverables, undo, verify or migrate',
    )

  const id = action === 'show' ? p.positional[1] : undefined
  if (action === 'show' && (!id || p.positional.length > 2))
    throw new UsageError('sessions show expects <id>')
  if (action === 'list' && p.positional.length > 1)
    throw new UsageError('sessions list takes no positional arguments')

  const q = id || p.cwd ? { ...(id ? { text: id } : {}), ...(p.cwd ? { cwd: p.cwd } : {}) } : undefined
  const limit = action === 'list' ? parseLimit(p.limit) : undefined
  // --last needs the whole index: the protocol has no sort, so the newest activity can be on any page.
  const walk = action === 'list' && (p.all === true || p.last === true)
  const listed = await listPages(
    client,
    q,
    action === 'show' ? 500 : (limit ?? 50),
    walk,
    p.last ? undefined : limit,
  )
  // `q` is a search hint in the protocol, not an equality predicate. Keep `show` from printing a
  // different session when a daemon returns a prefix match or a fuzzy match. `show` reads the
  // daemon's full page (500): a fork child's key embeds its parent's id, and the list is ordered by
  // recent activity, so a busier child can rank ahead of the exact session being asked for.
  // The daemon has no archived filter, so `--archived` narrows the returned page here.
  let page: PageSessionMeta = id
    ? { ...listed, items: listed.items.filter((item) => item.sessionId === id) }
    : p.archived
      ? { ...listed, items: listed.items.filter((item) => item.archived) }
      : listed
  // An id that matches nothing is a failed lookup, not an empty listing: a script has to be able to
  // tell a typo from success, so it exits 1 whether or not --json was asked for.
  if (id && page.items.length === 0) {
    io.stderr.write(`no session ${escapeControl(id)}\n`)
    return ExitCode.ERROR
  }
  if (p.last) {
    const newest = page.items.reduce<PageSessionMeta['items'][number] | undefined>(
      (best, item) => (best && activity(best) >= activity(item) ? best : item),
      undefined,
    )
    page = { items: newest ? [newest] : [] }
  }
  if (action === 'list' && !walk && page.next)
    io.stderr.write('more sessions exist; use --all or a larger --limit\n')
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
