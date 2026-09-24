import { describe, expect, it } from 'vitest'
import { CURSOR_MARKER, createAnsi } from '../../src/tui/ansi.js'
import {
  detectCapabilities,
  displayWidth,
  FakeTerminal,
  type InputStream,
  NodeTerminal,
  type OutputStream,
} from '../../src/tui/terminal.js'

const at = { columns: 80, rows: 24 }

describe('terminal capability detection', () => {
  it('detects color tiers without OS branches', () => {
    expect(detectCapabilities({ NO_COLOR: '1', TERM: 'xterm-256color' }, at).color).toBe('none')
    expect(detectCapabilities({ COLORTERM: 'truecolor' }, at).color).toBe('truecolor')
    expect(detectCapabilities({ TERM: 'xterm-256color' }, at).color).toBe('256')
    expect(detectCapabilities({ TERM: 'dumb' }, at).color).toBe('none')
    expect(detectCapabilities({ TERM_PROGRAM: 'kitty' }, at).kittyKeyboard).toBe(true)
  })

  // The presence cases above say what is switched on. These say what happens when the same signals
  // are missing, which is where a renderer quietly emits sequences nothing will draw.
  it('falls back to 16 colors when nothing announces more, and reports the size it was given', () => {
    expect(detectCapabilities({}, at)).toEqual({
      color: '16',
      kittyKeyboard: false,
      columns: 80,
      rows: 24,
    })
    expect(detectCapabilities({ TERM: 'vt100' }, { columns: 5, rows: 2 })).toEqual({
      color: '16',
      kittyKeyboard: false,
      columns: 5,
      rows: 2,
    })
  })

  it('NO_COLOR wins over every positive signal', () => {
    expect(detectCapabilities({ NO_COLOR: '1', COLORTERM: 'truecolor' }, at).color).toBe('none')
    expect(detectCapabilities({ NO_COLOR: '', COLORTERM: 'truecolor' }, at).color).toBe('truecolor')
  })

  // TERM_PROGRAM is inherited into every pane, so inside a multiplexer it names the emulator at the
  // far end rather than the one that will receive the sequence. A tmux without extended-keys does not
  // forward the request and the user sees `[>1u` typed into the first row.
  it('kitty keyboard is not requested through a multiplexer', () => {
    const inside = [
      { TERM_PROGRAM: 'kitty', TERM: 'screen-256color' },
      { TERM_PROGRAM: 'ghostty', TERM: 'tmux-256color' },
      { TERM_PROGRAM: 'WezTerm', TERM: 'xterm-256color', TMUX: '/tmp/tmux-501/default,1,0' },
    ]
    for (const env of inside) expect(detectCapabilities(env, at).kittyKeyboard, env.TERM).toBe(false)
  })

  it('kitty keyboard is still requested when the same emulator is not multiplexed', () => {
    const direct = [
      { TERM_PROGRAM: 'kitty', TERM: 'xterm-kitty' },
      { TERM_PROGRAM: 'ghostty', TERM: 'xterm-256color' },
      { TERM_PROGRAM: 'WezTerm' },
    ]
    for (const env of direct) expect(detectCapabilities(env, at).kittyKeyboard, env.TERM).toBe(true)
  })

  it('kitty keyboard stays off for terminals that do not announce it', () => {
    for (const env of [{}, { TERM_PROGRAM: 'Apple_Terminal' }, { TERM: 'xterm-kitty-lookalike' }])
      expect(detectCapabilities(env, at).kittyKeyboard).toBe(false)
  })
})

describe('displayWidth', () => {
  it('measures display width ignoring ANSI and counting wide chars', () => {
    expect(displayWidth('abc')).toBe(3)
    expect(displayWidth('\x1b[1mabc\x1b[0m')).toBe(3)
    expect(displayWidth('中文')).toBe(4)
    expect(displayWidth('a中')).toBe(3)
  })

  it('gives zero width to combining marks, joiners and the cursor marker', () => {
    expect(displayWidth('e\u0301')).toBe(1)
    expect(displayWidth('\uac01')).toBe(2)
    expect(displayWidth('\u200d')).toBe(0)
    expect(displayWidth(`a${CURSOR_MARKER}b`)).toBe(2)
    expect(displayWidth('')).toBe(0)
  })

  it('counts emoji and skips control characters', () => {
    expect(displayWidth('\u{1f600}')).toBe(2)
    expect(displayWidth('a\x07b')).toBe(2)
  })

  // The rule: width is summed per code point. A joined sequence measures the sum of its parts rather
  // than the one glyph some terminals compose, because whether they compose it depends on the font.
  // Over-measuring wraps a line early; under-measuring lets it overflow and the terminal wraps it
  // itself, after which every row the renderer addresses is off by one.
  it('measures a joined emoji sequence as the sum of its parts', () => {
    expect(displayWidth('\u{1f468}\u200d\u{1f469}\u200d\u{1f467}')).toBe(6)
    expect(displayWidth('\u{1f468}')).toBe(2)
  })

  // A variation selector asking for the emoji rendering makes the character before it double-width.
  // Without this rule a heart measures one column and everything after it on the line is off by one.
  it('an emoji-presentation selector makes the character before it two columns wide', () => {
    expect(displayWidth('\u2764\ufe0f')).toBe(2)
    expect(displayWidth('\u2764')).toBe(1)
    expect(displayWidth('\u2764\ufe0e')).toBe(1)
    expect(displayWidth('1\ufe0f\u20e3')).toBe(2)
    expect(displayWidth('a\u2764\ufe0fb')).toBe(4)
  })

  // Tabs are removed rather than expanded: a tab's width depends on the column it lands in, which a
  // component that only knows its own text cannot work out. Whatever wants tabs expands them first.
  it('a tab counts nothing, matching the renderer that removes it', () => {
    expect(displayWidth('a\tb')).toBe(2)
    expect(displayWidth('\t')).toBe(0)
  })

  // Only SGR is invisible. Anything else is defanged into printable characters before it is written,
  // so the width has to count those characters or the wrap and the paint disagree.
  it('counts what a defanged escape sequence leaves behind', () => {
    expect(displayWidth('a\x1b[2Jb')).toBe(5)
    expect(displayWidth('x\x1b[5;10Hy')).toBe(8)
    expect(displayWidth('\x1b[38;5;244mgrey\x1b[39m')).toBe(4)
  })
})

describe('ansi tokens', () => {
  it('ansi tokens collapse under NO_COLOR', () => {
    expect(createAnsi('none').bold('x')).toBe('x')
    expect(createAnsi('16').bold('x')).toBe('\x1b[1mx\x1b[22m')
  })

  // A 16-colour terminal prints `38;5;n` as text. Translating the index is the difference between a
  // dim grey label and the literal characters "8;5;244m" in the middle of the line.
  it('a 16-color terminal gets basic SGR, never a 256-color index', () => {
    expect(createAnsi('16').fg(1, 'x')).toBe('\x1b[31mx\x1b[39m')
    expect(createAnsi('16').fg(9, 'x')).toBe('\x1b[91mx\x1b[39m')
    expect(createAnsi('16').fg(240, 'x')).toBe('\x1b[90mx\x1b[39m')
    expect(createAnsi('16').fg(244, 'x')).toBe('\x1b[37mx\x1b[39m')
    expect(createAnsi('16').bg(4, 'x')).toBe('\x1b[44mx\x1b[49m')
    expect(createAnsi('256').fg(244, 'x')).toBe('\x1b[38;5;244mx\x1b[39m')
    expect(createAnsi('truecolor').bg(244, 'x')).toBe('\x1b[48;5;244mx\x1b[49m')
  })

  it('the none tier emits no escape byte at all', () => {
    const a = createAnsi('none')
    const out = [a.bold('a'), a.dim('b'), a.fg(200, 'c'), a.bg(200, 'd'), a.reset].join('')
    expect(out).toBe('abcd')
    expect(out).not.toContain('\x1b')
  })
})

describe('FakeTerminal', () => {
  it('records writes and replays input / resize', () => {
    const t = new FakeTerminal({ columns: 40, rows: 10 })
    const seen: string[] = []
    t.onInput((d) => seen.push(d))
    t.feed('x')
    t.write('hello')
    t.resize(20, 5)
    expect(seen).toEqual(['x'])
    expect(t.writes).toEqual(['hello'])
    expect(t.size()).toEqual({ columns: 20, rows: 5 })
  })

  it('unsubscribes and keeps caps in step with the size', () => {
    const t = new FakeTerminal({ columns: 40, rows: 10 })
    const seen: string[] = []
    const off = t.onInput((d) => seen.push(d))
    t.feed('a')
    off()
    t.feed('b')
    expect(seen).toEqual(['a'])
    t.resize(20, 5)
    expect(t.caps.columns).toBe(20)
    expect(t.caps.rows).toBe(5)
    expect(t.size()).toEqual({ columns: 20, rows: 5 })
  })
})

const fakeStreams = (): {
  stdin: InputStream & { raw: boolean | null; emit(d: string): void }
  stdout: OutputStream & { out: string[] }
} => {
  const handlers: Array<(c: string | Buffer) => void> = []
  const stdin = {
    raw: null as boolean | null,
    setRawMode(v: boolean) {
      this.raw = v
    },
    resume() {},
    pause() {},
    setEncoding(_e: string) {},
    on(_e: 'data', h: (c: string | Buffer) => void) {
      handlers.push(h)
    },
    off(_e: 'data', h: (c: string | Buffer) => void) {
      handlers.splice(handlers.indexOf(h), 1)
    },
    emit(d: string) {
      for (const h of [...handlers]) h(d)
    },
  }
  const stdout = {
    out: [] as string[],
    columns: 100 as number | undefined,
    rows: 30 as number | undefined,
    write(s: string) {
      this.out.push(s)
    },
    on(_e: 'resize', _h: () => void) {},
    off(_e: 'resize', _h: () => void) {},
  }
  return { stdin, stdout }
}

describe('NodeTerminal', () => {
  it('asks for the kitty keyboard protocol only where it is understood', () => {
    const kitty = fakeStreams()
    const plain = fakeStreams()
    new NodeTerminal(kitty.stdin, kitty.stdout, { TERM_PROGRAM: 'kitty' }).enterRaw()
    new NodeTerminal(plain.stdin, plain.stdout, { TERM: 'xterm-256color' }).enterRaw()
    expect(kitty.stdout.out).toEqual(['\x1b[>1u'])
    expect(plain.stdout.out).toEqual([])
    expect(plain.stdin.raw).toBe(true)
  })

  it('pops the keyboard mode it pushed, and only that', () => {
    const kitty = fakeStreams()
    const plain = fakeStreams()
    const k = new NodeTerminal(kitty.stdin, kitty.stdout, { TERM_PROGRAM: 'ghostty' })
    const p = new NodeTerminal(plain.stdin, plain.stdout, {})
    k.enterRaw()
    k.leaveRaw()
    p.enterRaw()
    p.leaveRaw()
    expect(kitty.stdout.out).toEqual(['\x1b[>1u', '\x1b[<u'])
    expect(plain.stdout.out).toEqual([])
    expect(plain.stdin.raw).toBe(false)
  })

  it('falls back to 80x24 when the stream reports no size', () => {
    const { stdin, stdout } = fakeStreams()
    stdout.columns = undefined
    stdout.rows = undefined
    expect(new NodeTerminal(stdin, stdout, {}).size()).toEqual({ columns: 80, rows: 24 })
  })

  it('delivers input to the handler and stops on unsubscribe', () => {
    const { stdin, stdout } = fakeStreams()
    const t = new NodeTerminal(stdin, stdout, {})
    const seen: string[] = []
    const off = t.onInput((d) => seen.push(d))
    stdin.emit('a')
    off()
    stdin.emit('b')
    expect(seen).toEqual(['a'])
  })
})
