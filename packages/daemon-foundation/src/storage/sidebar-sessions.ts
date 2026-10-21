import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { type EventEnvelope, rpcError } from '@agnes/protocol'
import type { SessionMetaRow } from '../local/ports.js'
import type { SessionWorkspacePort } from './lister.js'
import { ensureSidebarSchema } from './sidebar-schema.js'
import type { TableHandle } from './table.js'

export type SidebarGroup = {
  groupId: string
  workspaceId?: string
  total: number
  lastMessageAt: string | null
  revision: string
  ready: boolean
  initializationError?: boolean
}
export type SidebarPage = { items: SessionMetaRow[]; next?: string; total: number; revision: string }
export type SidebarSessionPort = {
  groups(principal: string): Promise<{ items: SidebarGroup[]; ready: boolean }>
  list(principal: string, input: { groupId: string; cursor?: string; limit?: number }): Promise<SidebarPage>
}
type FactRead = (
  key: string,
  query: { fromSeq?: number; toSeq?: number; limit: number; order?: 'asc' | 'desc' },
) => Promise<EventEnvelope[]>
const ready =
  "s.created_at IS NOT NULL AND s.created_at != '' AND s.message_seq = s.last_seq AND s.message_seq >= s.sidebar_target_seq AND s.sidebar_failed = 0"
const visible = "o.principal_id = ? AND o.reservation_state = 'active' AND COALESCE(p.archived, 0) = 0"
const joins =
  'JOIN session_principal_ownership o ON o.session_id = s.session_key LEFT JOIN session_preferences p ON p.session_key = s.session_key'
const fail = (code: string, reason: string): never => {
  throw rpcError('SEMANTIC_REJECTED', { code, reason })
}
type Cursor = [string, string, string, number, number, number, string]

/** SQL owns filtering and keyset order. Only an authenticated caller may choose a group. */
export class SidebarSessions implements SidebarSessionPort {
  private readonly instance = randomUUID()
  private readonly secret = randomBytes(32)
  private repairing: Promise<void> | undefined
  private closed = false
  constructor(
    private readonly table: TableHandle,
    private readonly workspaces: SessionWorkspacePort,
    private readonly scan?: FactRead,
  ) {
    table.transaction(() => ensureSidebarSchema(table))
    this.repair()
  }
  async close(): Promise<void> {
    this.closed = true
    await this.repairing
  }
  private revision(principal: string, group: string): number {
    this.table.exec('INSERT OR IGNORE INTO sidebar_versions (principal_id, group_id) VALUES (?, ?)', [
      principal,
      group,
    ])
    return this.table.get<{ revision: number }>(
      'SELECT revision FROM sidebar_versions WHERE principal_id = ? AND group_id = ?',
      [principal, group],
    )!.revision
  }
  private known(group: string): void {
    if (
      group !== 'unassigned' &&
      group !== 'pinned' &&
      !this.table.get('SELECT workspace_id FROM workspace_registry WHERE workspace_id = ? AND listed = 1', [
        group,
      ])
    )
      fail('SESSION_SIDEBAR_GROUP_INVALID', 'Unknown session group')
  }
  private scope(principal: string): string {
    return createHash('sha256').update(principal).digest('hex')
  }
  private encode(value: Cursor): string {
    const data = Buffer.from(JSON.stringify(value)).toString('base64url')
    return `${data}.${createHmac('sha256', this.secret).update(data).digest('base64url')}`
  }
  private decode(cursor: string, principal: string, group: string): Cursor {
    try {
      if (cursor.length > 4096) throw new Error()
      const [data, mac, extra] = cursor.split('.')
      if (!data || !mac || extra !== undefined) throw new Error()
      const value: unknown = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'))
      if (!Array.isArray(value) || value.length !== 7 || typeof value[0] !== 'string') throw new Error()
      // A restart changes both the signing key and instance. Old cursors have an explicit recovery path.
      if (value[0] !== this.instance)
        fail('SESSION_SIDEBAR_CURSOR_STALE', 'Reload this group from the first page')
      const expected = createHmac('sha256', this.secret).update(data).digest(),
        supplied = Buffer.from(mac, 'base64url')
      if (
        expected.length !== supplied.length ||
        !timingSafeEqual(expected, supplied) ||
        value[1] !== this.scope(principal) ||
        value[2] !== group ||
        ![value[3], value[4], value[5]].every((n) => Number.isSafeInteger(n)) ||
        value[3] < 1 ||
        value[4] < 0 ||
        typeof value[6] !== 'string' ||
        value[6].length > 512
      )
        throw new Error()
      return value as Cursor
    } catch (error) {
      if ((error as { data?: { code?: string } })?.data?.code === 'SESSION_SIDEBAR_CURSOR_STALE') throw error
      return fail('SESSION_SIDEBAR_CURSOR_INVALID', 'Invalid session group cursor')
    }
  }
  async groups(principal: string): Promise<{ items: SidebarGroup[]; ready: boolean }> {
    const result = this.table.transaction(() => {
      const summary = this.table.all<{
        groupId: string
        total: number
        at: number
        pending: number
        failed: number
      }>(
        `SELECT CASE WHEN p.pinned_at IS NULL THEN s.sidebar_group ELSE 'pinned' END AS groupId, COUNT(*) AS total, MAX(s.sidebar_sort_at) AS at,
         SUM(CASE WHEN ${ready} THEN 0 ELSE 1 END) AS pending, MAX(s.sidebar_failed) AS failed FROM session_workspaces s ${joins}
         WHERE ${visible} GROUP BY CASE WHEN p.pinned_at IS NULL THEN s.sidebar_group ELSE 'pinned' END`,
        [principal],
      )
      const groups = this.table.all<{ workspace_id: string }>(
        'SELECT workspace_id FROM workspace_registry WHERE listed = 1 ORDER BY workspace_id',
      )
      const items = ['pinned', ...groups.map((row) => row.workspace_id), 'unassigned']
        .map((groupId) => {
          const row = summary.find((item) => item.groupId === groupId)
          return {
            groupId,
            ...(groupId !== 'unassigned' && groupId !== 'pinned' ? { workspaceId: groupId } : {}),
            total: row?.total ?? 0,
            lastMessageAt: row ? new Date(row.at).toISOString() : null,
            revision: `${this.instance}:${this.revision(principal, groupId)}`,
            ready: !row?.pending,
            ...(row?.failed ? { initializationError: true } : {}),
          }
        })
        .sort(
          (a, b) =>
            +(b.groupId === 'pinned') - +(a.groupId === 'pinned') ||
            (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '') ||
            (a.groupId < b.groupId ? -1 : 1),
        )
      return { items, ready: items.every((item) => item.ready) }
    })
    this.repair()
    return result
  }
  async list(
    principal: string,
    input: { groupId: string; cursor?: string; limit?: number },
  ): Promise<SidebarPage> {
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 5))
      fail('SESSION_SIDEBAR_LIMIT_INVALID', 'Session groups return at most five rows')
    this.known(input.groupId)
    const cursor =
      input.cursor === undefined ? undefined : this.decode(input.cursor, principal, input.groupId)
    // Pinned rows leave their workspace group and order by pin time; there are few, so no index.
    const pinned = input.groupId === 'pinned'
    const member = pinned ? 'p.pinned_at IS NOT NULL' : 'p.pinned_at IS NULL AND s.sidebar_group = ?'
    const order = pinned ? 'p.pinned_at' : 's.sidebar_sort_at'
    const params = pinned ? [principal] : [principal, input.groupId]
    return this.table.transaction(() => {
      const version = this.revision(principal, input.groupId),
        revision = `${this.instance}:${version}`
      if (cursor && cursor[3] !== version)
        fail('SESSION_SIDEBAR_CURSOR_STALE', 'Reload this group from the first page')
      const count = cursor
        ? { total: cursor[4], pending: 0 }
        : this.table.get<{ total: number; pending: number }>(
            `SELECT COUNT(*) AS total, SUM(CASE WHEN ${ready} THEN 0 ELSE 1 END) AS pending
         FROM session_workspaces s ${joins} WHERE ${visible} AND ${member}`,
            params,
          )!
      if (count.pending)
        fail('SESSION_SIDEBAR_NOT_READY', 'Message summaries are still initializing; refresh to retry')
      const limit = input.limit ?? 5
      const rows = this.table.all<
        Omit<SessionMetaRow, 'pinnedAt'> & {
          sortAt: number
          pinnedAt: number | null
          messageAt: number | null
          loopPin: string | null
          bookmarkIds: string | null
        }
      >(
        `SELECT s.session_key AS sessionId, s.created_at AS createdAt, s.last_seq AS lastSeq, s.generation, s.preset, s.cwd,
         COALESCE(p.title, s.title) AS title, CASE WHEN p.title IS NOT NULL THEN 'user' ELSE NULL END AS titleSource,
         ${order} AS sortAt, p.pinned_at AS pinnedAt, s.message_at AS messageAt, s.loop_pin AS loopPin, p.bookmarks AS bookmarkIds
         FROM session_workspaces s ${pinned ? '' : 'INDEXED BY sidebar_order'} ${joins}
         WHERE ${visible} AND ${member} ${cursor ? `AND (${order}, s.session_key) < (?, ?)` : ''}
         ORDER BY ${order} DESC, s.session_key COLLATE BINARY DESC LIMIT ?`,
        [...params, ...(cursor ? [cursor[5], cursor[6]] : []), limit + 1],
      )
      const page = rows.slice(0, limit),
        last = page.at(-1)
      const items = page.map(
        ({ sortAt: _sort, pinnedAt, messageAt, loopPin, bookmarkIds, titleSource, title, ...row }) => ({
          ...row,
          archived: false,
          ...(pinnedAt !== null ? { pinnedAt: new Date(pinnedAt).toISOString() } : {}),
          ...(title ? { title } : {}),
          ...(titleSource ? { titleSource } : {}),
          ...(messageAt !== null ? { lastMessageAt: new Date(messageAt).toISOString() } : {}),
          ...(loopPin && loopPin !== 'null' ? { loop: JSON.parse(loopPin) } : {}),
          ...(bookmarkIds ? { bookmarks: JSON.parse(bookmarkIds) } : {}),
        }),
      )
      return {
        items,
        total: count.total,
        revision,
        ...(rows.length > limit && last
          ? {
              next: this.encode([
                this.instance,
                this.scope(principal),
                input.groupId,
                version,
                count.total,
                last.sortAt,
                last.sessionId,
              ]),
            }
          : {}),
      }
    })
  }
  /** Bounded, resumable work; list never waits for every historical ledger or starts its workers. */
  private repair(): void {
    if (!this.scan || this.repairing || this.closed) return
    this.table.exec('UPDATE session_workspaces SET sidebar_failed = 0 WHERE sidebar_failed = 1')
    this.repairing = this.repairPending()
      .catch(() => undefined)
      .finally(() => {
        this.repairing = undefined
      })
  }
  private async repairPending(): Promise<void> {
    await setImmediate()
    while (!this.closed) {
      const row = this.table.get<{ key: string; seq: number; lastSeq: number }>(
        `SELECT s.session_key AS key, s.message_seq AS seq, s.last_seq AS lastSeq FROM session_workspaces s
         JOIN session_principal_ownership o ON o.session_id = s.session_key
         WHERE o.reservation_state = 'active' AND s.sidebar_failed = 0 AND NOT (${ready}) ORDER BY s.session_key LIMIT 1`,
      )
      if (!row || !this.scan) return
      try {
        const [end] = await this.scan(row.key, { order: 'desc', limit: 1 })
        if (!end || end.seq < row.lastSeq || end.seq <= row.seq) throw new Error('incomplete session history')
        const batch = await this.scan(row.key, { fromSeq: row.seq + 1, toSeq: end.seq, limit: 500 })
        if (this.closed) return
        this.table.transaction(() => {
          this.table.exec(
            'UPDATE session_workspaces SET sidebar_target_seq = MAX(sidebar_target_seq, ?) WHERE session_key = ?',
            [end.seq, row.key],
          )
          let sequence = row.seq
          const fold = () => {
            for (const event of batch) {
              if (event.seq !== ++sequence || event.seq > end.seq)
                throw new Error('incomplete session history')
              this.workspaces.observe(row.key, event)
            }
          }
          if (this.workspaces.batch) this.workspaces.batch(row.key, fold)
          else fold()
          if (!batch.length) throw new Error('incomplete session history')
        })
      } catch {
        if (!this.closed)
          this.table.exec('UPDATE session_workspaces SET sidebar_failed = 1 WHERE session_key = ?', [row.key])
      }
      await setImmediate()
    }
  }
}
