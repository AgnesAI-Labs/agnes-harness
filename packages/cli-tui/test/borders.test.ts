import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Borders } from '../src/borders.js'
import { asciiFold, foldingTerminal, GLYPHS } from '../src/glyphs.js'
import { displayWidth, FakeTerminal } from '../src/terminal.js'

const dirs: string[] = []
const prefs = (content?: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agh-borders-'))
  dirs.push(dir)
  const path = join(dir, 'tui-theme.json')
  if (content !== undefined) writeFileSync(path, content)
  return path
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the glyph table', () => {
  it('gives every glyph one ASCII character of the same width, so a row keeps the width it was laid out at', () => {
    expect(GLYPHS.size).toBeGreaterThan(60)
    for (const [glyph, look] of GLYPHS) {
      expect(look, glyph).toMatch(/^[\x20-\x7e]$/)
      expect(displayWidth(look), glyph).toBe(displayWidth(glyph))
    }
  })

  it('folds chrome to ASCII and leaves everything else as it is', () => {
    expect(asciiFold('╭─ ◆ read ─╮\n│ ✓ done · 3… │\n╰─ ❯ ⏎ ─╯')).toBe(
      '+- * read -+\n| v done . 3~ |\n+- > < -+',
    )
    // Words, other scripts, emoji and escape sequences are not chrome.
    const kept = '\x1b[31m你好 café 😀 ok\x1b[0m \x1b]8;;http://x/y\x07'
    expect(asciiFold(kept)).toBe(kept)
    // A chrome character the table has not heard of still comes out as ASCII.
    expect(asciiFold('▓■⣿⠀┃')).toBe('#*. +')
    // Both spinner sets turn round in ASCII: ten braille frames, four looks.
    expect([...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'].map((frame) => asciiFold(frame)).join('')).toBe('|/-\\|/-\\|/')
  })

  it('folds what is written to the terminal only while asked, and passes everything else through', () => {
    const real = new FakeTerminal({ columns: 30, rows: 5 })
    let ascii = false
    const term = foldingTerminal(real, () => ascii)
    term.write('╭─╮')
    ascii = true
    term.write('╭─╮')
    expect(real.writes).toEqual(['╭─╮', '+-+'])
    expect(term.size()).toEqual({ columns: 30, rows: 5 })
    expect(term.caps).toBe(real.caps)
    term.enterRaw()
    expect(real.raw).toBe(true)
  })
})

describe('Borders', () => {
  it('starts in unicode, and in ascii on the Linux console, unless a choice was saved', () => {
    expect(new Borders({ path: prefs('{}'), env: {} }).mode).toBe('unicode')
    expect(new Borders({ path: prefs('{}'), env: { TERM: 'xterm-256color' } }).mode).toBe('unicode')
    expect(new Borders({ path: prefs('{}'), env: { TERM: 'linux' } }).mode).toBe('ascii')
    expect(new Borders({ env: { TERM: 'linux' } }).ascii).toBe(true)
    expect(new Borders({ path: prefs('{"borders":"unicode"}'), env: { TERM: 'linux' } }).mode).toBe('unicode')
    expect(new Borders({ path: prefs('{"borders":"ascii"}'), env: {} }).mode).toBe('ascii')
    for (const bad of ['{"borders":"fancy"}', '{"borders":3}', '{broken', '[]'])
      expect(new Borders({ path: prefs(bad), env: {} }).mode).toBe('unicode')
  })

  it('sets and saves the mode beside the other preferences, and says what is in force', () => {
    const path = prefs('{"theme":"dark","statusLine":{"hide":["preset"]},"title":"off","vim":true}')
    let changes = 0
    const borders = new Borders({ path, env: {}, changed: () => changes++ })
    expect(borders.command([], 'en')).toContain('Unicode')
    expect(borders.command(['ascii'], 'en')).toBe('Borders: ASCII only (+ - | * > and so on)')
    expect([borders.mode, changes]).toEqual(['ascii', 1])
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      theme: 'dark',
      statusLine: { hide: ['preset'] },
      title: 'off',
      vim: true,
      borders: 'ascii',
    })
    expect(borders.command(['unicode'], 'zh-CN')).toBe('边框：Unicode 框线和图标')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      theme: 'dark',
      vim: true,
      borders: 'unicode',
    })
    expect(new Borders({ path, env: {} }).mode).toBe('unicode')
  })

  it('refuses anything else with the usage line, and says when nothing could be saved', () => {
    const borders = new Borders({ path: prefs('{}'), env: {} })
    for (const args of [['dotted'], ['ascii', 'extra']]) {
      expect(borders.command(args, 'en')).toBe('usage: /borders unicode|ascii')
      expect(borders.mode).toBe('unicode')
    }
    expect(new Borders({ env: {} }).command(['ascii'], 'en')).toContain('not saved')
  })
})
