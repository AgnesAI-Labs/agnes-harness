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
  | 'char'
  | 'unknown'

export type Key = { name: KeyName; ch?: string }

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

export function parseKey(data: string, kitty: boolean): Key {
  const known = SEQ.get(data)
  if (known) return { name: known }
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
  // event, a bracketed-paste bracket, a cursor-position reply. Reporting it as text is how a
  // terminal that starts sending mouse events fills the prompt with things like "[<35;40;12M".
  if (data.startsWith('\x1b')) return { name: 'unknown' }
  return { name: 'char', ch: data }
}
