import type { PageSessionMeta } from '@agnes/protocol'
import type { NodeClient } from '@agnes/sdk'
import { ExitCode, UsageError } from '../errors.js'
import type { ParsedArgs } from '../types.js'
import { oneLine } from './sessions-manage.js'

type IO = { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream }
type Item = PageSessionMeta['items'][number]
type Controls = { paused: boolean; pending: Array<{ kind: string }> }

/** The daemon exposes no busy flag to a client, so a row reports what `session.controls` can prove. */
export type AgentState = 'paused' | 'queued' | 'open' | 'closed' | 'unknown'

export type AgentRow = {
  key: string
  title: string
  loop: string
  state: AgentState
  queued: number | null
  lastActivity: string
  cwd: string
}

export const AGENTS_DEFAULT_LIMIT = 50
export const AGENTS_CONCURRENCY = 8
const PAGE = 100

/** Runs `work` over `items` with at most `limit` in flight; results keep the input order. */
async function pool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const lane = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) out[i] = await work(items[i] as T)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return out
}

const codeOf = (error: unknown): string | undefined => {
  const data = (error as { data?: { code?: unknown } } | null)?.data
  return typeof data?.code === 'string' ? data.code : undefined
}

/** Unarchived sessions in the daemon's own recency order, read page by page up to `cap` (all when null). */
async function listSessions(
  client: NodeClient,
  cap: number | null,
): Promise<{ items: Item[]; more: boolean }> {
  const items: Item[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (;;) {
    const page = await client.session.list({ limit: PAGE, ...(cursor ? { cursor } : {}) })
    for (const item of page.items) if (!item.archived) items.push(item)
    cursor = page.next
    if (!cursor || seen.has(cursor)) break
    seen.add(cursor)
    if (cap !== null && items.length > cap) break
  }
  if (cap === null) return { items, more: false }
  return { items: items.slice(0, cap), more: items.length > cap || cursor !== undefined }
}

async function describe(client: NodeClient, item: Item): Promise<AgentRow> {
  const base = {
    key: item.sessionId,
    title: item.title ?? '',
    loop: item.loop ? `${item.loop.id}@${item.loop.version}` : (item.preset ?? '-'),
    lastActivity: item.lastMessageAt ?? item.createdAt,
    cwd: item.cwd ?? '',
  }
  try {
    // afterSeq at the head keeps the fact window empty: only the paused flag and the queue are wanted.
    const state = await client.call<Controls>('_agnes/v1/session.controls', {
      sessionId: item.sessionId,
      afterSeq: item.lastSeq,
    })
    const queued = state.pending.filter((p) => p.kind === 'follow_up' || p.kind === 'steer').length
    return { ...base, state: state.paused ? 'paused' : queued > 0 ? 'queued' : 'open', queued }
  } catch (error) {
    // A session the daemon does not hold live has nothing running or queued; any other failure stays unknown.
    if (codeOf(error) === 'SESSION_NOT_FOUND') return { ...base, state: 'closed', queued: 0 }
    return { ...base, state: 'unknown', queued: null }
  }
}

const clip = (text: string, width: number): string => {
  const chars = [...text]
  return chars.length > width ? `${chars.slice(0, width - 1).join('')}…` : text
}

function table(rows: AgentRow[]): string {
  const cells = rows.map((r) => [
    oneLine(r.key),
    clip(oneLine(r.title || '-'), 40),
    oneLine(r.loop),
    r.state,
    r.queued === null ? '-' : String(r.queued),
    oneLine(r.lastActivity),
  ])
  const all = [['KEY', 'TITLE', 'LOOP', 'STATE', 'QUEUED', 'LAST ACTIVITY'], ...cells]
  const widths = all[0]?.map((_, col) => Math.max(...all.map((row) => [...(row[col] ?? '')].length))) ?? []
  return all
    .map((row) =>
      row
        .map((cell, col) => (col === row.length - 1 ? cell : cell.padEnd(widths[col] ?? 0)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n')
}

/**
 * `agh agents [--all] [--json]`: the daemon's sessions with their run and queue state, one
 * `session.controls` read per session (at most 8 at a time). A session whose read fails is shown as
 * unknown and never hides the others. Reads only; nothing is opened, resumed or changed.
 */
export async function agentsCommand(p: ParsedArgs, client: NodeClient, io: IO): Promise<number> {
  if (p.positional.length > 0) throw new UsageError('agents takes no positional arguments')
  const { items, more } = await listSessions(client, p.all ? null : AGENTS_DEFAULT_LIMIT)
  const rows = await pool(items, AGENTS_CONCURRENCY, (item) => describe(client, item))
  if (p.json) {
    io.stdout.write(`${JSON.stringify({ items: rows, truncated: more })}\n`)
    return ExitCode.OK
  }
  if (rows.length === 0) {
    io.stdout.write('no sessions\n')
    return ExitCode.OK
  }
  io.stdout.write(`${table(rows)}\n`)
  if (more) io.stdout.write(`(showing the ${AGENTS_DEFAULT_LIMIT} most recent; --all lists every session)\n`)
  return ExitCode.OK
}
