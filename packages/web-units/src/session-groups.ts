/** Sidebar sessions are grouped by the local day they were created on. */
export type SessionTimeGroup = 'today' | 'yesterday' | 'earlier'

export const SESSION_TIME_GROUPS: readonly SessionTimeGroup[] = ['today', 'yesterday', 'earlier']

export function sessionTimeGroup(createdAt: string | undefined, now: Date): SessionTimeGroup {
  const created = createdAt ? Date.parse(createdAt) : Number.NaN
  if (Number.isNaN(created)) return 'earlier'
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (created >= today) return 'today'
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime()
  return created >= yesterday ? 'yesterday' : 'earlier'
}

/** Stable partition: groups appear in calendar order, rows keep the backend's order inside a group. */
export function groupSessionsByTime<Row extends { createdAt?: string }>(
  rows: readonly Row[],
  now: Date,
): { group: SessionTimeGroup; rows: Row[] }[] {
  const buckets = new Map<SessionTimeGroup, Row[]>(SESSION_TIME_GROUPS.map((group) => [group, []]))
  for (const row of rows) buckets.get(sessionTimeGroup(row.createdAt, now))?.push(row)
  return SESSION_TIME_GROUPS.map((group) => ({ group, rows: buckets.get(group) ?? [] })).filter(
    (entry) => entry.rows.length > 0,
  )
}

/** The chip shown beside "New session"; browsers reserve ⌘N/Ctrl+N, so the page binds this chord. */
export function newSessionShortcutLabel(platform: string): string {
  return /mac|iphone|ipad/i.test(platform) ? '⇧⌘O' : 'Ctrl+Shift+O'
}

export function isNewSessionShortcut(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
): boolean {
  if (event.altKey || !(event.metaKey || event.ctrlKey)) return false
  const key = event.key.toLowerCase()
  // ⌘N only arrives where the host leaves it to the page (a desktop shell); honour it there too.
  return event.shiftKey ? key === 'o' : key === 'n'
}
