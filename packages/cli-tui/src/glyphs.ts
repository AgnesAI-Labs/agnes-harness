import type { Terminal } from './terminal.js'

/**
 * Every glyph the TUI draws as chrome, with the ASCII look it takes under `/borders ascii`. This is the
 * one place a glyph is defined; the views keep drawing the Unicode forms and the lookup happens as the
 * frame is written (`foldingTerminal`), so a new glyph is added here and nowhere else.
 *
 * Each look is one column wide, like the glyph it replaces, so the width every view computed for its row
 * is still the width of what reaches the terminal. Text outside this table (the conversation, file names,
 * Chinese) is never touched.
 */
export const GLYPHS: ReadonlyMap<string, string> = new Map<string, string>([
  // Rules, frames and rails.
  ['─', '-'],
  ['━', '='],
  ['═', '='],
  ['╌', '-'],
  ['│', '|'],
  ['║', '|'],
  ['┊', ':'],
  ['▌', '|'],
  ['▍', '|'],
  ['▎', '|'],
  ['▏', '|'],
  ['╋', '+'],
  ...[...'╭╮╰╯┌┐└┘├┤┼╔╗╚╝'].map((corner): [string, string] => [corner, '+']),
  // Filled and empty marks.
  ['█', '#'],
  ['●', '*'],
  ['◆', '*'],
  ['◈', '*'],
  ['✦', '*'],
  ['∴', ':'],
  ['•', '*'],
  ['◇', 'o'],
  ['◉', 'o'],
  // Pointers.
  ['❯', '>'],
  ['❮', '<'],
  ['▸', '>'],
  ['›', '>'],
  ['»', '>'],
  ['«', '<'],
  ['⏎', '<'],
  ['↑', '^'],
  ['↓', 'v'],
  ['▲', '^'],
  // Status marks.
  ['✓', 'v'],
  ['✗', 'x'],
  ['⚠', '!'],
  ['⚑', '!'],
  ['⟳', '~'],
  ['⎇', 'Y'],
  ['⌥', '+'],
  ['⌂', '^'],
  // Separators and punctuation that a Linux console has no glyph for.
  ['·', '.'],
  ['…', '~'],
  ['–', '-'],
  ['—', '-'],
  ['⋯', '.'],
  ['→', '>'],
  ['’', "'"],
  ['“', '"'],
  ['”', '"'],
  // The turn spinner: ten braille frames become the four of the classic ASCII one.
  ...[...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'].map((frame, i): [string, string] => [frame, '|/-\\'[i % 4] as string]),
  // The welcome banner's face.
  ['˘', '-'],
  ['ᴗ', 'u'],
])

// Box drawing, block elements, geometric shapes and braille: chrome a new view might draw without the
// table having heard of it. Anything else (the user's words, other scripts) is left alone.
const STRAY_CHROME = /[─-╿▀-▟■-◿⠀-⣿]/u
// Matching by code point, so a surrogate pair is one character.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the range starts at NUL on purpose
const NON_ASCII = /[^\x00-\x7f]/gu

/** `text` with every glyph of the table, and any other chrome character, in its ASCII look. */
export function asciiFold(text: string): string {
  return text.replace(NON_ASCII, (ch) => {
    const look = GLYPHS.get(ch)
    if (look !== undefined) return look
    if (!STRAY_CHROME.test(ch)) return ch
    return ch === '⠀' ? ' ' : ch < '▀' ? '+' : ch < '■' ? '#' : ch < '⠀' ? '*' : '.'
  })
}

/**
 * `term` with everything written to it folded to ASCII while `ascii()` says so. The renderers draw
 * through this, so frames, the lines written into scrollback and the exit text all take the same look.
 */
export function foldingTerminal(term: Terminal, ascii: () => boolean): Terminal {
  const folded = new Proxy(term, {
    get(target, prop) {
      if (prop === 'write') return (s: string) => target.write(ascii() ? asciiFold(s) : s)
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  folding.set(folded, term)
  return folded
}

/** The terminal a `foldingTerminal` wraps, for code that keys state by the terminal the app was given. */
export const folding = new WeakMap<object, object>()
