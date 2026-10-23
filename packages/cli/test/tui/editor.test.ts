import { describe, expect, it } from 'vitest'
import { createAnsi } from '../../src/tui/ansi.js'
import { CURSOR_MARKER, VStack } from '../../src/tui/component.js'
import { Editor, type MentionState, Vim } from '../../src/tui/editor.js'
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
    expect(parseKey('\x1b[Z', false).name).toBe('shift-tab')
    expect(parseKey('\x1b[9;2u', true).name).toBe('shift-tab')
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
    const drafts: boolean[] = []
    const e = new Editor({
      onSubmit: () => {},
      onCancelKey: (hadDraft) => {
        cancels++
        drafts.push(hadDraft)
      },
      busy: () => busy,
    })
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
    // The key tells the app whether it found a draft, so an empty editor can mean something else.
    expect(e.handleInput('\x1b')).toBe(true)
    expect(drafts).toEqual([true, true, false])
    expect(e.handleInput('\x03')).toBe(false)
    expect(e.handleInput('\x04')).toBe(false)
    expect(e.handleInput('\x0f')).toBe(false)
  })

  it('strips control characters from any draft put in whole, keeping newlines', () => {
    const e = new Editor({ onSubmit: () => {} })
    e.setText('a\u001b[2J\u0007b\nc\td')
    expect(e.text).toBe('a[2Jb\nc  d')
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

  it('a run of cuts is one kill that grows the right way, and a cut that takes nothing does not break the run', () => {
    const e = at('aa bb')
    e.handleInput(CTRL.w)
    e.handleInput(CTRL.u)
    e.handleInput(CTRL.u)
    e.handleInput(CTRL.y)
    expect(e.text).toBe('aa bb')
    const lines = at('ab\ncd', 2)
    lines.handleInput(CTRL.k)
    expect(lines.text).toBe('abcd')
    lines.handleInput(CTRL.u)
    lines.handleInput(CTRL.u)
    lines.handleInput(CTRL.y)
    expect(lines.text).toBe('ab\ncd')
    // Forward cuts append: Alt-D twice takes both words and Ctrl-Y puts them back in order.
    const fwd = at('one two three', 0)
    fwd.handleInput('\x1bd')
    fwd.handleInput('\x1bd')
    expect(fwd.text).toBe(' three')
    fwd.handleInput(CTRL.y)
    expect(fwd.text).toBe('one two three')
  })

  it('Alt-Y after Ctrl-Y swaps the paste for the previous kill, cycles, and does nothing otherwise', () => {
    const ALT_Y = '\x1by'
    const e = at('aa bb cc', 8)
    e.handleInput(CTRL.w) // kill 'cc'
    e.handleInput('x') // typing breaks the run: the next cut is a kill of its own
    e.handleInput(CTRL.u) // kill 'aa bb x'
    expect(e.text).toBe('')
    e.handleInput(ALT_Y)
    expect(e.text).toBe('')
    e.handleInput(CTRL.y)
    expect(e.text).toBe('aa bb x')
    e.handleInput(ALT_Y)
    expect(e.text).toBe('cc')
    e.handleInput(ALT_Y)
    expect(e.text).toBe('aa bb x')
    // Any other key ends the chain.
    e.handleInput('\x1b[D')
    e.handleInput(ALT_Y)
    expect(e.text).toBe('aa bb x')
    // Each paste and each swap is one undo step.
    const u = at('aa bb cc', 8)
    u.handleInput(CTRL.w)
    u.handleInput('x')
    u.handleInput(CTRL.u)
    u.handleInput(CTRL.y)
    u.handleInput(ALT_Y)
    expect(u.text).toBe('cc')
    u.handleInput('\x1a')
    expect(u.text).toBe('aa bb x')
    u.handleInput('\x1a')
    expect(u.text).toBe('')
    // The kitty protocol spelling of Alt-Y is the same key.
    const k = at('aa bb', 5)
    k.handleInput(CTRL.w)
    k.handleInput(CTRL.u)
    k.handleInput(CTRL.y)
    expect(k.handleInput('\x1b[121;3u')).toBe(true)
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

describe('Editor external edit', () => {
  it('Ctrl-G asks the app to edit the draft, and the edited draft replaces it as one undoable step', () => {
    let asked = 0
    const e = new Editor({ onSubmit() {}, onExternalEdit: () => asked++ })
    type(e, 'draft')
    expect(e.handleInput('\x07')).toBe(true)
    expect(asked).toBe(1)
    expect(e.text).toBe('draft')
    e.replaceDraft('rewritten\nin vim')
    expect([e.text, e.cursor]).toEqual(['rewritten\nin vim', 16])
    e.handleInput('\x1a')
    expect(e.text).toBe('draft')
    expect(new Editor({ onSubmit() {} }).handleInput('\x07')).toBe(true)
  })
})

describe('Editor vim mode', () => {
  const ESC = '\x1b'
  const CTRL_R = '\x12'
  // An editor with vim on, holding `text` in normal mode with the cursor at `at`.
  const normal = (text: string, at = 0) => {
    const vim = new Vim()
    vim.enabled = true
    vim.mode = 'normal'
    const log = { sent: [] as string[], cancels: 0 }
    const e = new Editor({
      vim,
      onSubmit: (t) => log.sent.push(t),
      onCancelKey: () => log.cancels++,
    })
    e.setText(text)
    e.cursor = at
    return { e, vim, log }
  }
  const run = (text: string, at: number, keys: string): [string, number] => {
    const { e } = normal(text, at)
    type(e, keys)
    return [e.text, e.cursor]
  }

  it.each<[string, string, number, string, number]>([
    ['h and l stop at the ends of the line', 'foo bar', 4, 'h', 3],
    ['l stays on the last character', 'foo bar', 6, 'l', 6],
    ['a count repeats a movement', 'foo bar', 0, '3l', 3],
    ['a count repeats h', 'foo bar', 3, '2h', 1],
    ['0 goes to the line start', 'foo bar', 4, '0', 0],
    ['$ goes to the last character', 'foo bar', 1, '$', 6],
    ['^ goes to the first non-blank', '  ab', 3, '^', 2],
    ['w goes to the next word', 'foo bar baz', 0, 'w', 4],
    ['2w goes two words on', 'foo bar baz', 0, '2w', 8],
    ['w on the last word stays on its last character', 'foo bar', 4, 'w', 6],
    ['b goes to the word start', 'foo bar baz', 8, 'b', 4],
    ['e goes to the word end', 'foo bar baz', 0, 'e', 2],
    ['e on a word end goes to the next one', 'foo bar baz', 2, 'e', 6],
    ['j keeps the column', 'one\ntwo\nthree', 6, 'j', 10],
    ['k goes back up', 'one\ntwo\nthree', 5, 'k', 1],
    ['j on the last line stays', 'one\ntwo', 5, 'j', 5],
    ['gg goes to the first line', 'one\ntwo\nthree', 10, 'gg', 0],
    ['G goes to the last line', 'one\ntwo\nthree', 0, 'G', 8],
    ['2G names the line', 'one\ntwo\nthree', 0, '2G', 4],
    ['3gg names the line too', 'one\ntwo\nthree', 0, '3gg', 8],
    ['an unknown letter is swallowed', 'foo', 1, 'z', 1],
    ['g and another letter end the command', 'one\ntwo', 5, 'gxk', 1],
  ])('moves: %s', (_name, text, at, keys, cursor) => {
    const [after, where] = run(text, at, keys)
    expect([after, where]).toEqual([text, cursor])
  })

  it.each<[string, string, number, string, string, number]>([
    ['i types before the cursor', 'abc', 1, 'iX', 'aXbc', 2],
    ['a types after it', 'abc', 1, 'aX', 'abXc', 3],
    ['I types at the first non-blank', '  ab', 3, 'IX', '  Xab', 3],
    ['A types at the end', 'abc', 0, 'AX', 'abcX', 4],
    ['o opens a line below', 'abc', 1, 'oX', 'abc\nX', 5],
    ['O opens a line above', 'abc', 1, 'OX', 'X\nabc', 1],
    ['x deletes under the cursor', 'abc', 1, 'x', 'ac', 1],
    ['x on the last character steps the cursor back', 'abc', 2, 'x', 'ab', 1],
    ['dd removes a middle line', 'one\ntwo\nthree', 5, 'dd', 'one\nthree', 4],
    ['dd removes the last line', 'one\ntwo\nthree', 10, 'dd', 'one\ntwo', 4],
    ['dd empties a one-line draft', 'abc', 1, 'dd', '', 0],
    ['dw removes to the next word', 'foo bar baz', 0, 'dw', 'bar baz', 0],
    ['dw on the last word stops at the line end', 'foo bar', 4, 'dw', 'foo ', 3],
    ['D removes to the line end', 'foo bar', 4, 'D', 'foo ', 3],
    ['cw replaces the word and keeps the space', 'foo bar', 0, 'cwX', 'X bar', 1],
    ['C replaces to the line end', 'foo bar', 3, 'C!', 'foo!', 4],
    ['p puts the last cut after the cursor', 'abc', 0, 'xp', 'bac', 1],
    ['P puts it before', 'abc', 0, 'xP', 'abc', 0],
    ['p puts a cut line below', 'one\ntwo', 0, 'ddp', 'two\none', 4],
    ['P puts a cut line above', 'one\ntwo', 0, 'ddP', 'one\ntwo', 0],
  ])('edits: %s', (_name, text, at, keys, after, cursor) => {
    expect(run(text, at, keys)).toEqual([after, cursor])
  })

  it('cancels a command that has a count but is not a movement, rather than doing it once', () => {
    expect(run('abc', 0, '3x')).toEqual(['abc', 0])
    expect(run('one\ntwo', 0, '3dd')).toEqual(['one\ntwo', 0])
    // The count is gone afterwards.
    expect(run('abc', 0, '3xx')).toEqual(['bc', 0])
  })

  it('shares the kill ring: a cut here pastes with Ctrl-Y, and a Ctrl-K cut pastes with p', () => {
    const { e } = normal('abc', 0)
    type(e, 'x')
    e.handleInput('i')
    e.handleInput('\x19')
    expect(e.text).toBe('abc')
    const insert = new Editor({ vim: Object.assign(new Vim(), { enabled: true }), onSubmit() {} })
    type(insert, 'abc def')
    for (let i = 0; i < 4; i++) insert.handleInput('\x1b[D')
    insert.handleInput('\x0b')
    expect(insert.text).toBe('abc')
    insert.handleInput(ESC)
    type(insert, 'p')
    expect(insert.text).toBe('abc def')
  })

  it('undoes and redoes one command at a time, and u undoes a typing run whole', () => {
    const vim = Object.assign(new Vim(), { enabled: true })
    const e = new Editor({ vim, onSubmit() {} })
    type(e, 'hello')
    e.handleInput(ESC)
    type(e, 'xx')
    expect(e.text).toBe('hel')
    type(e, 'u')
    expect(e.text).toBe('hell')
    type(e, 'u')
    expect(e.text).toBe('hello')
    e.handleInput(CTRL_R)
    expect(e.text).toBe('hell')
    type(e, 'uu')
    expect(e.text).toBe('')
  })

  it('Esc leaves insert mode once and does what it did without vim the second time', () => {
    const vim = Object.assign(new Vim(), { enabled: true })
    const log = { cancels: 0 }
    const e = new Editor({ vim, onSubmit() {}, onCancelKey: () => log.cancels++ })
    type(e, 'draft')
    e.handleInput(ESC)
    expect([vim.mode, e.text, e.cursor, log.cancels]).toEqual(['normal', 'draft', 4, 0])
    e.handleInput(ESC)
    expect([e.text, log.cancels]).toEqual(['', 1])
    // A half-typed command is dropped by Esc first.
    const half = normal('abc', 0)
    type(half.e, 'd')
    half.e.handleInput(ESC)
    expect(half.log.cancels).toBe(0)
    half.e.handleInput(ESC)
    expect(half.log.cancels).toBe(1)
    // Off, Esc is the cancel key at once and the letters are text.
    const off = new Editor({ vim: new Vim(), onSubmit() {}, onCancelKey: () => log.cancels++ })
    type(off, 'dd')
    expect(off.text).toBe('dd')
    off.handleInput(ESC)
    expect([off.text, log.cancels]).toEqual(['', 2])
  })

  it('Esc closes an open @ menu first, before it leaves insert mode', () => {
    const vim = Object.assign(new Vim(), { enabled: true })
    const e = new Editor({
      vim,
      onSubmit() {},
      mentions: {
        get: () => ({ status: 'ready', items: [{ id: 'a.ts', directory: false }] }) as MentionState,
      },
    })
    type(e, 'see @a')
    e.handleInput(ESC)
    expect(vim.mode).toBe('insert')
    e.handleInput(ESC)
    expect(vim.mode).toBe('normal')
  })

  it('submits with Enter in normal mode and starts the next prompt in insert mode', () => {
    const { e, vim, log } = normal('send me', 3)
    e.handleInput('\r')
    expect(log.sent).toEqual(['send me'])
    expect([e.text, vim.mode]).toEqual(['', 'insert'])
  })

  it('leaves named keys alone in normal mode', () => {
    const { e } = normal('abc', 2)
    e.handleInput('\x1b[D')
    expect(e.cursor).toBe(1)
    e.handleInput('\x1b[F')
    expect(e.cursor).toBe(3)
    type(e, 'h')
    expect(e.cursor).toBe(2)
  })

  it('marks the mode in both glyph and wording, and turns the prompt arrow around in normal mode', () => {
    const vim = Object.assign(new Vim(), { enabled: true })
    const e = new Editor({ vim, onSubmit() {}, locale: 'zh-CN' })
    expect(e.vimBadge).toEqual({ normal: false, label: '插入' })
    expect(e.render(20)[0]).toContain('❯')
    e.handleInput(ESC)
    expect(e.vimBadge).toEqual({ normal: true, label: '普通' })
    expect(e.render(20)[0]).toContain('❮')
    expect(new Editor({ onSubmit() {} }).vimBadge).toBeUndefined()
  })
})

describe('recognised slash command colouring', () => {
  const ansi = new TuiTheme('light').ansi(createAnsi('256'))
  const accent = (s: string) => ansi.bold(ansi.fg('accent', s))
  const known = ['/resume', '/model', '/deploy-it']
  const make = (a: ReturnType<TuiTheme['ansi']> | null = ansi) =>
    new Editor({
      onSubmit() {},
      complete: (p) => known.filter((c) => c.startsWith(p)),
      ...(a ? { ansi: a } : {}),
    })
  const rows = (e: Editor, width = 40) => e.render(width).map((r) => r.replace(CURSOR_MARKER, ''))
  const body = (row: string) => row.slice(accent('❯ ').length)

  it('colours a built-in or custom command including the slash, and nothing after it', () => {
    for (const cmd of ['/resume', '/deploy-it']) {
      const e = make()
      e.setText(`${cmd} some argument`)
      expect(body(rows(e)[0] as string)).toBe(`${accent(cmd)} some argument`)
    }
  })

  it('leaves an unknown command, a path and a command on a later line plain', () => {
    for (const text of ['/foo bar', '/var/x/pic.png', 'say /resume', 'hi\n/resume']) {
      const e = make()
      e.setText(text)
      expect(body(rows(e)[0] as string)).toBe(text.split('\n')[0])
      if (text.includes('\n')) expect(rows(e)[1]).toBe('  /resume')
    }
  })

  it('keeps the cursor marker out of the styled run when the cursor is inside the command', () => {
    const e = make()
    e.setText('/resume x')
    e.cursor = 3
    expect(e.render(40)[0]).toBe(`${accent('❯ ')}${accent('/re')}${CURSOR_MARKER}${accent('sume')} x`)
  })

  it('colours both rows of a command the width splits', () => {
    const e = make()
    e.setText('/deploy-it')
    const out = rows(e, 8) // two prompt columns leave six per row
    expect(out[0]).toContain(accent('/deplo'))
    expect(out[1]).toContain(accent('y-it'))
  })

  it('adds no colour without a palette or in mono', () => {
    const plain = make(null)
    plain.setText('/resume x')
    expect(rows(plain)[0]).toBe('❯ /resume x')
    const mono = make(new TuiTheme('mono').ansi(createAnsi('256')))
    mono.setText('/resume x')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no colour is the point
    expect(rows(mono)[0]).not.toMatch(/\x1b\[(3\d|9\d|38;)/)
  })
})
