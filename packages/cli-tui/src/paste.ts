import { KEY_HOLD_MS } from './key-chunks.js'
import { PASTE_END, PASTE_START } from './keys.js'

// ponytail: a timing heuristic, not knowledge. Fast typists, key-repeat or an input method that
// commits a long phrase at once can look like a paste, and a slow pipe can spread a paste thin enough
// to look like typing; its newlines then submit as before. A terminal with bracketed paste never needs it.
/** More printable characters than this, read together or each within BURST_GAP_MS of the last, are a paste. */
export const BURST_MIN_CHARS = 16
export const BURST_GAP_MS = 10
/** After the last character of a burst, Enter is still a newline for this long. */
export const BURST_ENTER_HOLD_MS = 30
/** A paste whose end marker has not arrived this long after its last chunk is delivered as received. */
export const PASTE_IDLE_MS = 2000

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
  /** The start of a paste start marker that the last chunk ended inside of. */
  private tail = ''
  private timer: ReturnType<typeof setTimeout> | undefined
  /** A paste was delivered without its end marker; more of it may still be on the way. */
  private orphan = false

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

  /** Drops a held marker start (the renderer stopped). */
  clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.tail = ''
    this.held = undefined
    this.orphan = false
  }

  /**
   * `idle` receives the held start of a marker that nothing completed within KEY_HOLD_MS (a lone Esc,
   * an ordinary `ESC [ 2` key): it is the one hold, so the caller delivers it without holding again.
   * It also receives a paste whose end marker never came (PASTE_IDLE_MS after its last chunk), wrapped.
   */
  push(data: string, idle?: (parts: string[]) => void): string[] {
    const out: string[] = []
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    let rest = this.tail + data
    // A held start the new chunk does not continue goes on as its own chunk, so the key reader still
    // sees Esc and a following key as two keys rather than one Alt chord.
    if (this.tail && !rest.startsWith(PASTE_START) && !PASTE_START.startsWith(rest)) {
      out.push(this.tail)
      rest = data
    }
    this.tail = ''
    while (rest) {
      if (this.held === undefined && this.orphan) {
        // The rest of a stalled paste stays a paste, so its newlines do not submit half of it; the
        // end marker or a chunk with no text in it (Enter, Ctrl-C, an arrow) ends that.
        const end = rest.indexOf(PASTE_END)
        if (end >= 0) {
          if (end > 0) out.push(PASTE_START + rest.slice(0, end) + PASTE_END)
          this.orphan = false
          rest = rest.slice(end + PASTE_END.length)
          continue
        }
        if (!rest.startsWith('\x1b') && [...rest].some((c) => c >= ' ' && c !== '\x7f')) {
          out.push(PASTE_START + rest + PASTE_END)
          break
        }
        this.orphan = false
      }
      if (this.held === undefined) {
        const at = rest.indexOf(PASTE_START)
        if (at < 0) {
          let cut = Math.min(PASTE_START.length - 1, rest.length)
          while (cut > 0 && !PASTE_START.startsWith(rest.slice(-cut))) cut--
          if (cut > 0 && idle) {
            this.tail = rest.slice(-cut)
            this.timer = setTimeout(() => {
              this.timer = undefined
              const held = this.tail
              this.tail = ''
              idle([held])
            }, KEY_HOLD_MS)
          } else cut = 0
          if (rest.length > cut) out.push(this.burst(rest.slice(0, rest.length - cut)))
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
      if (end < 0) {
        if (idle) {
          this.timer = setTimeout(() => {
            this.timer = undefined
            const held = this.held ?? ''
            this.held = undefined
            this.orphan = true
            idle([PASTE_START + held + PASTE_END])
          }, PASTE_IDLE_MS)
        }
        break
      }
      out.push(PASTE_START + this.held.slice(0, end) + PASTE_END)
      rest = this.held.slice(end + PASTE_END.length)
      this.held = undefined
    }
    return out
  }
}
