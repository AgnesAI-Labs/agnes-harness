import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { type Colour, CURSOR_MARKER, createAnsi } from '../src/ansi.js'
import { listCustomThemes, loadCustomTheme } from '../src/custom-theme.js'
import { DALTONIZED, PALETTE, type Tone } from '../src/palette.js'
import { TuiTheme } from '../src/theme.js'
import { ThemeController } from '../src/theme-controller.js'
import { readTheme, saveTheme } from '../src/theme-preference.js'
import { ThemePicker } from '../src/views/theme-picker.js'

describe('TUI themes', () => {
  it('persists across instances, falls back on invalid data and reports write failures', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-theme-'))
    const path = join(dir, 'tui-theme.json')
    try {
      expect(readTheme(path)).toBe('auto')
      expect(saveTheme(path, 'light')).toBe(true)
      expect(readTheme(path)).toBe('light')
      expect(saveTheme(path, 'dark')).toBe(true)
      expect(readTheme(path)).toBe('dark')
      expect(saveTheme(path, 'light')).toBe(true)
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ theme: 'light' })
      writeFileSync(path, '{broken')
      expect(readTheme(path)).toBe('auto')
      writeFileSync(path, '{"theme":"neon"}')
      expect(readTheme(path)).toBe('auto')
      expect(saveTheme(path, 'dark-daltonized')).toBe(true)
      expect(readTheme(path)).toBe('dark-daltonized')
      expect(saveTheme(path, 'light-daltonized')).toBe(true)
      expect(readTheme(path)).toBe('light-daltonized')
      expect(saveTheme(join(path, 'child'), 'mono')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('opens at the current selection, cancels without changes and accepts keyboard selection', () => {
    const choose = vi.fn()
    const picker = new ThemePicker(new TuiTheme('light').ansi(createAnsi('256')), 'zh-CN', choose)
    picker.show('dark')
    expect(picker.render(90).join('\n')).toContain('❯ 3.')
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
    expect(text).toContain('⌕ MO  1/6')
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

  it('colour-blind themes: listed in the picker, applied over their base, distinct and readable', () => {
    const lum = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
    }
    const ratio = (a: string, b: string): number => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
      return ((x ?? 0) + 0.05) / ((y ?? 0) + 0.05)
    }
    const choose = vi.fn()
    const picker = new ThemePicker(new TuiTheme('dark').ansi(createAnsi('none')), 'en', choose)
    picker.show('auto')
    for (const ch of 'daltonized') picker.handleInput(ch)
    picker.handleInput('\r')
    expect(choose).toHaveBeenCalledWith('dark-daltonized')
    const dir = mkdtempSync(join(tmpdir(), 'agh-daltonized-'))
    try {
      const path = join(dir, 'tui-theme.json')
      expect(saveTheme(path, 'light-daltonized')).toBe(true)
      const themes = new ThemeController({
        term: { background: 'dark' },
        path,
        locale: 'en',
        base: createAnsi('truecolor'),
        notice: () => {},
        repaint: () => {},
      })
      expect(themes.theme.colour('success')).toBe(DALTONIZED['light-daltonized'].tones.success)
      expect(themes.theme.colour('bg')).toBe(PALETTE.light.bg)
      themes.set('dark-daltonized')
      expect(themes.theme.colour('danger')).toBe(DALTONIZED['dark-daltonized'].tones.danger)
      expect(themes.theme.colour('fg')).toBe(PALETTE.dark.fg)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    for (const { base, tones } of Object.values(DALTONIZED)) {
      const states = [tones.success, tones.warning, tones.danger]
      expect(new Set(states).size).toBe(3)
      for (const s of states) {
        expect(s).not.toBe(PALETTE[base].success)
        expect(s).not.toBe(PALETTE[base].danger)
        expect(ratio(s, PALETTE[base].bg)).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  describe('custom colour themes', () => {
    const scratch = () => {
      const dir = mkdtempSync(join(tmpdir(), 'agh-custom-theme-'))
      const themes = join(dir, 'tui-themes')
      mkdirSync(themes)
      return { dir, themes, path: join(dir, 'tui-theme.json') }
    }
    const open = (path: string, tier: 'truecolor' | 'none' = 'truecolor', locale = 'en') => {
      const notices: string[] = []
      const repaints: number[] = []
      const themes = new ThemeController({
        term: { background: 'dark' },
        path,
        locale,
        base: createAnsi(tier),
        notice: (text) => void notices.push(text),
        repaint: () => void repaints.push(1),
      })
      return { themes, notices, repaints, ansi: themes.theme.ansi(createAnsi(tier)) }
    }

    it('applies a valid theme over the palette it extends, and keeps the other preference keys', () => {
      const { dir, themes, path } = scratch()
      try {
        writeFileSync(
          join(themes, 'ocean.json'),
          JSON.stringify({ extends: 'light', tones: { accent: '#00AAFF' } }),
        )
        writeFileSync(path, JSON.stringify({ theme: 'dark', statusLine: ['model'] }))
        const t = open(path)
        expect(listCustomThemes(themes)).toEqual(['ocean'])
        expect(t.themes.set('custom:ocean')).toBe('theme custom:ocean · preference saved')
        expect(t.themes.theme.name).toBe('light')
        expect(t.ansi.fg('accent', 'x')).toBe('\x1b[38;2;0;170;255mx\x1b[39m')
        expect(t.themes.theme.colour('fg')).toBe(PALETTE.light.fg)
        expect(t.repaints).toHaveLength(1)
        expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
          theme: 'custom:ocean',
          statusLine: ['model'],
        })
        expect(open(path).themes.theme.colour('accent')).toBe('#00aaff')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('refuses the whole file for each kind of invalid input and says why, changing nothing', () => {
      const { dir, themes, path } = scratch()
      try {
        const files: Record<string, string> = {
          unknownTone: JSON.stringify({ tones: { sparkle: '#000000' } }),
          unknownKey: JSON.stringify({ colours: {} }),
          badValue: JSON.stringify({ tones: { accent: '#0af', fg: '#ffffff' } }),
          notHex: JSON.stringify({ tones: { accent: 'red' } }),
          badBase: JSON.stringify({ extends: 'mono' }),
          notObject: '[]',
          broken: '{nope',
          big: JSON.stringify({ tones: { accent: '#000000' }, pad: 'x'.repeat(9000) }),
        }
        for (const [name, text] of Object.entries(files))
          writeFileSync(join(themes, `${name.toLowerCase()}.json`), text)
        const t = open(path)
        const reasons: Record<string, string> = {
          unknowntone: 'unknown key "sparkle"',
          unknownkey: 'unknown key "colours"',
          badvalue: '"accent" must be a colour like #rrggbb',
          nothex: '"accent" must be a colour like #rrggbb',
          badbase: '"extends" must be "dark" or "light"',
          notobject: 'the file must be a JSON object',
          broken: 'the file is not valid JSON',
          big: 'the file is over 8 KB',
        }
        for (const [name, reason] of Object.entries(reasons))
          expect(t.themes.set(`custom:${name}`)).toContain(`theme custom:${name} not applied: ${reason}`)
        expect(t.themes.theme.name).toBe('dark')
        expect(t.themes.theme.colour('accent')).toBe(PALETTE.dark.accent)
        expect(t.repaints).toEqual([])
        expect(existsSync(path)).toBe(false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('refuses bad names, symbolic links and missing files', () => {
      const { dir, themes, path } = scratch()
      try {
        writeFileSync(join(dir, 'outside.json'), '{}')
        symlinkSync(join(dir, 'outside.json'), join(themes, 'linked.json'))
        writeFileSync(join(themes, 'Upper.json'), '{}')
        writeFileSync(join(themes, 'fine.json'), '{}')
        expect(listCustomThemes(themes)).toEqual(['fine'])
        for (const name of ['../outside', 'Upper', 'a/b', '', 'x'.repeat(33)])
          expect(loadCustomTheme(themes, name)).toEqual({ problem: { code: 'name' } })
        expect(loadCustomTheme(themes, 'linked')).toEqual({ problem: { code: 'symlink' } })
        expect(loadCustomTheme(themes, 'gone')).toEqual({ problem: { code: 'missing' } })
        expect(loadCustomTheme(themes, 'fine')).toEqual({ theme: { base: 'dark', tones: {} } })
        expect(open(path).themes.set('custom:../outside')).toContain('not applied')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('starts on auto and says so once when the saved custom theme is gone, in the user language', () => {
      const { dir, path } = scratch()
      try {
        writeFileSync(path, JSON.stringify({ theme: 'custom:gone' }))
        const t = open(path, 'truecolor', 'zh-CN')
        expect(t.themes.theme.name).toBe('dark')
        t.themes.follow()
        t.themes.follow()
        expect(t.notices).toEqual([
          'theme custom:gone 无法加载（tui-themes 文件夹里没有这个文件），改用 auto',
        ])
        expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ theme: 'custom:gone' })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('stays uncoloured in a colourless terminal even with a custom theme chosen', () => {
      const { dir, themes, path } = scratch()
      try {
        writeFileSync(
          join(themes, 'loud.json'),
          JSON.stringify({ tones: { accent: '#ff0000', bg: '#000001' } }),
        )
        const t = open(path, 'none')
        t.themes.set('custom:loud')
        expect(t.ansi.fg('accent', 'x')).toBe('x')
        expect(t.themes.theme.frame(createAnsi('none'), ['x'], 3, 1)).toEqual(['x'])
        const mono = new TuiTheme('mono', { accent: '#ff0000' })
        expect(mono.ansi(createAnsi('truecolor')).fg('accent', 'x')).toBe('x')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('lists the user themes after the built-in ones in the picker', () => {
      const choose = vi.fn()
      const picker = new ThemePicker(new TuiTheme('dark').ansi(createAnsi('none')), 'en', choose)
      picker.show('custom:ocean', ['ocean', 'sunset'])
      const text = picker.render(80).join('\n')
      expect(text).toContain('Custom · ocean ✓')
      expect(text).toContain('Custom · sunset')
      picker.handleInput('\x1b[B')
      picker.handleInput('\r')
      expect(choose).toHaveBeenCalledWith('custom:sunset')
    })
  })
})
