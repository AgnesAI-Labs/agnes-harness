import { describe, expect, it } from 'vitest'
import { Text, VStack } from '../src/component.js'
import { createLinker, linkTarget, supportsOsc8 } from '../src/links.js'
import { Renderer } from '../src/renderer.js'
import { displayWidth, FakeTerminal } from '../src/terminal.js'

const ITERM = { TERM_PROGRAM: 'iTerm.app' }
const OPEN = (uri: string) => `\x1b]8;;${uri}\x1b\\`
const CLOSE = '\x1b]8;;\x1b\\'
const here = (path: string) => path === '/tmp/a/b.ts' || path === '/tmp/x'

describe('supportsOsc8', () => {
  it.each([
    [{ TERM_PROGRAM: 'iTerm.app' }],
    [{ TERM_PROGRAM: 'WezTerm' }],
    [{ TERM: 'xterm-kitty' }],
    [{ TERM_PROGRAM: 'ghostty' }],
    [{ TERM_PROGRAM: 'vscode' }],
    [{ WT_SESSION: 'x' }],
  ])('is on for %j', (env) => expect(supportsOsc8(env)).toBe(true))

  it.each([
    [{}],
    [{ TERM: 'xterm-256color' }],
    [{ TERM_PROGRAM: 'Apple_Terminal' }],
    [{ TERM_PROGRAM: 'iTerm.app', TMUX: '/tmp/tmux-1/default,1,0' }],
    [{ KITTY_WINDOW_ID: '1', TERM: 'screen-256color' }],
  ])('is off for %j', (env) => expect(supportsOsc8(env)).toBe(false))

  it('creates no linker where unsupported', () => expect(createLinker({})).toBeUndefined())
})

describe('linkTarget', () => {
  it('allows only http, https and file, and strips control characters', () => {
    expect(linkTarget('https://example.com/a')).toBe('https://example.com/a')
    expect(linkTarget('file:///tmp/x')).toBe('file:///tmp/x')
    expect(linkTarget('javascript:alert(1)')).toBeUndefined()
    expect(linkTarget('ftp://example.com/')).toBeUndefined()
    expect(linkTarget('https://example.com/a\x1b]8;;\x07b')).toBe('https://example.com/a]8;;b')
    expect(linkTarget(`https://example.com/${'a'.repeat(3000)}`)).toBeUndefined()
  })
})

describe('createLinker', () => {
  const link = createLinker(ITERM, here) as (row: string, columns: number) => string

  it('links URLs without trailing punctuation, and existing absolute paths only', () => {
    expect(link('see https://example.com/a. ok', 80)).toBe(
      `see ${OPEN('https://example.com/a')}https://example.com/a${CLOSE}. ok`,
    )
    expect(link('at /tmp/a/b.ts:12:3 now', 80)).toBe(
      `at ${OPEN('file:///tmp/a/b.ts')}/tmp/a/b.ts${CLOSE}:12:3 now`,
    )
    expect(link('at /tmp/missing.ts', 80)).toBe('at /tmp/missing.ts')
    expect(link('a/b and 1/2', 80)).toBe('a/b and 1/2')
  })

  it('keeps styles in place and the display width unchanged', () => {
    const row = '\x1b[31mgo to /tmp/x\x1b[39m, or \x1b[1mhttps://e.org/p\x1b[22m'
    const out = link(row, 80)
    expect(out).toContain(`${OPEN('file:///tmp/x')}/tmp/x${CLOSE}\x1b[39m`)
    expect(out).toContain(`\x1b[1m${OPEN('https://e.org/p')}https://e.org/p${CLOSE}\x1b[22m`)
    expect(displayWidth(out)).toBe(displayWidth(row))
  })

  it('leaves text that touches the edge of a full row alone', () => {
    expect(link('x https://example.com/abc', 25)).toBe('x https://example.com/abc')
  })

  it('writes links to the terminal, but the recorded frame stays plain', () => {
    const term = new FakeTerminal({ columns: 40, rows: 3 })
    const r = new Renderer(term, new VStack([new Text('open /tmp/x')]), false, undefined, true, link)
    r.start()
    expect(term.writes.join('')).toContain(`open ${OPEN('file:///tmp/x')}/tmp/x${CLOSE}`)
    expect(r.lastFrame[0]).toBe('open /tmp/x')
  })
})
