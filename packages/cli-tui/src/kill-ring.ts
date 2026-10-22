const MAX_ENTRIES = 16

/**
 * The emacs kill ring for the prompt editor: the last few cut texts, newest first. Memory only; it is
 * never the system clipboard and never survives the process.
 */
export class KillRing {
  private entries: string[] = []

  /** Adds a cut. `merge` grows the newest entry instead (a run of cuts is one kill): `before` puts the text in front of it. */
  add(text: string, merge: boolean, before: boolean): void {
    if (!text) return
    const [top, ...older] = this.entries
    this.entries =
      merge && top !== undefined
        ? [before ? text + top : top + text, ...older]
        : [text, ...this.entries].slice(0, MAX_ENTRIES)
  }

  /** The `back`-th newest entry, wrapping around the ring. */
  at(back: number): string | undefined {
    return this.entries.length ? this.entries[back % this.entries.length] : undefined
  }
}
