/**
 * Newest first by creation time, the only time a session row carries. Stable: rows without a
 * readable time keep the backend's order after the dated ones.
 */
export function sortSessionsByRecency<Row extends { createdAt?: string }>(rows: readonly Row[]): Row[] {
  const time = (row: Row) => {
    const created = row.createdAt ? Date.parse(row.createdAt) : Number.NaN
    return Number.isNaN(created) ? Number.NEGATIVE_INFINITY : created
  }
  return rows
    .map((row, index) => ({ row, index, time: time(row) }))
    .sort((left, right) => (left.time === right.time ? left.index - right.index : right.time - left.time))
    .map((entry) => entry.row)
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
