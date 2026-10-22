export type KeyName =
  | 'enter'
  | 'alt-enter'
  | 'shift-enter'
  | 'esc'
  | 'ctrl-c'
  | 'ctrl-d'
  | 'ctrl-o'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'tab'
  | 'backspace'
  | 'pgup'
  | 'pgdn'
  | 'home'
  | 'end'
  | 'f1'
  | 'f2'
  | 'f3'
  | 'f4'
  | 'paste'
  | 'char'
  | 'unknown'

export type Key = { name: KeyName; ch?: string }

/** Bracketed paste (mode 2004): the terminal wraps pasted text in these, so it cannot pass for typing. */
export const PASTE_START = '\x1b[200~'
export const PASTE_END = '\x1b[201~'

// A Map rather than an object: an object lookup would answer for inherited names, so pasting the
// word "constructor" would parse as something other than text.
const SEQ = new Map<string, KeyName>([
  ['\r', 'enter'],
  ['\n', 'enter'],
  ['\x1b\r', 'alt-enter'],
  ['\x1b', 'esc'],
  ['\x03', 'ctrl-c'],
  ['\x04', 'ctrl-d'],
  ['\x0f', 'ctrl-o'],
  ['\t', 'tab'],
  ['\x7f', 'backspace'],
  ['\b', 'backspace'],
  ['\x1b[A', 'up'],
  ['\x1b[B', 'down'],
  ['\x1b[C', 'right'],
  ['\x1b[D', 'left'],
  ['\x1b[5~', 'pgup'],
  ['\x1b[6~', 'pgdn'],
  ['\x1b[H', 'home'],
  ['\x1b[F', 'end'],
  ['\x1bOP', 'f1'],
  ['\x1bOQ', 'f2'],
  ['\x1bOR', 'f3'],
  ['\x1bOS', 'f4'],
])

// Kitty's CSI-u form reports a key code and an optional modifier that is 1 plus a bitmask: shift is 1,
// alt 2, ctrl 4; caps and num lock (64, 128) ride along and mean nothing to a binding. The return key
// (13) is the one the protocol makes newly distinguishable from a plain enter, read only where the
// caller knows the protocol is on. The disambiguate flag also moves Esc and ctrl+letter here, so ctrl+c
// arrives as `CSI 99;5u` rather than 0x03. Those forms mean nothing else, and a component that sees only
// raw input (a Select, the key prompt) cannot tell whether the protocol is on, so they are read
// whatever `kitty` says.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape byte is what starts the sequence
const CSI_U = /^\x1b\[(\d+)(?:;(\d+))?u$/

// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape byte is what starts the sequence
const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g
const WHEEL_LINES = 3

/** Wheel rows (negative is up), or a left-button press, drag or release at a 0-based screen cell. */
export type MouseEvent =
  | { kind: 'wheel'; rows: number }
  | { kind: 'press' | 'drag' | 'release'; row: number; col: number }

/**
 * The events in a chunk made only of SGR (1006) mouse reports, or undefined when the chunk is anything
 * else. Other buttons and the horizontal wheel are dropped: consumed, never typed into the prompt.
 */
export function parseMouse(data: string): MouseEvent[] | undefined {
  if (!data.startsWith('\x1b[<') || data.replace(SGR_MOUSE, '') !== '') return undefined
  const events: MouseEvent[] = []
  for (const m of data.matchAll(SGR_MOUSE)) {
    // Shift/alt/ctrl ride in 4/8/16; 32 marks motion; 64 a wheel, whose low bits are up, down, left, right.
    const button = Number(m[1]) & ~28
    const at = { row: Number(m[3]) - 1, col: Number(m[2]) - 1 }
    if (button === 64 || button === 65)
      events.push({ kind: 'wheel', rows: button === 64 ? -WHEEL_LINES : WHEEL_LINES })
    else if (button === 0) events.push({ kind: m[4] === 'm' ? 'release' : 'press', ...at })
    else if (button === 32) events.push({ kind: 'drag', ...at })
  }
  return events
}

export function parseKey(data: string, kitty: boolean): Key {
  const known = SEQ.get(data)
  if (known) return { name: known }
  if (
    data.startsWith(PASTE_START) &&
    data.endsWith(PASTE_END) &&
    data.length >= PASTE_START.length + PASTE_END.length
  )
    return { name: 'paste', ch: data.slice(PASTE_START.length, data.length - PASTE_END.length) }
  const m = CSI_U.exec(data)
  if (m) {
    const code = Number(m[1])
    const mods = (Number(m[2] ?? '1') - 1) & 7
    if (code === 13 && kitty) return { name: mods === 1 ? 'shift-enter' : mods === 2 ? 'alt-enter' : 'enter' }
    if (code === 27 && mods === 0) return { name: 'esc' }
    const ctrl = mods === 4 && code >= 97 && code <= 122 ? SEQ.get(String.fromCharCode(code - 96)) : undefined
    if (ctrl) return { name: ctrl }
  }
  // An unrecognised escape sequence is a key or a report this build has no meaning for -- a mouse
  // event, a stray paste bracket, a cursor-position reply. Reporting it as text is how a
  // terminal that starts sending mouse events fills the prompt with things like "[<35;40;12M".
  if (data.startsWith('\x1b')) return { name: 'unknown' }
  return { name: 'char', ch: data }
}
