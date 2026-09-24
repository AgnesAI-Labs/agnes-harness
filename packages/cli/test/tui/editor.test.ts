import { describe, expect, it } from 'vitest'
import { createAnsi } from '../../src/tui/ansi.js'
import { CURSOR_MARKER, VStack } from '../../src/tui/component.js'
import { Editor } from '../../src/tui/editor.js'
import { parseKey } from '../../src/tui/keys.js'
import { Renderer } from '../../src/tui/renderer.js'
import { displayWidth, FakeTerminal } from '../../src/tui/terminal.js'
import { emulate } from './harness.js'

const type = (e: Editor, s: string): void => {
  for (const ch of s) e.handleInput(ch)
}

// The slash menu wears a rounded border; unbox peels the frame (top, bottom and the │ … │ sides)
// so tests can assert the menu's content rows. Border characters arrive unstyled only where the
// test passes no dim style - styled cases assert the frame explicitly instead.
const unbox = (rows: string[]): string[] =>
  rows.slice(1, -1).map((r) => r.replace(/^│ /, '').replace(/ │$/, '').trimEnd())

// Renders the editor through the differential renderer into a real emulator, so the assertions are
// about the screen and the hardware cursor rather than about the marker string.
const draw = async (e: Editor, cols: number, rows = 4) => {
  const term = new FakeTerminal({ columns: cols, rows })
  new Renderer(term, new VStack([e])).start()
  return emulate(term, cols, rows)
}

describe('parseKey', () => {
  it('parses common keys', () => {
    expect(parseKey('\r', false).name).toBe('enter')
    expect(parseKey('\x1b\r', false).name).toBe('alt-enter')
    expect(parseKey('\x03', false).name).toBe('ctrl-c')
    expect(parseKey('\x1b[A', false).name).toBe('up')
    expect(parseKey('\x1b[13;2u', true).name).toBe('shift-enter')
    expect(parseKey('x', false)).toEqual({ name: 'char', ch: 'x' })
  })

  it('reads the kitty modifier only when the protocol is on', () => {
    expect(parseKey('\x1b[13;3u', true).name).toBe('alt-enter')
    expect(parseKey('\x1b[13;1u', true).name).toBe('enter')
    expect(parseKey('\x1b[13;2u', false).name).toBe('unknown')
    expect(parseKey('\x1b[99;2u', true).name).toBe('unknown')
  })

  // With the protocol on (kitty, WezTerm, ghostty) Esc and ctrl+letter no longer arrive as their
  // legacy bytes. Reading them as unknown is how ctrl+c and Esc stopped reaching the app at all.
  // Components that only see raw input (Select, SecretInputView) pass kitty=false on that same
  // screen, so these two forms, which mean nothing else, are read whatever the flag says.
  it('reads kitty Esc and ctrl+letter as the keys their legacy bytes name', () => {
    expect(parseKey('\x1b[27u', true).name).toBe('esc')
    expect(parseKey('\x1b[99;5u', true).name).toBe('ctrl-c')
    expect(parseKey('\x1b[100;5u', true).name).toBe('ctrl-d')
    expect(parseKey('\x1b[111;5u', true).name).toBe('ctrl-o')
    // Caps lock (64) rides along in the modifier and does not change the binding.
    expect(parseKey('\x1b[99;69u', true).name).toBe('ctrl-c')
    expect(parseKey('\x1b[99;7u', true).name).toBe('unknown')
    expect(parseKey('\x1b[99;5u', false).name).toBe('ctrl-c')
    expect(parseKey('\x1b[27u', false).name).toBe('esc')
  })

  // A terminal that begins reporting mouse motion sends a sequence a keypress table has no entry
  // for. Treating it as text is what fills a prompt with strings like "[<35;40;12M".
  it('an unrecognised escape sequence is not text', () => {
    expect(parseKey('\x1b[<35;40;12M', false).name).toBe('unknown')
    expect(parseKey('\x1b[200~', false).name).toBe('unknown')
    expect(parseKey('\x1bOZ', false).name).toBe('unknown')
    expect(parseKey('\x1bx', false).name).toBe('unknown')
  })

  it('a pasted word that names an Object property is still text', () => {
    expect(parseKey('constructor', false)).toEqual({ name: 'char', ch: 'constructor' })
    expect(parseKey('__proto__', false)).toEqual({ name: 'char', ch: '__proto__' })
  })
})

describe('Editor input', () => {
  it('submits on enter, inserts newline on alt-enter and backslash-enter, keeps history', () => {
    const sub: string[] = []
    const e = new Editor({ onSubmit: (t) => sub.push(t) })
    type(e, 'hi')
    e.handleInput('\x1b\r')
    type(e, 'there')
    expect(e.text).toBe('hi\nthere')
    e.handleInput('\r')
    expect(sub).toEqual(['hi\nthere'])
    expect(e.text).toBe('')
    e.handleInput('\\')
    e.handleInput('\r')
    expect(e.text).toBe('\n')
    e.clear()
    e.handleInput('\x1b[A')
    expect(e.text).toBe('hi\nthere')
  })

  it('tab completion replaces the current token', () => {
    const e = new Editor({ onSubmit: () => {}, complete: (p) => (p === '/he' ? ['/help'] : []) })
    type(e, '/he')
    e.handleInput('\t')
    expect(e.text).toBe('/help ')
  })

  it('tab does nothing when there is no token or no candidate', () => {
    const e = new Editor({ onSubmit: () => {}, complete: () => [] })
    e.handleInput('\t')
    expect(e.text).toBe('')
    type(e, '/zz')
    e.handleInput('\t')
    expect(e.text).toBe('/zz')
    expect(e.cursor).toBe(3)
  })

  it('walks history up and back down to the empty draft', () => {
    const e = new Editor({ onSubmit: () => {} })
    for (const t of ['one', 'two']) {
      type(e, t)
      e.handleInput('\r')
    }
    e.handleInput('\x1b[A')
    expect(e.text).toBe('two')
    e.handleInput('\x1b[A')
    expect(e.text).toBe('one')
    e.handleInput('\x1b[A')
    expect(e.text).toBe('one')
    e.handleInput('\x1b[B')
    expect(e.text).toBe('two')
    e.handleInput('\x1b[B')
    expect(e.text).toBe('')
  })

  it('esc clears and reports, ctrl-c and ctrl-d are left to the application', () => {
    let cancels = 0
    const e = new Editor({ onSubmit: () => {}, onCancelKey: () => cancels++ })
    type(e, 'draft')
    expect(e.handleInput('\x1b')).toBe(true)
    expect(e.text).toBe('')
    expect(cancels).toBe(1)
    expect(e.handleInput('\x03')).toBe(false)
    expect(e.handleInput('\x04')).toBe(false)
    expect(e.handleInput('\x0f')).toBe(false)
  })

  it('swallows an unrecognised escape sequence instead of typing it', () => {
    const e = new Editor({ onSubmit: () => {} })
    type(e, 'ab')
    expect(e.handleInput('\x1b[<35;40;12M')).toBe(true)
    expect(e.text).toBe('ab')
  })

  it('strips control bytes out of a paste but keeps its newlines', () => {
    const e = new Editor({ onSubmit: () => {} })
    e.handleInput('one\x07two\nthree')
    expect(e.text).toBe('onetwo\nthree')
    expect(e.cursor).toBe(e.text.length)
  })
})

describe('Editor slash menu', () => {
  const SLASH = ['/help', '/quit', '/resume', '/rewind', '/refine'] as const
  const slashComplete = (p: string): string[] => SLASH.filter((c) => c.startsWith(p))
  // The editor's own input line is always exactly one line wide for these short drafts, so it is
  // always the last non-blank row; everything above it (if anything) is the menu.
  const menuLines = async (e: Editor) => {
    const { lines } = await draw(e, 20, 8)
    const trimmed = [...lines]
    while (trimmed.length && trimmed[trimmed.length - 1] === '') trimmed.pop()
    return unbox(trimmed.slice(0, -1))
  }

  it('shows every command that matches the prefix, highlighting the first', async () => {
    const e = new Editor({ onSubmit: () => {}, complete: slashComplete })
    type(e, '/re')
    expect(await menuLines(e)).toEqual(['› /resume', '  /rewind', '  /refine'])
  })

  it('narrows as more characters are typed and closes once only an exact match remains', async () => {
    const e = new Editor({ onSubmit: () => {}, complete: slashComplete })
    type(e, '/re')
    type(e, 'w')
    expect(await menuLines(e)).toEqual(['› /rewind'])
    type(e, 'ind')
    // '/rewind' now matches its own full name exactly - nothing left to choose, so the menu closes.
    expect(await menuLines(e)).toEqual([])
  })

  it('does not open for a slash typed after other text, or once a space starts the arguments', async () => {
    const e = new Editor({ onSubmit: () => {}, complete: slashComplete })
    type(e, 'see /re')
    expect(await menuLines(e)).toEqual([])
    e.clear()
    type(e, '/resume abc')
    expect(await menuLines(e)).toEqual([])
  })

  it('up/down move the highlight and wrap around, without touching history', () => {
    const e = new Editor({ onSubmit: () => {}, complete: slashComplete })
    type(e, 'one')
    e.handleInput('\r')
    type(e, '/re')
    e.handleInput('\x1b[B') // down: /resume -> /rewind
    e.handleInput('\x1b[B') // down: /rewind -> /refine
    e.handleInput('\t')
    expect(e.text).toBe('/refine ')
    // History is untouched by the menu's own up/down: it still recalls the one prior submission.
    e.clear()
    e.handleInput('\x1b[A')
    expect(e.text).toBe('one')
  })

  it('down wraps from the last candidate back to the first', () => {
    const e = new Editor({ onSubmit: () => {}, complete: slashComplete })
    type(e, '/re')
    e.handleInput('\x1b[B')
    e.handleInput('\x1b[B')
    e.handleInput('\x1b[B') // wraps past /refine back to /resume
    e.handleInput('\t')
    expect(e.text).toBe('/resume ')
  })

  it('up from the first candidate wraps to the last', () => {
    const e = new Editor({ onSubmit: () => {}, complete: slashComplete })
    type(e, '/re')
    e.handleInput('\x1b[A')
    e.handleInput('\t')
    expect(e.text).toBe('/refine ')
  })

  it('enter accepts the highlighted candidate instead of submitting while the menu is open', () => {
    const submitted: string[] = []
    const e = new Editor({ onSubmit: (t) => submitted.push(t), complete: slashComplete })
    type(e, '/re')
    e.handleInput('\x1b[B')
    e.handleInput('\r')
    expect(e.text).toBe('/rewind ')
    expect(submitted).toEqual([])
    // The menu is closed now (there is a trailing space): a second enter submits normally.
    e.handleInput('\r')
    expect(submitted).toEqual(['/rewind '])
  })

  it('enter submits immediately when the draft already names a command exactly', () => {
    const submitted: string[] = []
    const e = new Editor({ onSubmit: (t) => submitted.push(t), complete: slashComplete })
    type(e, '/quit')
    e.handleInput('\r')
    expect(submitted).toEqual(['/quit'])
  })

  it('tab accepts the highlighted candidate the same way enter does', () => {
    const e = new Editor({ onSubmit: () => {}, complete: slashComplete })
    type(e, '/h')
    e.handleInput('\t')
    expect(e.text).toBe('/help ')
  })
})

describe('Editor slash menu rendering (pi style)', () => {
  // All seven names share the '/' prefix, so a single keystroke opens the full menu. Two of them
  // carry an args shape and all of them a description, so one fixture exercises every row kind.
  const SEVEN = ['/a', '/b', '/c', '/d', '/e', '/f', '/g'] as const
  const INFO: Record<string, { args?: string; description: string }> = {
    '/a': { description: '命令 A' },
    '/b': { description: '命令 B' },
    '/c': { description: '命令 C' },
    '/d': { description: '命令 D' },
    '/e': { description: '命令 E' },
    '/f': { args: '[id]', description: '命令 F' },
    '/g': { args: '<seq>', description: '命令 G' },
  }
  const menuEditor = () =>
    new Editor({
      onSubmit: () => {},
      complete: (p) => SEVEN.filter((c) => c.startsWith(p)),
      menuInfo: (n) => INFO[n],
    })
  // The draft ('/…') is always a single input line, so the menu is everything above the last row.
  const menuRows = (e: Editor) => e.render(40).slice(0, -1)

  it('shows at most five candidates and a dim count of what is hidden below', () => {
    const e = menuEditor()
    type(e, '/')
    expect(unbox(menuRows(e))).toEqual(['› /a', '  /b', '  /c', '  /d', '  /e', '  ↓ 2 more', '命令 A'])
  })

  it('frames the menu in a rounded border that hugs the widest row', () => {
    const e = menuEditor()
    type(e, '/')
    const rows = menuRows(e)
    // The widest content row is '  ↓ 2 more' at ten columns, so the frame spans fourteen.
    expect(rows[0]).toBe('╭────────────╮')
    expect(rows.at(-1)).toBe('╰────────────╯')
    expect(rows[1]).toBe('│ › /a       │')
    expect(rows[6]).toBe('│   ↓ 2 more │')
    expect(rows[7]).toBe('│ 命令 A     │')
    for (const row of rows) expect(displayWidth(row)).toBe(14)
  })

  it('scrolls the five-row window with the highlight and reports both directions', () => {
    const e = menuEditor()
    type(e, '/')
    for (let i = 0; i < 5; i++) e.handleInput('\x1b[B')
    expect(unbox(menuRows(e))).toEqual([
      '  /b',
      '  /c',
      '  /d',
      '  /e',
      '› /f [id]',
      '  ↑ 1 more  ↓ 1 more',
      '命令 F',
    ])
    e.handleInput('\x1b[B') // last candidate: only the count above remains
    expect(unbox(menuRows(e))).toEqual([
      '  /c',
      '  /d',
      '  /e',
      '  /f [id]',
      '› /g <seq>',
      '  ↑ 2 more',
      '命令 G',
    ])
    e.handleInput('\x1b[B') // wraps to the first candidate; the window follows back to the top
    expect(unbox(menuRows(e))).toEqual(['› /a', '  /b', '  /c', '  /d', '  /e', '  ↓ 2 more', '命令 A'])
    e.handleInput('\x1b[A') // up from the first wraps to the last and scrolls to the bottom
    expect(unbox(menuRows(e))).toEqual([
      '  /c',
      '  /d',
      '  /e',
      '  /f [id]',
      '› /g <seq>',
      '  ↑ 2 more',
      '命令 G',
    ])
  })

  it('keeps the dim description line in sync with the highlighted candidate', () => {
    const e = menuEditor()
    type(e, '/')
    expect(unbox(menuRows(e)).at(-1)).toBe('命令 A')
    e.handleInput('\x1b[B')
    expect(unbox(menuRows(e)).at(-1)).toBe('命令 B')
    e.handleInput('\x1b[A')
    expect(unbox(menuRows(e)).at(-1)).toBe('命令 A')
  })

  it('shows no description line when the completer has no info for the candidates', () => {
    const e = new Editor({ onSubmit: () => {}, complete: (p) => SEVEN.filter((c) => c.startsWith(p)) })
    type(e, '/')
    expect(unbox(menuRows(e))).toEqual(['› /a', '  /b', '  /c', '  /d', '  /e', '  ↓ 2 more'])
  })

  it('styles the highlighted row with menuStyle, args shape and indicators with dim', () => {
    const ansi = createAnsi('256')
    const e = new Editor({
      onSubmit: () => {},
      complete: (p) => SEVEN.filter((c) => c.startsWith(p)),
      menuInfo: (n) => INFO[n],
      dim: (s) => ansi.dim(s),
      menuStyle: (s) => ansi.bg(240, s),
    })
    type(e, '/')
    const rows = menuRows(e)
    const side = '\x1b[2m│\x1b[22m'
    // The frame itself is dimmed; the highlight and description keep their own styling inside it.
    expect(rows[0]).toBe('\x1b[2m╭────────────╮\x1b[22m')
    expect(rows[1]).toBe(`${side} \x1b[48;5;240m› /a\x1b[49m       ${side}`)
    expect(rows[6]).toBe(`${side}   \x1b[2m↓ 2 more\x1b[22m ${side}`)
    expect(rows[7]).toBe(`${side} \x1b[2m命令 A\x1b[22m     ${side}`)
    // The args shape rides inside the highlighted row, dimmed within the highlight.
    for (let i = 0; i < 5; i++) e.handleInput('\x1b[B')
    const highlighted = menuRows(e)[5] as string
    expect(highlighted).toContain('\x1b[48;5;240m› /f \x1b[2m[id]\x1b[22m\x1b[49m')
    // Styling never costs columns: the box measures by its text alone (widest row 20, plus frame).
    expect(displayWidth(highlighted)).toBe(24)
  })

  it('emits zero escape sequences on the none colour tier, menu included', () => {
    const ansi = createAnsi('none')
    const e = new Editor({
      onSubmit: () => {},
      complete: (p) => SEVEN.filter((c) => c.startsWith(p)),
      menuInfo: (n) => INFO[n],
      dim: (s) => ansi.dim(s),
      promptStyle: (s) => ansi.bold(s),
      menuStyle: (s) => ansi.bg(240, s),
    })
    type(e, '/')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting zero escapes is the point
    for (const line of e.render(40)) expect(line.replace(CURSOR_MARKER, '')).not.toMatch(/\x1b/)
    expect(unbox(menuRows(e))).toContain('  ↓ 2 more')
    expect(unbox(menuRows(e)).at(-1)).toBe('命令 A')
  })

  it('esc clears the draft and with it the menu', () => {
    const e = menuEditor()
    type(e, '/')
    expect(menuRows(e)).not.toEqual([])
    e.handleInput('\x1b')
    expect(e.text).toBe('')
    expect(menuRows(e)).toEqual([])
  })
})

describe('Editor boundaries', () => {
  it('an empty buffer absorbs backspace, arrows and enter without moving or submitting', () => {
    let submits = 0
    const e = new Editor({ onSubmit: () => submits++ })
    for (const k of ['\x7f', '\x1b[D', '\x1b[C', '\r']) expect(e.handleInput(k), k).toBe(true)
    expect(e.text).toBe('')
    expect(e.cursor).toBe(0)
    expect(submits).toBe(0)
  })

  it('a trailing backslash turns enter into a newline and keeps what came before', () => {
    const sub: string[] = []
    const e = new Editor({ onSubmit: (t) => sub.push(t) })
    type(e, 'hi\\')
    e.handleInput('\r')
    expect(e.text).toBe('hi\n')
    expect(e.cursor).toBe(3)
    expect(sub).toEqual([])
    type(e, 'there')
    e.handleInput('\r')
    expect(sub).toEqual(['hi\nthere'])
  })

  it('a whitespace-only buffer does not submit', () => {
    let submits = 0
    const e = new Editor({ onSubmit: () => submits++ })
    type(e, '   ')
    e.handleInput('\r')
    expect(submits).toBe(0)
    expect(e.text).toBe('   ')
  })

  it('cursor at zero stays at zero and inserts before everything', () => {
    const e = new Editor({ onSubmit: () => {} })
    type(e, 'bc')
    e.handleInput('\x1b[D')
    e.handleInput('\x1b[D')
    expect(e.cursor).toBe(0)
    e.handleInput('\x1b[D')
    expect(e.cursor).toBe(0)
    e.handleInput('\x7f')
    expect(e.text).toBe('bc')
    type(e, 'a')
    expect(e.text).toBe('abc')
    expect(e.cursor).toBe(1)
  })

  it('cursor at end of buffer stays at end', () => {
    const e = new Editor({ onSubmit: () => {} })
    type(e, 'ab')
    expect(e.cursor).toBe(2)
    e.handleInput('\x1b[C')
    expect(e.cursor).toBe(2)
    e.handleInput('\x1b[F')
    expect(e.cursor).toBe(2)
  })

  it('home and end reach the ends of the line the cursor is on, not of the buffer', () => {
    const e = new Editor({ onSubmit: () => {} })
    type(e, 'ab')
    e.handleInput('\x1b\r')
    type(e, 'cd')
    expect(e.cursor).toBe(5)
    e.handleInput('\x1b[H')
    expect(e.cursor).toBe(3)
    e.handleInput('\x1b[F')
    expect(e.cursor).toBe(5)
    // Back onto the first line, where both ends differ from the buffer's.
    for (const _ of 'xxx') e.handleInput('\x1b[D')
    expect(e.cursor).toBe(2)
    e.handleInput('\x1b[H')
    expect(e.cursor).toBe(0)
    e.handleInput('\x1b[F')
    expect(e.cursor).toBe(2)
  })

  it('home and end are no-ops at the ends of a single-line buffer', () => {
    const e = new Editor({ onSubmit: () => {} })
    type(e, 'ab')
    e.handleInput('\x1b[F')
    expect(e.cursor).toBe(2)
    e.handleInput('\x1b[H')
    expect(e.cursor).toBe(0)
    e.handleInput('\x1b[H')
    expect(e.cursor).toBe(0)
  })

  it('home on an empty line between two others stays on it', () => {
    const e = new Editor({ onSubmit: () => {} })
    type(e, 'a')
    e.handleInput('\x1b\r')
    e.handleInput('\x1b\r')
    type(e, 'c')
    e.handleInput('\x1b[D')
    e.handleInput('\x1b[D')
    expect(e.cursor).toBe(2)
    e.handleInput('\x1b[H')
    expect(e.cursor).toBe(2)
    e.handleInput('\x1b[F')
    expect(e.cursor).toBe(2)
  })

  it('moves and deletes a combining mark together with the letter it sits on', () => {
    const e = new Editor({ onSubmit: () => {} })
    e.handleInput('é')
    e.handleInput('x')
    expect(e.text).toBe('éx')
    expect(e.cursor).toBe(3)
    e.handleInput('\x1b[D')
    expect(e.cursor).toBe(2)
    e.handleInput('\x1b[D')
    expect(e.cursor).toBe(0)
    e.handleInput('\x1b[C')
    expect(e.cursor).toBe(2)
    e.handleInput('\x7f')
    expect(e.text).toBe('x')
    expect(e.cursor).toBe(0)
  })

  it('treats an astral character as one keypress', () => {
    const e = new Editor({ onSubmit: () => {} })
    e.handleInput('\u{1f600}')
    expect(e.cursor).toBe(2)
    e.handleInput('\x1b[D')
    expect(e.cursor).toBe(0)
    e.handleInput('\x1b[C')
    e.handleInput('\x7f')
    expect(e.text).toBe('')
  })
})

describe('Editor on screen', () => {
  // About the render contract only -- that the placeholder appears and that the cursor is marked at
  // all. Where the marker lands on screen is the business of the emulator tests below.
  it('render() emits the placeholder and marks the cursor position', () => {
    const e = new Editor({ placeholder: 'ask…', onSubmit: () => {} })
    expect(e.render(10)[0]).toContain('ask…')
    e.handleInput('a')
    expect(e.render(10)[0]).toContain(`a${CURSOR_MARKER}`)
  })

  it('styles the prompt glyph through promptStyle and the highlighted menu row through menuStyle', () => {
    const ansi = createAnsi('256')
    const e = new Editor({
      onSubmit: () => {},
      complete: (p) => ['/resume', '/rewind'].filter((c) => c.startsWith(p)),
      promptStyle: (s) => ansi.bold(ansi.fg(141, s)),
      menuStyle: (s) => ansi.bg(240, s),
    })
    expect(e.render(20)[0]).toBe(`\x1b[1m\x1b[38;5;141m❯ \x1b[39m\x1b[22m${CURSOR_MARKER}`)
    type(e, '/re')
    const lines = e.render(20)
    expect(lines[0]).toBe('╭───────────╮')
    expect(lines[1]).toBe('│ \x1b[48;5;240m› /resume\x1b[49m │')
    expect(lines[2]).toBe('│   /rewind │')
    expect(lines[3]).toBe('╰───────────╯')
    // Styling never costs columns: the highlighted row still measures by its text plus the frame.
    expect(displayWidth(lines[1] as string)).toBe(13)
  })

  it('keeps the slash menu inside very narrow terminals', () => {
    const e = new Editor({
      onSubmit: () => {},
      complete: () => ['/resume', '/rewind'],
      menuInfo: () => ({ description: 'a deliberately long description' }),
    })
    type(e, '/')
    for (const width of [1, 2, 3, 4, 5]) {
      const lines = e.render(width)
      expect(
        lines.every((line) => displayWidth(line) <= width),
        `width ${width}`,
      ).toBe(true)
    }
    expect(e.render(3)[0]).toBe('╭─╮')
    expect(e.render(4)[0]).toBe('╭──╮')
  })

  it('puts the cursor in front of the placeholder on an empty buffer', async () => {
    const e = new Editor({ placeholder: 'ask', onSubmit: () => {} })
    const s = await draw(e, 12)
    expect(s.lines[0]).toBe('❯ ask')
    expect(s.cursor).toEqual({ row: 0, col: 2 })
  })

  it('a line exactly as wide as the editor puts the cursor on the next row, not off the edge', async () => {
    const e = new Editor({ onSubmit: () => {} })
    type(e, 'abcdefgh')
    const s = await draw(e, 10)
    // The continuation row holds the two-space indent the cursor sits after, and nothing else.
    expect(s.lines.slice(0, 3)).toEqual(['❯ abcdefgh', '  ', ''])
    expect(s.cursor).toEqual({ row: 1, col: 2 })
  })

  it('one character short of full keeps the cursor on the same row', async () => {
    const e = new Editor({ onSubmit: () => {} })
    type(e, 'abcdefg')
    const s = await draw(e, 10)
    expect(s.lines[0]).toBe('❯ abcdefg')
    expect(s.cursor).toEqual({ row: 0, col: 9 })
  })

  it('breaks an over-long line by columns and indents the continuation', async () => {
    const e = new Editor({ onSubmit: () => {} })
    type(e, 'abcdefghijk')
    const s = await draw(e, 10)
    expect(s.lines.slice(0, 2)).toEqual(['❯ abcdefgh', '  ijk'])
    expect(s.cursor).toEqual({ row: 1, col: 5 })
  })

  it('counts a wide character as two columns when placing the cursor', async () => {
    const e = new Editor({ onSubmit: () => {} })
    type(e, '中文')
    e.handleInput('\x1b[D')
    const s = await draw(e, 12)
    expect(s.lines[0]).toBe('❯ 中文')
    expect(s.cursor).toEqual({ row: 0, col: 4 })
  })

  it('never splits a wide character across two rows', async () => {
    const e = new Editor({ onSubmit: () => {} })
    type(e, '中中中中')
    const s = await draw(e, 9)
    expect(s.lines.slice(0, 3)).toEqual(['❯ 中中中', '  中', ''])
    expect(s.cursor).toEqual({ row: 1, col: 4 })
  })

  it('a combining mark rides on its base letter instead of taking a column', async () => {
    const e = new Editor({ onSubmit: () => {} })
    e.handleInput('é')
    e.handleInput('x')
    const s = await draw(e, 12)
    expect(s.cursor).toEqual({ row: 0, col: 4 })
  })

  it('gives each newline its own row with a continuation prefix', async () => {
    const e = new Editor({ onSubmit: () => {} })
    type(e, 'ab')
    e.handleInput('\x1b\r')
    type(e, 'cd')
    const s = await draw(e, 12)
    expect(s.lines.slice(0, 2)).toEqual(['❯ ab', '  cd'])
    expect(s.cursor).toEqual({ row: 1, col: 4 })
  })
})

it('keeps the entire draft while a bounded viewport follows the cursor and resizes', () => {
  let rows = 2
  const editor = new Editor({ onSubmit() {}, maxRows: () => rows })
  editor.setText('one\ntwo\nthree\nfour')
  expect(editor.render(20).map((line) => line.replace(CURSOR_MARKER, '').trim())).toEqual(['three', 'four'])
  editor.cursor = 0
  expect(editor.render(20).map((line) => line.replace(CURSOR_MARKER, '').trim())).toEqual(['❯ one', 'two'])
  expect(editor.render(20)[0]).toContain(CURSOR_MARKER)
  rows = 3
  expect(editor.render(20)).toHaveLength(3)
  expect(editor.text).toBe('one\ntwo\nthree\nfour')
  const unbounded = new Editor({ onSubmit() {} })
  unbounded.setText(editor.text)
  expect(unbounded.render(20)).toHaveLength(4)
})

it('does not detach combining marks when a grapheme ends at a wrap boundary', () => {
  const editor = new Editor({ onSubmit() {} })
  editor.setText('abéx')
  expect(editor.render(5).map((line) => line.replace(CURSOR_MARKER, ''))).toEqual(['❯ abé', '  x'])
})

it('preserves joined emoji and keeps even one-column rendering and placeholders bounded', async () => {
  const editor = new Editor({ onSubmit() {}, placeholder: 'a long placeholder' })
  expect(editor.render(4)[0]).toBe(`❯ ${CURSOR_MARKER}a `)
  editor.setText('👩‍💻x')
  expect(editor.render(6).map((line) => line.replace(CURSOR_MARKER, ''))).toEqual(['❯ 👩‍💻', '  x'])
  for (const width of [1, 2, 3]) {
    const screen = await draw(editor, width, 8)
    expect(screen.cursor.col).toBeLessThan(width)
    expect(screen.cursorHidden).toBe(false)
  }
  expect(editor.text).toBe('👩‍💻x')
})
