import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { type Colour, CURSOR_MARKER, createAnsi } from '../src/ansi.js'
import { PALETTE, type Tone } from '../src/palette.js'
import { TuiTheme } from '../src/theme.js'
import { readTheme, saveTheme } from '../src/theme-preference.js'
import { ThemePicker } from '../src/views/theme-picker.js'

describe('TUI themes', () => {
  it('persists across instances, falls back on invalid data and reports write failures', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-theme-'))
    const path = join(dir, 'tui-theme.json')
    try {
      expect(readTheme(path)).toBe('dark')
      expect(saveTheme(path, 'light')).toBe(true)
      expect(new TuiTheme(readTheme(path)).name).toBe('light')
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ theme: 'light' })
      writeFileSync(path, '{broken')
      expect(readTheme(path)).toBe('dark')
      writeFileSync(path, '{"theme":"neon"}')
      expect(readTheme(path)).toBe('dark')
      expect(saveTheme(join(path, 'child'), 'mono')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('opens at the current selection, cancels without changes and accepts keyboard selection', () => {
    const choose = vi.fn()
    const picker = new ThemePicker(new TuiTheme('light').ansi(createAnsi('256')), 'zh-CN', choose)
    picker.show('dark')
    expect(picker.render(90).join('\n')).toContain('❯ 2.')
    picker.handleInput('\x1b')
    expect(choose).not.toHaveBeenCalled()
    expect(picker.render(90)).toEqual([])
    picker.show('light')
    picker.handleInput('\x1b[B')
    picker.handleInput('\r')
    expect(choose).toHaveBeenCalledWith('dark')
    expect(picker.render(90)).toEqual([])
  })
  it('filters themes by name and keeps the current-theme mark', () => {
    const choose = vi.fn()
    const picker = new ThemePicker(new TuiTheme('light').ansi(createAnsi('none')), 'en', choose)
    picker.show('dark')
    for (const ch of 'MO') picker.handleInput(ch)
    const text = picker.render(60).join('\n')
    expect(text).toContain('Filter: MO (1/3)')
    expect(text).not.toContain('Dark')
    picker.handleInput('\r')
    expect(choose).toHaveBeenCalledWith('mono')
  })
  it('paints blank rows and restores palette after nested resets without losing the cursor', () => {
    const ansi = createAnsi('256')
    const theme = new TuiTheme('dark')
    const open = (styled: string): string => styled.slice(0, styled.indexOf('\x1b[', 1))
    const tone = (layer: 'fg' | 'bg', name: Tone): string =>
      open(ansi[layer](theme.colour(name) as Colour, ''))
    const rows = theme.frame(ansi, [`a${CURSOR_MARKER}${ansi.fg(78, 'b')}c\x1b[0md`], 20, 3)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain(CURSOR_MARKER)
    expect(rows[0]).toContain(`b${tone('fg', 'fg')}c`)
    expect(rows[1]).toContain(tone('bg', 'bg'))
    theme.set('light')
    expect(theme.frame(ansi, ['a'], 20, 1)[0]).toContain(tone('bg', 'bg'))
    expect(theme.frame(createAnsi('none'), ['a'], 20, 1)[0]).not.toContain('\x1b')
    theme.set('mono')
    expect(theme.frame(ansi, ['a'], 20, 1)).toEqual(['a'])
  })
  it('keeps the 24-bit background after a nested reset inside a truecolor row', () => {
    const ansi = createAnsi('truecolor')
    const theme = new TuiTheme('dark')
    const [row] = theme.frame(ansi, [`${ansi.bg(PALETTE.dark.danger, 'x')}y\x1b[0mz`], 10, 1)
    expect(row).toBe(
      '\x1b[48;2;20;19;28m\x1b[38;2;230;227;242m' +
        '\x1b[48;2;255;107;125mx\x1b[48;2;20;19;28my' +
        '\x1b[0m\x1b[48;2;20;19;28m\x1b[38;2;230;227;242mz       \x1b[0m',
    )
    for (const tier of ['256', '16'] as const) {
      const base = createAnsi(tier)
      const bg = base.bg(theme.colour('bg') as Colour, '').replace('\x1b[49m', '')
      const [narrow] = theme.frame(base, [`${base.bg(PALETTE.dark.danger, 'x')}y\x1b[0mz`], 10, 1)
      expect(narrow).toContain(`x${bg}y`)
      expect(narrow).toContain(`\x1b[0m${bg}`)
    }
  })
  it('keeps the four state tones distinct and the text greys apart on a 16-colour terminal', () => {
    const basic = createAnsi('16')
    for (const palette of [PALETTE.light, PALETTE.dark]) {
      const states = (['success', 'warning', 'danger', 'accent'] as const).map((t) =>
        basic.fg(palette[t], 'x'),
      )
      expect(new Set(states).size).toBe(4)
      expect(basic.fg(palette.fg, 'x')).not.toBe(basic.fg(palette.muted, 'x'))
    }
    expect(basic.fg(PALETTE.light.success, 'x')).not.toBe(basic.fg(PALETTE.light.fg, 'x'))
  })
  it('resolves tones per theme, leaves data colours as given and paints nothing in mono', () => {
    const theme = new TuiTheme('light')
    const ansi = theme.ansi(createAnsi('truecolor'))
    expect(ansi.fg('accent', 'x')).toBe('\x1b[38;2;94;87;254mx\x1b[39m')
    theme.set('dark')
    expect(ansi.fg('accent', 'x')).toBe('\x1b[38;2;139;131;255mx\x1b[39m')
    expect(ansi.bg(PALETTE.light.success, 'x')).toBe('\x1b[48;2;30;138;90mx\x1b[49m')
    theme.set('mono')
    expect(ansi.fg('accent', ansi.bg(PALETTE.light.success, 'x'))).toBe('x')
    expect(theme.colour('accent')).toBeUndefined()
  })
})
