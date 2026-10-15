import type { Json } from '@agnes/mhs-device'
import type { OwnedStore } from './ports.js'

export const ACTIVITY_WINDOW_MS = 7 * 86400_000
export const ACTIVITY_CAP = 10_000
export interface ActivityEvent {
  id: string
  at: number
  type: string
  device?: string
  sessionId?: string
  detail: Json
}
/** Display history is bounded independently of receipts and pending notification records. */
export class Activity {
  constructor(
    private readonly store: OwnedStore,
    private readonly now = Date.now,
  ) {}
  async append(type: string, detail: Json, device?: string, sessionId?: string): Promise<void> {
    await this.store.transaction((tx) => {
      const counter = tx.get('activity-sequence')
      const seq = Number(counter?.value ?? 0) + 1
      tx.put('activity-sequence', seq, counter?.revision ?? null)
      const id = String(seq).padStart(16, '0')
      tx.put(
        `event/${id}`,
        {
          id,
          at: this.now(),
          type,
          detail,
          ...(device ? { device } : {}),
          ...(sessionId ? { sessionId } : {}),
        },
        null,
      )
    })
    await this.prune()
  }
  async list(
    input: { cursor?: string; device?: string; sessionId?: string; limit?: number } = {},
  ): Promise<{ events: ActivityEvent[]; earliest: number | null; nextCursor?: string }> {
    const rows = await this.all()
    const visible = rows.filter((r) => r.at >= this.now() - ACTIVITY_WINDOW_MS)
    const matches = visible.filter(
      (r) =>
        (!input.cursor || r.id > input.cursor) &&
        (!input.device || r.device === input.device) &&
        (!input.sessionId || r.sessionId === input.sessionId),
    )
    const events = matches.slice(0, Math.max(1, Math.min(input.limit ?? 100, 1000)))
    return {
      events,
      earliest: visible[0]?.at ?? null,
      ...(matches.length > events.length ? { nextCursor: events.at(-1)?.id ?? '' } : {}),
    }
  }
  private async all(): Promise<ActivityEvent[]> {
    const events: ActivityEvent[] = []
    let cursor: string | undefined
    do {
      const page = await this.store.scan({ prefix: 'event/', limit: 100, ...(cursor ? { cursor } : {}) })
      events.push(...page.rows.map((r) => r.value as unknown as ActivityEvent))
      cursor = page.nextCursor
    } while (cursor)
    return events.sort((a, b) => a.id.localeCompare(b.id))
  }
  private async prune(): Promise<void> {
    const all = await this.all()
    const cutoff = this.now() - ACTIVITY_WINDOW_MS
    const expired = all.filter((r, i) => r.at < cutoff || i < all.length - ACTIVITY_CAP)
    for (const event of expired)
      await this.store.transaction((tx) => {
        const key = `event/${event.id}`
        const row = tx.get(key)
        if (row) tx.remove(key, row.revision)
      })
  }
}
