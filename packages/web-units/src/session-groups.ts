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

/** The keys shown beside "New session"; browsers reserve ⌘N/Ctrl+N, so the page binds this chord. */
export function newSessionShortcutKeys(platform: string): string[] {
  return /mac|iphone|ipad/i.test(platform) ? ['⇧', '⌘', 'O'] : ['Ctrl', 'Shift', 'O']
}

/** The same chord as one string: `⇧⌘O`, or `Ctrl+Shift+O`. */
export function newSessionShortcutLabel(platform: string): string {
  return newSessionShortcutKeys(platform).join(/mac|iphone|ipad/i.test(platform) ? '' : '+')
}

export function isNewSessionShortcut(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
): boolean {
  if (event.altKey || !(event.metaKey || event.ctrlKey)) return false
  const key = event.key.toLowerCase()
  // ⌘N only arrives where the host leaves it to the page (a desktop shell); honour it there too.
  return event.shiftKey ? key === 'o' : key === 'n'
}

/**
 * What a session is called before it has a title: the plain name plus when it was started, so two
 * untitled sessions can be told apart without showing an internal id. Today reads as a time, any
 * other day as a date.
 */
export function untitledSessionLabel(
  name: string,
  createdAt: string | undefined,
  locale: string,
  now: number = Date.now(),
): string {
  const created = createdAt ? Date.parse(createdAt) : Number.NaN
  if (Number.isNaN(created)) return name
  const at = new Date(created)
  const today = new Date(now)
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate()
  const when = new Intl.DateTimeFormat(
    locale,
    sameDay
      ? { hour: '2-digit', minute: '2-digit', hour12: false }
      : {
          ...(at.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
          month: 'short',
          day: 'numeric',
        },
  ).format(at)
  return `${name} · ${when}`
}
