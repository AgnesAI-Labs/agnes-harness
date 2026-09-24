/** One piece of streamed model text, published live and never written to the ledger. */
export type PreviewDelta = {
  lane: string
  effectId: string
  stream: 'text' | 'thinking'
  /** Length of this stream's text before `delta`, in UTF-16 code units. */
  offset: number
  delta: string
}

/** Everything an inference still in flight has streamed so far. */
export type PreviewSnapshot = { lane: string; effectId: string; text: string; thinking: string }

/**
 * Live streamed text for one session. Listeners hear every delta as it is published; the snapshot
 * reads the text straight from the inferences still running, so a late or reconnecting viewer can
 * catch up without anything having been persisted.
 */
export class PreviewHub {
  private readonly listeners = new Set<(p: PreviewDelta) => void>()
  private readonly live = new Map<string, () => PreviewSnapshot>()

  on(fn: (p: PreviewDelta) => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /** A failing listener is a viewer's problem, never the inference's. */
  publish(p: PreviewDelta): void {
    for (const fn of this.listeners) {
      try {
        fn(p)
      } catch {
        // Swallowed: preview delivery is best effort and must not stop the stream.
      }
    }
  }

  /** Registers a running inference as a snapshot source until the returned function is called. */
  track(effectId: string, read: () => PreviewSnapshot): () => void {
    this.live.set(effectId, read)
    return () => {
      if (this.live.get(effectId) === read) this.live.delete(effectId)
    }
  }

  snapshot(): PreviewSnapshot[] {
    return [...this.live.values()].map((read) => read())
  }
}
