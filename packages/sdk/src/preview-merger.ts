import type { SessionPreviewParams, UINode } from '@agnes/protocol'

export type Preview = Omit<SessionPreviewParams, 'sessionId'> & { sessionId?: string }

/** Past this much text for one inference the viewer stops accumulating and waits for the answer. */
export const PREVIEW_MAX_CHARS = 8 * 1024 * 1024
const OUT_OF_ORDER_MAX = 64
const OUT_OF_ORDER_MAX_CHARS = 256 * 1024
const FINISHED_MAX = 64

type Stream = {
  text: string
  thinking: string
  capped: boolean
  early: Preview[]
  earlyChars: number
}

/**
 * Streamed text for the inferences a viewer is watching, rebuilt from previews. Previews carry no
 * seq: each one says where in its stream it starts, so duplicates and overlap (a snapshot racing
 * the live deltas it summarises) are trimmed, and a piece that arrives ahead of a gap waits until
 * the gap is filled. The text only ever lives here, in memory, beside the authoritative timeline.
 */
export class PreviewMerger {
  private readonly streams = new Map<string, Stream>()
  private readonly finished: string[] = []

  /** Takes one preview; true when the text of its inference changed. */
  add(p: Preview): boolean {
    if (this.finished.includes(p.effectId)) return false
    let s = this.streams.get(p.effectId)
    if (!s) {
      s = { text: '', thinking: '', capped: false, early: [], earlyChars: 0 }
      this.streams.set(p.effectId, s)
    }
    if (s.capped) return false
    const changed = this.merge(s, p)
    if (!changed) return false
    // A piece that was waiting on a gap may fit now.
    for (let progress = true; progress && s.early.length > 0; ) {
      progress = false
      for (const [i, early] of s.early.entries()) {
        if (early.offset > s[early.stream].length) continue
        s.early.splice(i, 1)
        s.earlyChars -= early.delta.length
        this.merge(s, early)
        progress = true
        break
      }
    }
    return true
  }

  text(effectId: string): { text: string; thinking: string; capped: boolean } | undefined {
    const s = this.streams.get(effectId)
    return s ? { text: s.text, thinking: s.thinking, capped: s.capped } : undefined
  }

  /**
   * Lays the streamed text over an authoritative timeline, whose streaming nodes are always empty,
   * and forgets every inference the timeline shows as finished.
   */
  apply<T extends { nodes: UINode[] }>(timeline: T): T {
    let nodes: UINode[] | undefined
    for (const [i, node] of timeline.nodes.entries()) {
      if (node.kind !== 'assistant' || node.effectId === undefined) continue
      if (!node.streaming) {
        this.finish(node.effectId)
        continue
      }
      const s = this.streams.get(node.effectId)
      if (!s) continue
      nodes ??= [...timeline.nodes]
      nodes[i] = { ...node, text: s.text, ...(s.thinking ? { thinking: s.thinking } : {}) }
    }
    return nodes ? { ...timeline, nodes } : timeline
  }

  /** The inference ended; later previews for it are stale and dropped. */
  finish(effectId: string): void {
    this.streams.delete(effectId)
    if (this.finished.includes(effectId)) return
    this.finished.push(effectId)
    if (this.finished.length > FINISHED_MAX) this.finished.shift()
  }

  /** A new worker generation or a lost connection: everything held may be stale. */
  reset(): void {
    this.streams.clear()
  }

  private merge(s: Stream, p: Preview): boolean {
    const before = s[p.stream]
    if (p.offset > before.length) {
      s.early.push(p)
      s.earlyChars += p.delta.length
      while (s.early.length > OUT_OF_ORDER_MAX || s.earlyChars > OUT_OF_ORDER_MAX_CHARS) {
        const dropped = s.early.shift()
        s.earlyChars -= dropped?.delta.length ?? 0
      }
      return false
    }
    const piece = p.delta.slice(before.length - p.offset)
    if (!piece) return false
    if (s.text.length + s.thinking.length + piece.length > PREVIEW_MAX_CHARS) {
      s.capped = true
      s.early = []
      s.earlyChars = 0
      return true
    }
    s[p.stream] = before + piece
    return true
  }
}
