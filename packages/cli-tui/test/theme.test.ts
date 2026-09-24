import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CURSOR_MARKER, createAnsi } from '../src/ansi.js'
import { TuiTheme } from '../src/theme.js'
import { readTheme, saveTheme } from '../src/theme-preference.js'
import { ThemePicker } from '../src/views/theme-picker.js'

describe('TUI themes', () => {
  it('persists across instances, falls back on invalid data and reports write failures', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-theme-'))
    const path = join(dir, 'tui-theme.json')
    try {
      expect(readTheme(path)).toBe('light')
      expect(saveTheme(path, 'dark')).toBe(true)
      expect(new TuiTheme(readTheme(path)).name).toBe('dark')
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ theme: 'dark' })
      writeFileSync(path, '{broken')
      expect(readTheme(path)).toBe('light')
      writeFileSync(path, '{"theme":"neon"}')
      expect(readTheme(path)).toBe('light')
      expect(saveTheme(join(path, 'child'), 'mono')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('opens at the current selection, cancels without changes and accepts keyboard selection', () => {
    const choose = vi.fn()
    const picker = new ThemePicker(createAnsi('256'), choose)
    picker.show('dark')
    expect(picker.render(90).join('\n')).toContain('▶ 2.')
    picker.handleInput('\x1b')
    expect(choose).not.toHaveBeenCalled()
    expect(picker.render(90)).toEqual([])
    picker.show('light')
    picker.handleInput('\x1b[B')
    picker.handleInput('\r')
    expect(choose).toHaveBeenCalledWith('dark')
    expect(picker.render(90)).toEqual([])
  })
  it('paints blank rows and restores palette after nested resets without losing the cursor', () => {
    const ansi = createAnsi('256')
    const theme = new TuiTheme('dark')
    const rows = theme.frame(ansi, [`a${CURSOR_MARKER}${ansi.fg(78, 'b')}c\x1b[0md`], 20, 3)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain(CURSOR_MARKER)
    expect(rows[0]).toContain('b\x1b[38;5;252mc')
    expect(rows[1]).toContain('\x1b[48;5;234m')
    theme.set('light')
    expect(theme.frame(ansi, ['a'], 20, 1)[0]).toContain('\x1b[48;5;255m')
    expect(theme.frame(createAnsi('none'), ['a'], 20, 1)[0]).not.toContain('\x1b')
    theme.set('mono')
    expect(theme.frame(ansi, ['a'], 20, 1)).toEqual(['a'])
  })
})
