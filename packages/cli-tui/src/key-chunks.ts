import { PASTE_START } from './keys.js'

/** An escape sequence that has not completed this long after its first byte is delivered as it is (a lone Esc keypress). */
export const KEY_HOLD_MS = 50
// ponytail: a sequence that never completes is flushed at this length instead of growing without bound.
const MAX_HELD = 256

const ESC = '\x1b'
const isControl = (c: string): boolean => c < ' ' || c === '\x7f'

/**
 * Cuts `s` into key tokens: a CSI/SS3/OSC/APC sequence, `ESC` + one character (Alt-key; `ESC ESC [ A`
 * stays one token), one control character, or a run of printable text. `rest` is an escape sequence
 * that the chunk ended inside of.
 */
export function splitKeys(s: string): { tokens: string[]; rest: string } {
  const tokens: string[] = []
  let i = 0
  while (i < s.length) {
    const c = s[i] as string
    if (c !== ESC) {
      let j = i + 1
      while (j < s.length && !isControl(s[j] as string) && s[j] !== ESC) j++
      tokens.push(isControl(c) ? c : s.slice(i, j))
      i = isControl(c) ? i + 1 : j
      continue
    }
    const end = escapeEnd(s, i)
    if (end < 0) return { tokens, rest: s.slice(i) }
    tokens.push(s.slice(i, end))
    i = end
  }
  return { tokens, rest: '' }
}

/** Index after the escape sequence starting at `at`, or -1 when `s` ends inside it. */
function escapeEnd(s: string, at: number): number {
  const kind = s[at + 1]
  if (kind === undefined) return -1
  if (kind === ESC) {
    // Alt plus a CSI/SS3 key arrives as ESC ESC [ A; a doubled Esc is two keys.
    const next = s[at + 2]
    if (next === undefined) return -1
    return next === '[' || next === 'O' ? escapeEnd(s, at + 1) : at + 1
  }
  if (kind === '[') {
    for (let j = at + 2; j < s.length; j++) {
      const code = s.charCodeAt(j)
      if (code >= 0x40 && code <= 0x7e) return j + 1
      if (code < 0x20 || code > 0x3f) return j // not a CSI byte: the sequence is cut short here
    }
    return -1
  }
  if (kind === 'O') return s.length > at + 2 ? at + 3 : -1
  if (kind === ']' || kind === '_') {
    for (let j = at + 2; j < s.length; j++) {
      if (s[j] === '\x07') return j + 1
      if (s[j] === ESC && j + 1 < s.length) return s[j + 1] === '\\' ? j + 2 : j
      if (s[j] === ESC) return -1
    }
    return -1
  }
  // Alt-key: one whole character, so a surrogate pair is not cut.
  const width = (s.codePointAt(at + 1) ?? 0) > 0xffff ? 2 : 1
  return at + 1 + width <= s.length ? at + 1 + width : -1
}

/**
 * Hands the input path one key at a time. A terminal delivers stdin in whatever chunks the pipe cuts,
 * so one chunk can hold several keys (`hi\r`) and one key can be cut in two (`ESC` | `[A`). A bracketed
 * paste block is passed through whole.
 */
export class KeyChunker {
  private held = ''
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly emit: (token: string) => void,
    private readonly holdMs = KEY_HOLD_MS,
  ) {}

  push(part: string): void {
    this.clearTimer()
    if (part.startsWith(PASTE_START)) {
      this.flush()
      this.emit(part)
      return
    }
    // A terminal writes Alt+key in one go; a held Esc followed by a key that cannot continue a
    // sequence is the user pressing Esc and then typing (vim's Esc, j), not Alt+j.
    const onlyEsc = this.held !== '' && this.held === ESC.repeat(this.held.length)
    if (onlyEsc && !'[O]_'.includes(part[0] ?? '[')) this.flush()
    const { tokens, rest } = splitKeys(this.held + part)
    this.held = rest
    for (const t of tokens) this.emit(t)
    if (!rest) return
    if (rest.length >= MAX_HELD) this.flush()
    else this.timer = setTimeout(() => this.flush(), this.holdMs)
  }

  /** Delivers the held partial sequence as it is. */
  flush(): void {
    this.clearTimer()
    const held = this.held
    this.held = ''
    // ESC ESC could have become Alt+arrow; once it has not, it is two Esc presses.
    if (held.split(ESC).every((x) => x === '')) for (const _ of held) this.emit(ESC)
    else if (held) this.emit(held)
  }

  /** Drops the timer and anything held (the renderer stopped). */
  clear(): void {
    this.clearTimer()
    this.held = ''
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }
}
