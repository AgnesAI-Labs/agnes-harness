import { PASTE_END, PASTE_START } from './keys.js'

// ponytail: a timing heuristic, not knowledge. Fast typists, key-repeat or an input method that
// commits a long phrase at once can look like a paste, and a slow pipe can spread a paste thin enough
// to look like typing; its newlines then submit as before. A terminal with bracketed paste never needs it.
/** More printable characters than this, read together or each within BURST_GAP_MS of the last, are a paste. */
export const BURST_MIN_CHARS = 16
export const BURST_GAP_MS = 10
/** After the last character of a burst, Enter is still a newline for this long. */
export const BURST_ENTER_HOLD_MS = 30

/**
 * Puts a bracketed paste back together. A terminal delivers one paste in as many data chunks as the
 * pipe cuts it into; everything between the brackets comes out of `push` once, still wrapped, so the
 * input path sees one event. Input outside the brackets passes through untouched, except that
 * until the first bracket is seen a burst of typed-looking characters counts as a paste too (see
 * BURST_*): the chunk that carries its Enter keys is handed on wrapped, so they become newlines.
 */
export class PasteAssembler {
  private held: string | undefined
  private bracketed = false
  private run = 0
  private last = Number.NEGATIVE_INFINITY
  private holdUntil = Number.NEGATIVE_INFINITY

  constructor(
    private readonly bursts = false,
    private readonly now: () => number = Date.now,
  ) {}

  /** Wraps `chunk` as a paste when it is part of a burst and carries a line break. */
  private burst(chunk: string): string {
    if (!this.bursts || this.bracketed || chunk.includes('\x1b')) return chunk
    const at = this.now()
    if (at - this.last > BURST_GAP_MS) this.run = 0
    const continuing = at <= this.holdUntil
    this.run += [...chunk].filter((c) => c >= ' ' && c !== '\x7f').length
    this.last = at
    if (!continuing && this.run <= BURST_MIN_CHARS) return chunk
    this.holdUntil = at + BURST_ENTER_HOLD_MS
    return /[\r\n]/.test(chunk) ? PASTE_START + chunk + PASTE_END : chunk
  }

  push(data: string): string[] {
    const out: string[] = []
    let rest = data
    while (rest) {
      if (this.held === undefined) {
        const at = rest.indexOf(PASTE_START)
        if (at < 0) {
          out.push(this.burst(rest))
          break
        }
        if (at > 0) out.push(rest.slice(0, at))
        this.bracketed = true
        this.held = ''
        rest = rest.slice(at + PASTE_START.length)
        continue
      }
      // The end bracket may itself straddle two chunks, so the search starts a bracket's length back.
      const from = Math.max(0, this.held.length - PASTE_END.length)
      this.held += rest
      const end = this.held.indexOf(PASTE_END, from)
      if (end < 0) break
      out.push(PASTE_START + this.held.slice(0, end) + PASTE_END)
      rest = this.held.slice(end + PASTE_END.length)
      this.held = undefined
    }
    return out
  }
}
