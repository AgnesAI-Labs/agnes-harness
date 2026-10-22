import { describe, expect, it } from 'vitest'
import { createAnsi } from '../../src/tui/ansi.js'
import { CURSOR_MARKER, VStack } from '../../src/tui/component.js'
import { Editor, type MentionState } from '../../src/tui/editor.js'
import { parseKey, parseMouse } from '../../src/tui/keys.js'
import { Renderer } from '../../src/tui/renderer.js'
import { displayWidth, FakeTerminal } from '../../src/tui/terminal.js'
import { TuiTheme } from '../../src/tui/theme.js'
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

  it('reads SGR mouse reports and drops the buttons the TUI has no use for', () => {
    expect(parseMouse('\x1b[<64;10;5M')).toEqual([{ kind: 'wheel', rows: -3 }])
    // Ctrl (16) rides along on the second wheel step.
    expect(parseMouse('\x1b[<65;10;5M\x1b[<81;1;1M')).toEqual([
      { kind: 'wheel', rows: 3 },
      { kind: 'wheel', rows: 3 },
    ])
    expect(parseMouse('\x1b[<0;3;4M\x1b[<32;6;4M\x1b[<0;6;4m')).toEqual([
      { kind: 'press', row: 3, col: 2 },
      { kind: 'drag', row: 3, col: 5 },
      { kind: 'release', row: 3, col: 5 },
    ])
    expect(parseMouse('\x1b[<2;1;1M\x1b[<66;1;1M')).toEqual([])
    expect(parseMouse('\x1b[A')).toBeUndefined()
    expect(parseMouse('\x1b[<64;10;5Mx')).toBeUndefined()
  })

  it('selects dragged screen text in reverse video, copies it on release and clears on a key', () => {
    const term = new FakeTerminal({ columns: 30, rows: 5 })
    const copied: string[] = []
    let typed = ''
    const root = {
      render: () => ['hello 世界 there', '\x1b[1mbold\x1b[0m line'],
      invalidate() {},
      handleInput: (data: string) => {
        typed += data
        return true
      },
    }
    const renderer = new Renderer(term, root, false, { wheel: () => {}, copy: (text) => copied.push(text) })
    renderer.start()
    expect(term.writes.join('')).toContain('\x1b[?1002h\x1b[?1006h')
    term.feed('\x1b[<0;7;1M')
    term.feed('\x1b[<32;3;2M')
    term.feed('\x1b[<0;3;2m')
    expect(copied).toEqual(['世界 there\nbo'])
    renderer.renderNow()
    expect(renderer.lastFrame).toEqual([
      'hello \x1b[7m世界 there\x1b[27m',
      '\x1b[1m\x1b[7mbo\x1b[27mld\x1b[0m line',
    ])
    // A click that never moved copies nothing; a key clears the highlight and still reaches the root.
    term.feed('\x1b[<0;2;1M\x1b[<0;2;1m')
    expect(copied).toHaveLength(1)
    term.feed('x')
    renderer.renderNow()
    expect(typed).toBe('x')
    expect(renderer.lastFrame).toEqual(['hello 世界 there', '\x1b[1mbold\x1b[0m line'])
    renderer.stop()
    expect(term.writes.join('')).toContain('\x1b[?1006l\x1b[?1002l\x1b[?1049l')
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

  it('takes a paste as text: newlines normalised, tabs widened, a long one folded into a chip until it is sent', () => {
    const sub: string[] = []
    const e = new Editor({ onSubmit: (t) => sub.push(t) })
    const wrap = (s: string) => `\x1b[200~${s}\x1b[201~`
    expect(parseKey(wrap('a\rb'), false)).toEqual({ name: 'paste', ch: 'a\rb' })
    e.handleInput(wrap('a\r\nb\rc\td\x07'))
    expect(e.text).toBe('a\nb\nc  d')
    e.clear()
    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\r')
    e.handleInput(wrap(long))
    expect(e.text).toBe('[Pasted #1 · 30 lines]')
    // A chip at the cursor goes in one backspace; a second one is a separate paste.
    e.handleInput('\x7f')
    expect(e.text).toBe('')
    e.handleInput(wrap('x'.repeat(1001)))
    type(e, ' tail')
    expect(e.text).toBe('[Pasted #2 · 1 lines] tail')
    e.handleInput('\r')
    expect(sub).toEqual([`${'x'.repeat(1001)} tail`])
  })

  it('ctrl-r searches the history: older matches on repeat, enter takes one without sending, esc restores the draft', () => {
    const sub: string[] = []
    const e = new Editor({ onSubmit: (t) => sub.push(t) })
    for (const t of ['fix build', 'write docs', 'fix tests', 'other']) {
      type(e, t)
      e.handleInput('\r')
    }
    sub.length = 0
    type(e, 'half-typed')
    e.handleInput('\x12')
    type(e, 'fix')
    expect(e.render(60)[0]).toBe(`(search history) 'fix${CURSOR_MARKER}': fix tests`)
    e.handleInput('\x12')
    expect(e.render(60)[0]).toContain(': fix build')
    // Nothing older is left, so a further ctrl-r stays on the oldest match; a typo finds nothing.
    e.handleInput('\x12')
    expect(e.render(60)[0]).toContain(': fix build')
    type(e, 'zz')
    expect(e.render(60)[0]).toContain('(no match)')
    e.handleInput('\x7f')
    e.handleInput('\x7f')
    e.handleInput('\r')
    expect(e.text).toBe('fix tests')
    expect(sub).toEqual([])
    // Esc leaves the search with the original draft.
    e.setText('draft')
    e.handleInput('\x12')
    type(e, 'docs')
    e.handleInput('\x1b')
    expect(e.text).toBe('draft')
    expect(e.render(20)[0]).toContain('draft')
  })

  it('esc clears and reports, ctrl-c and ctrl-d are left to the application', () => {
    let cancels = 0
    let busy = false
    const e = new Editor({ onSubmit: () => {}, onCancelKey: () => cancels++, busy: () => busy })
    type(e, 'draft')
    // Mid-turn, esc only interrupts: the half-written message stays.
    busy = true
    expect(e.handleInput('\x1b')).toBe(true)
    expect(e.text).toBe('draft')
    expect(cancels).toBe(1)
    busy = false
    expect(e.handleInput('\x1b')).toBe(true)
    expect(e.text).toBe('')
    expect(cancels).toBe(2)
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
    expect(await menuLines(e)).toEqual(['❯ /resume', '  /rewind', '  /refine'])
  })

  it('narrows as more characters are typed and closes once only an exact match remains', async () => {
    const e = new Editor({ onSubmit: () => {}, complete: slashComplete })
    type(e, '/re')
    type(e, 'w')
    expect(await menuLines(e)).toEqual(['❯ /rewind'])
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

describe('Editor @ menu', () => {
  const FILES: MentionState = {
    status: 'ready',
    items: [
      { id: 'src', directory: true },
      { id: 'src/app.ts', directory: false },
      { id: 'my notes.md', directory: false },
    ],
  }
  const mentionEditor = (state: (query: string) => MentionState = () => FILES) => {
    const queries: string[] = []
    const submitted: string[] = []
    const e = new Editor({
      onSubmit: (t) => submitted.push(t),
      mentions: {
        get: (query) => {
          queries.push(query)
          return state(query)
        },
      },
    })
    return { e, queries, submitted }
  }
  // The draft is one input line, so the menu is everything above the last row.
  const menuRows = (e: Editor) => unbox(e.render(40).slice(0, -1))

  it('opens on @ at the start of a word, without Tab, and asks for what follows it', () => {
    const { e, queries } = mentionEditor()
    type(e, 'see @sr')
    expect(menuRows(e)).toEqual(['❯ src/', '  src/app.ts', '  my notes.md'])
    expect(queries.at(-1)).toBe('sr')
  })

  it('stays closed for an @ inside a word and once a space ends the mention', () => {
    const { e } = mentionEditor()
    type(e, 'a@b')
    expect(menuRows(e)).toEqual([])
    e.setText('')
    type(e, '@src ')
    expect(menuRows(e)).toEqual([])
  })

  it('up/down move the highlight; Enter takes a file in place of the mention only', () => {
    const { e, submitted } = mentionEditor()
    type(e, 'see @sr now')
    for (let i = 0; i < 4; i++) e.handleInput('\x1b[D')
    e.handleInput('\x1b[B')
    expect(menuRows(e)[1]).toBe('❯ src/app.ts')
    e.handleInput('\r')
    expect(e.text).toBe('see @src/app.ts now')
    expect(submitted).toEqual([])
  })

  it('Tab takes a folder and keeps the menu open inside it', () => {
    const { e, queries } = mentionEditor()
    type(e, '@sr')
    e.handleInput('\t')
    expect(e.text).toBe('@src/')
    expect(menuRows(e)).not.toEqual([])
    expect(queries.at(-1)).toBe('src/')
  })

  it('quotes a path with spaces', () => {
    const { e } = mentionEditor()
    type(e, '@no')
    e.handleInput('\x1b[A')
    e.handleInput('\r')
    expect(e.text).toBe('@"my notes.md" ')
  })

  it('Esc closes only the menu, keeps the draft, and typing opens it again', () => {
    const { e } = mentionEditor()
    type(e, 'see @sr')
    e.handleInput('\x1b')
    expect(e.text).toBe('see @sr')
    expect(menuRows(e)).toEqual([])
    type(e, 'c')
    expect(menuRows(e)[0]).toBe('❯ src/')
  })

  it('shows a status row with nothing to choose, and Enter then submits', () => {
    for (const [state, note] of [
      [{ status: 'loading', items: [] }, 'Searching…'],
      [{ status: 'ready', items: [] }, 'No matching files'],
      [{ status: 'failed', items: [] }, 'Cannot search files'],
    ] as const) {
      const { e, submitted } = mentionEditor(() => state)
      type(e, '@zz')
      expect(menuRows(e)).toEqual([`  ${note}`])
      e.handleInput('\t')
      expect(e.text).toBe('@zz')
      e.handleInput('\r')
      expect(submitted).toEqual(['@zz'])
    }
  })
})

describe('Editor slash menu rendering (pi style)', () => {
  // All seven names share the '/' prefix, so a single keystroke opens the full menu. Two of them
  // carry an args shape, so one fixture exercises both row kinds.
  const SEVEN = ['/a', '/b', '/c', '/d', '/e', '/f', '/g'] as const
  const INFO: Record<string, { args?: string }> = {
    '/f': { args: '[id]' },
    '/g': { args: '<seq>' },
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
    expect(unbox(menuRows(e))).toEqual(['❯ /a', '  /b', '  /c', '  /d', '  /e', '  ↓ 2 more'])
  })

  it('frames the menu in a rounded border that hugs the widest row', () => {
    const e = menuEditor()
    type(e, '/')
    const rows = menuRows(e)
    // The widest content row is '  ↓ 2 more' at ten columns, so the frame spans fourteen.
    expect(rows[0]).toBe('╭────────────╮')
    expect(rows.at(-1)).toBe('╰────────────╯')
    expect(rows[1]).toBe('│ ❯ /a       │')
    expect(rows[6]).toBe('│   ↓ 2 more │')
    for (const row of rows) expect(displayWidth(row)).toBe(14)
  })

  it('scrolls the five-row window with the highlight and reports both directions', () => {
    const e = menuEditor()
    type(e, '/')
    for (let i = 0; i < 5; i++) e.handleInput('\x1b[B')
    expect(unbox(menuRows(e))).toEqual(['  /b', '  /c', '  /d', '  /e', '❯ /f [id]', '  ↑ 1 more  ↓ 1 more'])
    e.handleInput('\x1b[B') // last candidate: only the count above remains
    expect(unbox(menuRows(e))).toEqual(['  /c', '  /d', '  /e', '  /f [id]', '❯ /g <seq>', '  ↑ 2 more'])
    e.handleInput('\x1b[B') // wraps to the first candidate; the window follows back to the top
    expect(unbox(menuRows(e))).toEqual(['❯ /a', '  /b', '  /c', '  /d', '  /e', '  ↓ 2 more'])
    e.handleInput('\x1b[A') // up from the first wraps to the last and scrolls to the bottom
    expect(unbox(menuRows(e))).toEqual(['  /c', '  /d', '  /e', '  /f [id]', '❯ /g <seq>', '  ↑ 2 more'])
  })

  it('shows only the candidate rows when the completer has no info for them', () => {
    const e = new Editor({ onSubmit: () => {}, complete: (p) => SEVEN.filter((c) => c.startsWith(p)) })
    type(e, '/')
    expect(unbox(menuRows(e))).toEqual(['❯ /a', '  /b', '  /c', '  /d', '  /e', '  ↓ 2 more'])
  })

  it('styles the menu through theme tones: framed, highlighted row on the selection background', () => {
    const ansi = new TuiTheme('light').ansi(createAnsi('256'))
    const tone = ansi.fg
    const e = new Editor({
      onSubmit: () => {},
      complete: (p) => SEVEN.filter((c) => c.startsWith(p)),
      menuInfo: (n) => INFO[n],
      ansi,
    })
    type(e, '/')
    const rows = menuRows(e)
    const side = tone('border', '│')
    const pointer = ansi.bold(tone('accent', '❯'))
    // The frame takes the border tone; the highlight keeps its own styling inside it.
    expect(rows[0]).toBe(tone('border', '╭────────────╮'))
    expect(rows[1]).toBe(`${side}${ansi.bg('selection', ` ${pointer} ${ansi.bold('/a')}       `)}${side}`)
    expect(rows[2]).toBe(`${side}   ${ansi.bold('/b')}       ${side}`)
    expect(rows[6]).toBe(`${side}   ${tone('faint', '↓ 2 more')} ${side}`)
    // The args shape rides inside the highlighted row, faint within the highlight.
    for (let i = 0; i < 5; i++) e.handleInput('\x1b[B')
    const highlighted = menuRows(e)[5] as string
    const body = `${pointer} ${ansi.bold('/f')} ${tone('faint', '[id]')}`
    expect(highlighted).toBe(`${side}${ansi.bg('selection', ` ${body}${' '.repeat(12)}`)}${side}`)
    // Styling never costs columns: the box measures by its text alone (widest row 20, plus frame).
    expect(displayWidth(highlighted)).toBe(24)
  })

  it('emits zero escape sequences on the none colour tier, menu included', () => {
    const e = new Editor({
      onSubmit: () => {},
      complete: (p) => SEVEN.filter((c) => c.startsWith(p)),
      menuInfo: (n) => INFO[n],
      ansi: new TuiTheme('light').ansi(createAnsi('none')),
    })
    type(e, '/')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting zero escapes is the point
    for (const line of e.render(40)) expect(line.replace(CURSOR_MARKER, '')).not.toMatch(/\x1b/)
    expect(unbox(menuRows(e))).toContain('  ↓ 2 more')
  })

  describe('summary column', () => {
    const SUM: Record<string, { args?: string; summary?: string }> = {
      '/a': { summary: 'Alpha thing' },
      '/b': { args: '[id]', summary: 'Beta thing' },
      '/c': { args: '[one|two|three|four|five|six|seven]', summary: 'Gamma thing' },
      '/d': {},
    }
    const names = ['/a', '/b', '/c', '/d']
    const sumEditor = (info: typeof SUM, ansi?: ReturnType<TuiTheme['ansi']>) =>
      new Editor({
        onSubmit: () => {},
        complete: (p) => names.filter((c) => c.startsWith(p)),
        menuInfo: (n) => info[n],
        ...(ansi ? { ansi } : {}),
      })
    const rowsAt = (e: Editor, width: number) => e.render(width).slice(0, -1)

    it('aligns summaries in one column, truncating only long args with an ellipsis', () => {
      const e = sumEditor(SUM)
      type(e, '/')
      // Left column is capped at 30 columns (args cut with …); summaries start at column 32.
      expect(unbox(rowsAt(e, 100))).toEqual([
        `❯ /a${' '.repeat(26)}  Alpha thing`,
        `  /b [id]${' '.repeat(21)}  Beta thing`,
        '  /c [one|two|three|four|five…  Gamma thing',
        '  /d',
      ])
    })

    it('omits every summary when the column cannot keep 8 columns, and bounds all rows', () => {
      const e = sumEditor(SUM)
      type(e, '/')
      // left 30 + 2 + 8 = 40 > 38 available at width 42 (frame 2 + padding 2).
      const rows = unbox(rowsAt(e, 42))
      expect(rows.slice(0, 4).join('')).not.toContain('thing')
      for (const width of [1, 2, 3, 4, 5, 10, 20, 41, 42, 43, 44, 60, 100])
        for (const row of rowsAt(e, width))
          expect(displayWidth(row), `width ${width}`).toBeLessThanOrEqual(width)
      // Rows still carry the pointer/name layout of the no-summary menu.
      expect(rows[0]).toBe('❯ /a')
    })

    it('renders exactly the old layout when menuInfo supplies no summary', () => {
      const bare = Object.fromEntries(
        Object.entries(SUM).map(([k, v]) => [k, v.args ? { args: v.args } : {}]),
      )
      const e = sumEditor(bare)
      type(e, '/')
      expect(unbox(rowsAt(e, 100)).slice(0, 4)).toEqual([
        '❯ /a',
        '  /b [id]',
        '  /c [one|two|three|four|five|six|seven]',
        '  /d',
      ])
    })

    it('paints summaries muted, spans the selection background over the row, none tier has no escapes', () => {
      const ansi = new TuiTheme('light').ansi(createAnsi('256'))
      const e = sumEditor(SUM, ansi)
      type(e, '/')
      const rows = rowsAt(e, 100)
      expect(rows[1]).toContain(ansi.fg('muted', 'Alpha thing'))
      // The selection background wraps the whole row, summary included.
      const [open, close] = ansi.bg('selection', '@').split('@') as [string, string]
      expect(rows[1]?.indexOf(open)).toBeLessThan(rows[1]?.indexOf('Alpha thing') ?? -1)
      expect(rows[1]?.lastIndexOf(close)).toBeGreaterThan(rows[1]?.indexOf('Alpha thing') ?? Infinity)
      const plain = sumEditor(SUM, new TuiTheme('light').ansi(createAnsi('none')))
      type(plain, '/')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting zero escapes is the point
      for (const line of plain.render(100)) expect(line.replace(CURSOR_MARKER, '')).not.toMatch(/\x1b/)
    })
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

  it('styles the prompt glyph bold accent and the placeholder faint', () => {
    const ansi = new TuiTheme('dark').ansi(createAnsi('256'))
    const e = new Editor({ onSubmit: () => {}, placeholder: 'ask…', ansi })
    const prompt = ansi.bold(ansi.fg('accent', '❯ '))
    expect(e.render(20)[0]).toBe(`${prompt}${CURSOR_MARKER}${ansi.fg('faint', 'ask…')}`)
    type(e, 'hi')
    expect(e.render(20)[0]).toBe(`${prompt}hi${CURSOR_MARKER}`)
  })

  it('keeps the slash menu inside very narrow terminals', () => {
    const e = new Editor({
      onSubmit: () => {},
      complete: () => ['/resume', '/rewind'],
      menuInfo: () => ({ summary: 'a deliberately long summary' }),
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

describe('Editor readline keys', () => {
  const at = (text: string, cursor = text.length) => {
    const e = new Editor({ onSubmit() {} })
    e.setText(text)
    e.cursor = cursor
    return e
  }
  const CTRL = { a: '\x01', b: '\x02', e: '\x05', f: '\x06', k: '\x0b', u: '\x15', w: '\x17', y: '\x19' }

  it('reads the control and alt forms of the keys', () => {
    expect(parseKey('\x0b', false).name).toBe('ctrl-k')
    expect(parseKey('\x1b[107;5u', false).name).toBe('ctrl-k')
    expect(parseKey('\x1bb', false).name).toBe('word-left')
    expect(parseKey('\x1b[1;5C', false).name).toBe('word-right')
    expect(parseKey('\x1b\x7f', false).name).toBe('word-delete-back')
    expect(parseKey('\x1bd', false).name).toBe('word-delete')
    expect(parseKey('\x1b[1;5F', false).name).toBe('ctrl-end')
    expect(parseKey('\x1b[4~', false).name).toBe('end')
  })

  it('Ctrl-A/E/B/F move to the line ends and by one character', () => {
    const e = at('one\ntwo', 5)
    e.handleInput(CTRL.a)
    expect(e.cursor).toBe(4)
    e.handleInput(CTRL.e)
    expect(e.cursor).toBe(7)
    e.handleInput(CTRL.b)
    expect(e.cursor).toBe(6)
    e.handleInput(CTRL.f)
    expect(e.cursor).toBe(7)
  })

  it('Alt-B/F and Ctrl-arrows move by word, Chinese included', () => {
    const e = at('hello world')
    e.handleInput('\x1bb')
    expect(e.cursor).toBe(6)
    e.handleInput('\x1b[1;5D')
    expect(e.cursor).toBe(0)
    e.handleInput('\x1bf')
    expect(e.cursor).toBe(5)
    e.handleInput('\x1b[1;5C')
    expect(e.cursor).toBe(11)
    const zh = at('今天天气很好')
    zh.handleInput('\x1bb')
    expect(zh.cursor).toBe(4)
    zh.handleInput('\x1bb')
    expect(zh.cursor).toBe(2)
    zh.handleInput('\x1bf')
    expect(zh.cursor).toBe(4)
  })

  it('cuts to the end or start of the line, a word back or a word forward, and Ctrl-Y puts it back', () => {
    const e = at('foo bar baz', 4)
    e.handleInput(CTRL.k)
    expect([e.text, e.cursor]).toEqual(['foo ', 4])
    e.handleInput(CTRL.y)
    expect(e.text).toBe('foo bar baz')
    e.handleInput(CTRL.u)
    expect([e.text, e.cursor]).toEqual(['', 0])
    e.handleInput(CTRL.y)
    expect(e.text).toBe('foo bar baz')
    e.handleInput(CTRL.w)
    expect(e.text).toBe('foo bar ')
    e.handleInput('\x1b\x7f')
    expect(e.text).toBe('foo ')
    e.cursor = 0
    e.handleInput('\x1bd')
    expect(e.text).toBe(' ')
    const zh = at('你好世界 foo', 2)
    zh.handleInput(CTRL.w)
    expect(zh.text).toBe('世界 foo')
  })

  it('every cut replaces the buffer, a cut with nothing in it keeps it, and Ctrl-K at a line end joins lines', () => {
    const e = at('aa bb')
    e.handleInput(CTRL.w)
    e.handleInput(CTRL.u)
    e.handleInput(CTRL.u)
    e.handleInput(CTRL.y)
    expect(e.text).toBe('aa ')
    const lines = at('ab\ncd', 2)
    lines.handleInput(CTRL.k)
    expect(lines.text).toBe('abcd')
    lines.handleInput(CTRL.u)
    // Already at the start of the line: nothing to cut, and the buffer still holds the last cut.
    lines.handleInput(CTRL.u)
    lines.handleInput(CTRL.y)
    expect(lines.text).toBe('abcd')
  })

  it('leaves Ctrl-C and Ctrl-D to the application', () => {
    const e = at('x')
    expect(e.handleInput('\x03')).toBe(false)
    expect(e.handleInput('\x04')).toBe(false)
  })
})

describe('Editor undo and redo', () => {
  const UNDO = '\x1a'
  const REDO = '\x1b[122;6u'

  it('undoes a typing run as one step and redoes it', () => {
    const e = new Editor({ onSubmit() {} })
    type(e, 'hello')
    e.handleInput('\x1b[D')
    type(e, 'XY')
    expect(e.text).toBe('hellXYo')
    e.handleInput(UNDO)
    expect(e.text).toBe('hello')
    expect(e.cursor).toBe(4)
    e.handleInput(UNDO)
    expect(e.text).toBe('')
    e.handleInput(REDO)
    expect(e.text).toBe('hello')
    e.handleInput(REDO)
    expect(e.text).toBe('hellXYo')
    // Nothing left to redo, or to undo before the first edit: no change, no error.
    e.handleInput(REDO)
    expect(e.text).toBe('hellXYo')
  })

  it('counts each delete and each paste as a step, and a new edit drops the redo branch', () => {
    const e = new Editor({ onSubmit() {} })
    type(e, 'abc')
    e.handleInput('\x7f')
    e.handleInput('\x7f')
    e.handleInput('\x1b[200~pasted\x1b[201~')
    expect(e.text).toBe('apasted')
    e.handleInput(UNDO)
    expect(e.text).toBe('a')
    e.handleInput(UNDO)
    expect(e.text).toBe('ab')
    e.handleInput(UNDO)
    expect(e.text).toBe('abc')
    type(e, 'd')
    e.handleInput(REDO)
    expect(e.text).toBe('abcd')
  })

  it('undoes a folded paste with its chip still expanding on redo, and a recalled history entry', () => {
    const e = new Editor({ onSubmit() {} })
    const big = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n')
    e.handleInput(`\x1b[200~${big}\x1b[201~`)
    e.handleInput('\x7f')
    expect(e.text).toBe('')
    e.handleInput(UNDO)
    expect(e.expanded()).toBe(big)
    const h = new Editor({ onSubmit() {} })
    type(h, 'sent')
    h.handleInput('\r')
    type(h, 'draft')
    h.handleInput('\x1b[A')
    expect(h.text).toBe('sent')
    h.handleInput(UNDO)
    expect(h.text).toBe('draft')
  })

  it('keeps the last 100 steps and forgets everything on submit or reset', () => {
    const e = new Editor({ onSubmit() {} })
    for (let i = 0; i < 120; i++) {
      type(e, 'x')
      e.handleInput('\x1b[D')
      e.handleInput('\x1b[C')
    }
    for (let i = 0; i < 150; i++) e.handleInput(UNDO)
    expect(e.text.length).toBe(20)
    type(e, 'ab')
    e.handleInput('\r')
    e.handleInput(UNDO)
    expect(e.text).toBe('')
    type(e, 'q')
    e.resetUndo()
    e.handleInput(UNDO)
    expect(e.text).toBe('q')
  })
})

describe('Editor multi-line navigation', () => {
  const draft = (text: string, cursor: number, history: string[] = []) => {
    const e = new Editor({ onSubmit() {} })
    for (const h of history.toReversed()) {
      e.setText(h)
      e.handleInput('\r')
    }
    e.setText(text)
    e.cursor = cursor
    return e
  }

  it('up and down move between lines first, keeping the display column', () => {
    const e = draft('abcdef\nxy\n你好吗', 4)
    e.handleInput('\x1b[B')
    expect(e.cursor).toBe(9)
    e.handleInput('\x1b[B')
    // Column 4 on the last line sits after two double-width characters.
    expect(e.cursor).toBe(12)
    e.handleInput('\x1b[A')
    e.handleInput('\x1b[A')
    expect(e.cursor).toBe(4)
  })

  it('walks history only past the first or last line', () => {
    const e = draft('one\ntwo', 5, ['older'])
    e.handleInput('\x1b[A')
    expect([e.text, e.cursor]).toEqual(['one\ntwo', 1])
    e.handleInput('\x1b[A')
    expect(e.text).toBe('older')
    e.handleInput('\x1b[B')
    expect(e.text).toBe('')
    const f = draft('a\nb', 0, ['older'])
    f.handleInput('\x1b[A')
    expect(f.text).toBe('older')
  })

  it('a single-line draft still walks history on the first press', () => {
    const e = draft('typing', 6, ['older'])
    e.handleInput('\x1b[A')
    expect(e.text).toBe('older')
  })
})
