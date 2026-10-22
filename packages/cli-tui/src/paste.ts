import { PASTE_END, PASTE_START } from './keys.js'

/**
 * Puts a bracketed paste back together. A terminal delivers one paste in as many data chunks as the
 * pipe cuts it into; everything between the brackets comes out of `push` once, still wrapped, so the
 * input path sees one event. Input outside the brackets passes through untouched.
 */
export class PasteAssembler {
  private held: string | undefined

  push(data: string): string[] {
    const out: string[] = []
    let rest = data
    while (rest) {
      if (this.held === undefined) {
        const at = rest.indexOf(PASTE_START)
        if (at < 0) {
          out.push(rest)
          break
        }
        if (at > 0) out.push(rest.slice(0, at))
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
