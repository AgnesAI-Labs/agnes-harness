import type { PreviewSnapshotEntry, PreviewUpdate } from '../registry.js'
import { PREVIEW_BUDGET, utf8JsonBytes } from './endpoint.js'

/** A snapshot longer than this goes out in several consecutive pieces. */
export const SNAPSHOT_SLICE = 256 * 1024
/**
 * No piece is bigger than this once encoded, so a piece always fits a queue drained to its low
 * water and a snapshot larger than the whole budget still arrives, a few pieces per drain.
 */
export const SNAPSHOT_SLICE_BYTES = PREVIEW_BUDGET.bytes / 4
/** How many inferences a pipe remembers the delivered length of. */
const GIVEN_MAX = 64
/** Live previews held back while a snapshot is fetched; past this the hold is dropped and refetched. */
export const PREVIEW_HOLD_MAX_BYTES = 1024 * 1024

/**
 * Streamed text for one session on one connection. A snapshot (what the running inferences have
 * said so far) is sent whenever the viewer may have missed text: on joining, and after previews were
 * refused under pressure. It starts where the text this viewer was already given ends, so a snapshot
 * refused part way makes progress on every retry. While the snapshot is being fetched, live previews
 * are held and sent after it, so a delta newer than the snapshot is never shown before it. Consumers
 * merge by offset, so overlap between the snapshot and the held previews is harmless.
 */
export class PreviewPipe {
  private hold: PreviewUpdate[] | null = null
  private holdBytes = 0
  private refetch = false
  private dropped = false
  private closed = false
  // Per inference and stream, how much text from offset 0 this viewer has been given without a gap.
  private readonly given = new Map<string, number>()

  constructor(
    private readonly o: {
      lanes?: readonly string[] | undefined
      fetch: () => Promise<PreviewSnapshotEntry[]>
      /** Returns false when the preview was refused. */
      send: (p: PreviewUpdate) => boolean
    },
  ) {}

  live(p: PreviewUpdate): void {
    if (this.closed || !this.wanted(p.lane)) return
    if (this.hold) {
      this.holdBytes += p.delta.length
      if (this.holdBytes > PREVIEW_HOLD_MAX_BYTES) {
        this.hold = []
        this.holdBytes = 0
        this.refetch = true
      } else this.hold.push(p)
      return
    }
    if (!this.send(p)) this.dropped = true
  }

  /** Sends what is in flight now, then whatever arrived meanwhile. */
  resync(): void {
    if (this.closed || this.hold) return
    this.hold = []
    this.holdBytes = 0
    this.refetch = false
    this.o.fetch().then(
      (entries) => {
        if (this.closed) return
        for (const entry of entries) {
          if (!this.wanted(entry.lane)) continue
          this.slices(entry.lane, entry.effectId, 'thinking', entry.thinking)
          this.slices(entry.lane, entry.effectId, 'text', entry.text)
        }
        this.release()
      },
      () => this.release(),
    )
  }

  /** Previews were refused earlier and the queue has drained: catch the viewer up. */
  lowWater(): void {
    if (!this.dropped) return
    this.dropped = false
    this.resync()
  }

  close(): void {
    this.closed = true
    this.hold = null
  }

  private release(): void {
    const held = this.hold ?? []
    const again = this.refetch
    this.hold = null
    this.holdBytes = 0
    this.refetch = false
    if (this.closed) return
    if (again) {
      this.resync()
      return
    }
    for (const p of held) if (!this.send(p)) this.dropped = true
  }

  private send(p: PreviewUpdate): boolean {
    if (!this.o.send(p)) return false
    const key = `${p.effectId}/${p.stream}`
    const given = this.given.get(key) ?? 0
    if (p.offset <= given && p.offset + p.delta.length > given) {
      this.given.delete(key)
      this.given.set(key, p.offset + p.delta.length)
      if (this.given.size > GIVEN_MAX) this.given.delete(this.given.keys().next().value as string)
    }
    return true
  }

  private slices(lane: string, effectId: string, stream: 'text' | 'thinking', text: string): void {
    let offset = Math.min(this.given.get(`${effectId}/${stream}`) ?? 0, text.length)
    while (offset < text.length) {
      let end = Math.min(text.length, offset + SNAPSHOT_SLICE)
      while (end - offset > 1 && utf8JsonBytes(text.slice(offset, end)) > SNAPSHOT_SLICE_BYTES)
        end = offset + Math.ceil((end - offset) / 2)
      // A refused piece ends this snapshot: later pieces would only leave a gap behind it.
      if (!this.send({ lane, effectId, stream, offset, delta: text.slice(offset, end) })) {
        this.dropped = true
        return
      }
      offset = end
    }
  }

  private wanted(lane: string): boolean {
    return !this.o.lanes || this.o.lanes.includes(lane)
  }
}
