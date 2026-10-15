import { randomUUID } from 'node:crypto'
import { type Json, MhsError } from '@agnes/mhs-device'

type Event = { cursor: string; at: number; event: Json }
/** Short reconnect replay is separate from durable seven-day human activity. */
export class Events {
  private readonly generation = randomUUID()
  private sequence = 0
  private bytes = 0
  private readonly rows: Event[] = []
  private readonly listeners = new Set<(event: Json) => void>()
  constructor(private readonly now: () => number) {}
  private prune() {
    while (
      this.rows.length &&
      (this.rows.length > 512 || this.bytes > 1 << 20 || this.rows[0]!.at < this.now() - 600_000)
    ) {
      this.bytes -= Buffer.byteLength(JSON.stringify(this.rows.shift()))
    }
  }
  page(since?: string, limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 512) throw new MhsError('invalid-limit')
    this.prune()
    const index = since ? this.rows.findIndex((r) => r.cursor === since) : -1
    const gap = !!since && index < 0 && since !== `${this.generation}/0`
    const rows = this.rows.slice(index + 1, index + 1 + limit)
    return {
      events: structuredClone(rows),
      gap,
      cursor: rows.at(-1)?.cursor ?? since ?? `${this.generation}/0`,
      more: index + 1 + rows.length < this.rows.length,
    }
  }
  subscribe(listener: (event: Json) => void, since?: string): () => void {
    if (since) {
      const page = this.page(since, 512)
      if (page.gap) listener({ type: 'replay-gap', cursor: this.rows[0]?.cursor ?? `${this.generation}/0` })
      for (const row of page.events) listener({ ...asObject(row.event), cursor: row.cursor })
    }
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  emit(event: Json) {
    event = structuredClone(event)
    if (Buffer.byteLength(JSON.stringify(event)) > 3000) {
      const data = asObject(event)
      event = {
        type: data.type ?? 'change',
        device: data.device ?? null,
        source: data.source ?? null,
        truncated: true,
      }
    }
    const row: Event = { cursor: `${this.generation}/${++this.sequence}`, at: this.now(), event }
    this.rows.push(row)
    this.bytes += Buffer.byteLength(JSON.stringify(row))
    this.prune()
    for (const listener of this.listeners) {
      try {
        listener(structuredClone({ ...asObject(event), cursor: row.cursor }))
      } catch {
        /* Isolated subscriber. */
      }
    }
  }
  close() {
    this.listeners.clear()
    this.rows.length = 0
    this.bytes = 0
  }
}
function asObject(value: Json): Record<string, Json> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : { data: value }
}
