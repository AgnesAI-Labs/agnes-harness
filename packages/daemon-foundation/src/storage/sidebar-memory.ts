import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { rpcError, type WorkspaceEntry } from '@agnes/protocol'
import type { SessionMetaRow } from '../local/ports.js'
import type { SessionWorkspacePort } from './lister.js'
import type { SessionPrincipalOwnership } from './session-ownership.js'
import type { SessionPreferencesStore } from './session-preferences.js'
import type { SidebarPage, SidebarSessionPort } from './sidebar-sessions.js'

/** Embedded, non-persistent hosts only. Production always uses the SQL index. */
export class MemorySidebarSessions implements SidebarSessionPort {
  private readonly instance = randomUUID()
  private readonly secret = randomBytes(32)
  private scope(principal: string): string {
    return createHash('sha256').update(principal).digest('hex')
  }
  constructor(
    private readonly sessions: SessionWorkspacePort,
    private readonly owners: SessionPrincipalOwnership,
    private readonly preferences: SessionPreferencesStore,
    private readonly directories: () => Promise<{ items: WorkspaceEntry[] }>,
  ) {}
  async close(): Promise<void> {}
  private async view(principal: string) {
    const directories = (await this.directories()).items
    const groups = new Map<string, Array<SessionMetaRow & { sort: number; at: number }>>()
    groups.set('pinned', [])
    for (const directory of directories) if (directory.workspaceId) groups.set(directory.workspaceId, [])
    groups.set('unassigned', [])
    for (const key of this.owners.activeSessionIds(principal)) {
      const meta = this.sessions.metadata(key),
        cwd = this.sessions.get(key)
      if (!meta || this.preferences.get(key).archived) continue
      const { profileHash: _hash, lastActiveAt: _active, ...metadata } = meta
      const fork = this.owners.lineage(key)
      const row = this.preferences.apply({
        ...metadata,
        sessionId: key,
        ...(cwd ? { cwd } : {}),
        ...(fork ? { parent: fork.parent, forkAt: fork.forkAt } : {}),
      })
      const group = row.pinnedAt
        ? 'pinned'
        : (directories.find((entry) => entry.path === cwd)?.workspaceId ?? 'unassigned')
      const parsed = Date.parse(meta.lastMessageAt ?? meta.createdAt),
        at = Number.isFinite(parsed) ? parsed : 0
      // The pinned group orders by pin time; every other group by its last message.
      groups.get(group)!.push({ ...row, at, sort: row.pinnedAt ? Date.parse(row.pinnedAt) : at })
    }
    return [...groups]
      .map(([groupId, rows]) => {
        rows.sort(
          (a, b) => b.sort - a.sort || Buffer.compare(Buffer.from(b.sessionId), Buffer.from(a.sessionId)),
        )
        const revision = createHash('sha256')
          .update(JSON.stringify(rows.map((row) => [row.sessionId, row.sort, !!row.createdAt])))
          .digest('hex')
        const latest = Math.max(...rows.map((row) => row.at))
        return {
          groupId,
          ...(groupId !== 'unassigned' && groupId !== 'pinned' ? { workspaceId: groupId } : {}),
          rows,
          revision: `${this.instance}:${revision}`,
          total: rows.length,
          ready: rows.every((row) => !!row.createdAt),
          lastMessageAt: rows.length ? new Date(latest).toISOString() : null,
        }
      })
      .sort(
        (a, b) =>
          +(b.groupId === 'pinned') - +(a.groupId === 'pinned') ||
          (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '') ||
          Buffer.compare(Buffer.from(a.groupId), Buffer.from(b.groupId)),
      )
  }
  async groups(principal: string) {
    const items = (await this.view(principal)).map(({ rows: _rows, ...group }) => group)
    return { items, ready: items.every((group) => group.ready) }
  }
  async list(
    principal: string,
    input: { groupId: string; limit?: number; cursor?: string },
  ): Promise<SidebarPage> {
    const fail = (code: string): never => {
      throw rpcError('SEMANTIC_REJECTED', { code })
    }
    const limit = input.limit ?? 5
    if (!Number.isInteger(limit) || limit < 1 || limit > 5) fail('SESSION_SIDEBAR_LIMIT_INVALID')
    const group = (await this.view(principal)).find((item) => item.groupId === input.groupId)
    if (!group) return fail('SESSION_SIDEBAR_GROUP_INVALID')
    if (!group.ready) fail('SESSION_SIDEBAR_NOT_READY')
    let after: string | undefined
    if (input.cursor) {
      try {
        const [data, signature, extra] = input.cursor.split('.')
        if (input.cursor.length > 4096 || !data || !signature || extra !== undefined) throw new Error()
        const value = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as unknown[]
        if (!Array.isArray(value) || value.length !== 5) throw new Error()
        if (value[0] !== this.instance) fail('SESSION_SIDEBAR_CURSOR_STALE')
        if (
          signature !== createHmac('sha256', this.secret).update(data).digest('base64url') ||
          value[1] !== this.scope(principal) ||
          value[2] !== input.groupId ||
          typeof value[4] !== 'string'
        )
          throw new Error()
        if (value[3] !== group.revision) fail('SESSION_SIDEBAR_CURSOR_STALE')
        after = value[4] as string
      } catch (error) {
        if ((error as { data?: { code?: string } })?.data?.code === 'SESSION_SIDEBAR_CURSOR_STALE')
          throw error
        fail('SESSION_SIDEBAR_CURSOR_INVALID')
      }
    }
    const start = after === undefined ? 0 : group.rows.findIndex((row) => row.sessionId === after) + 1
    if (after !== undefined && start === 0) fail('SESSION_SIDEBAR_CURSOR_INVALID')
    const items = group.rows.slice(start, start + limit).map(({ sort: _sort, at: _at, ...row }) => row)
    let next: string | undefined
    if (start + limit < group.rows.length) {
      const data = Buffer.from(
        JSON.stringify([
          this.instance,
          this.scope(principal),
          input.groupId,
          group.revision,
          items.at(-1)!.sessionId,
        ]),
      ).toString('base64url')
      next = `${data}.${createHmac('sha256', this.secret).update(data).digest('base64url')}`
    }
    return { items, total: group.total, revision: group.revision, ...(next ? { next } : {}) }
  }
}
