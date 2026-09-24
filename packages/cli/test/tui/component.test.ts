import { describe, expect, it } from 'vitest'
import { createAnsi } from '../../src/tui/ansi.js'
import {
  type Component,
  CURSOR_MARKER,
  escapeControl,
  padLine,
  Rule,
  Spacer,
  Text,
  VStack,
  wrapText,
} from '../../src/tui/component.js'
import { displayWidth } from '../../src/tui/terminal.js'
import { TuiTheme } from '../../src/tui/theme.js'
import { Composer } from '../../src/tui/views/composer.js'
import { UserMessage } from '../../src/tui/views/message.js'

describe('wrapping and padding', () => {
  it('wraps by display width and keeps wide chars intact', () => {
    expect(wrapText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
    expect(wrapText('中文字符测试', 5)).toEqual(['中文', '字符', '测试'])
    expect(wrapText('a b c d', 3)).toEqual(['a b', 'c d'])
    expect(padLine('ab', 4)).toBe('ab  ')
  })

  it('never emits a line wider than the width, whatever the width', () => {
    expect(wrapText('中文', 1).map(displayWidth)).toEqual([2, 2])
    expect(wrapText('a 中文 b', 3).every((l) => displayWidth(l) <= 3)).toBe(true)
    expect(wrapText('abc', 0)).toEqual(['a', 'b', 'c'])
    expect(wrapText('', 4)).toEqual([''])
    expect(wrapText('a\n\nb', 4)).toEqual(['a', '', 'b'])
  })

  it('padLine measures columns, not code units', () => {
    expect(padLine('中', 4)).toBe('中  ')
    expect(padLine('\x1b[1mab\x1b[22m', 4)).toBe('\x1b[1mab\x1b[22m  ')
    expect(padLine('abcd', 2)).toBe('abcd')
  })

  it('escapeControl strips every C0 and C1 byte except newline', () => {
    expect(escapeControl('a\x1b[31mb')).toBe('a[31mb')
    expect(escapeControl(`x${CURSOR_MARKER}y`)).toBe('xCURy')
    expect(escapeControl('a\nb\rc\x07d')).toBe('a\nbcd')
    expect(escapeControl('a\x9bb')).toBe('ab')
  })
})

describe('components', () => {
  it('VStack concatenates children and caches until invalidated', () => {
    const t = new Text('hello world')
    const s = new VStack([t, new Spacer(), new Rule('x')])
    expect(s.render(11)).toEqual(['hello world', '', '── x ──────'])
    t.set('bye')
    expect(s.render(11)[0]).toBe('bye')
    s.remove(t)
    expect(s.render(11)).toEqual(['', '── x ──────'])
  })

  it('Text reuses the cached lines and drops them when width or content changes', () => {
    const t = new Text('hello world')
    const a = t.render(11)
    expect(t.render(11)).toBe(a)
    expect(t.render(5)).not.toBe(a)
    expect(t.render(5)).toEqual(['hello', 'world'])
    const b = t.render(11)
    t.invalidate()
    expect(t.render(11)).not.toBe(b)
  })

  it('Text honours wrap:false and the style hook', () => {
    expect(new Text('a very long line indeed', { wrap: false }).render(4)).toEqual([
      'a very long line indeed',
    ])
    expect(new Text('ab\ncd', { wrap: false }).render(9)).toEqual(['ab', 'cd'])
    expect(new Text('ab', { style: (s) => `<${s}>` }).render(9)).toEqual(['<ab>'])
  })

  it('Spacer emits empty lines and Rule fills the width exactly', () => {
    expect(new Spacer(3).render(6)).toEqual(['', '', ''])
    expect(new Rule().render(4)).toEqual(['────'])
    expect(new Rule('ab').render(3)).toEqual(['── ab '])
    // An optional style wraps the whole rule line (the input-area divider uses it for dim).
    expect(new Rule(undefined, createAnsi('256').dim).render(4)).toEqual(['\x1b[2m────\x1b[22m'])
  })

  it('Composer spans the terminal and integrates model state without disturbing cursor geometry', () => {
    const ansi = createAnsi('256')
    const input: Component = {
      render: () => [`❯ ${CURSOR_MARKER}hello`],
      invalidate() {},
    }
    const composer = new Composer(input, ansi)
    composer.setMeta('deepseek-v4-pro · high')
    const rows = composer.render(120)
    expect(rows).toHaveLength(3)
    expect(rows[1]).toContain(`❯ ${CURSOR_MARKER}hello`)
    expect(rows[2]).toContain('deepseek-v4-pro · high')
    expect(rows.every((row) => displayWidth(row) === 120)).toBe(true)
    expect(rows.join('')).not.toContain('\x1b[48;5;')
  })

  it('user messages use a theme-aware full-width surface with a plain exit transcript', () => {
    const ansi = createAnsi('256')
    const theme = new TuiTheme('light')
    const message = new UserMessage('中文 hello '.repeat(20), theme.ansi(ansi), theme, 63)
    const rows = message.render(120)
    expect(rows[0]).toContain('\x1b[38;5;63m›\x1b[39m')
    expect(rows.every((row) => displayWidth(row) === 120)).toBe(true)
    expect(rows.join('')).toContain('\x1b[48;5;254m')
    theme.set('mono')
    expect(message.render(120).join('')).not.toContain('\x1b[48;5;')
    expect(new UserMessage('中文 hello', ansi, theme).transcript(16)).toEqual(['you: 中文 hello'])
  })

  it('VStack stops at the first child that consumes the input', () => {
    const seen: string[] = []
    const child = (name: string, consume: boolean): Component => ({
      render: () => [],
      handleInput: (d) => {
        seen.push(`${name}:${d}`)
        return consume
      },
      invalidate: () => {},
    })
    const s = new VStack([child('a', false), child('b', true), child('c', false)])
    expect(s.handleInput('k')).toBe(true)
    expect(seen).toEqual(['a:k', 'b:k'])
    expect(new VStack([child('d', false)]).handleInput('k')).toBe(false)
  })

  it('VStack invalidate reaches every child', () => {
    const t = new Text('hello world')
    const s = new VStack([t])
    s.render(11)
    const cached = t.render(11)
    s.render(11)
    expect(t.render(11)).toBe(cached)
    s.invalidate()
    expect(t.render(11)).not.toBe(cached)
    s.clear()
    expect(s.render(11)).toEqual([])
  })
})
