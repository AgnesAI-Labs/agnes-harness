import { describe, expect, it } from 'vitest'
import { ANSI_RE, createAnsi } from '../../src/tui/ansi.js'
import { displayWidth } from '../../src/tui/terminal.js'
import { TuiTheme, type TuiThemeName } from '../../src/tui/theme.js'
import { WelcomeBanner, type WelcomeFacts } from '../../src/tui/views/welcome-banner.js'

const BRANDING = { accent: '#5E57FE', mark: 'agnes', selfLabel: 'Agnes AI' }
const NOW = new Date(2026, 9, 21, 20, 0, 0).getTime()
const FACTS: WelcomeFacts = {
  version: '0.9.3',
  boot: { ms: 420, cold: false },
  workspace: { root: '~/agnes-harness', branch: 'feat/x', ahead: 2 },
  session: { id: 'aaaa822ce1de', generation: 1 },
  modelDetail: 'reasoning high',
  resources: { plugins: 12, skills: 8, mcp: 2 },
  recent: [
    { at: NOW - 2 * 3600_000, title: 'DevBoard seed review' },
    { at: NOW - 26 * 3600_000, title: 'Cold-start profiling' },
  ],
  tip: { text: 'Press ctrl+o to see the plugins.', fresh: true },
}

const strip = (s: string): string => s.replace(ANSI_RE, '')
const text = (lines: string[]): string => lines.map(strip).join('\n')

function make(
  o: {
    theme?: TuiThemeName
    tier?: 'none' | '256'
    branding?: typeof BRANDING
    rows?: number
    facts?: WelcomeFacts
    model?: string
    locale?: string
  } = {},
): WelcomeBanner {
  const theme = new TuiTheme(o.theme ?? 'dark')
  const banner = new WelcomeBanner({
    profile: 'local-dev',
    preset: 'default',
    model: o.model ?? 'deepseek-flash',
    branding: o.branding ?? BRANDING,
    ansi: theme.ansi(createAnsi(o.tier ?? '256')),
    theme,
    ...(o.locale ? { locale: o.locale } : {}),
    ...(o.rows ? { rows: () => o.rows as number } : {}),
    now: () => NOW,
  })
  banner.update(o.facts ?? FACTS)
  return banner
}

describe('welcome layouts', () => {
  it('draws the full hero at 120x36 and above: shadowed wordmark, identity, dust, tip and a two-column card', () => {
    const lines = make({ rows: 40 }).render(132)
    const plain = lines.map(strip)
    expect(lines).toHaveLength(23)
    // Eight wordmark rows (seven glyph rows plus the shadow row), two columns per pixel.
    expect(plain[0]).toMatch(/^ {3}██████ {8}██████/)
    // Without colour the shadow is not drawn, so the glyph rows read as the font.
    expect(make({ tier: 'none', rows: 40 }).render(132)[3]).toContain(
      '██████████    ██  ██████    ██    ████    ████████',
    )
    expect(plain[2]).toContain('Agnes AI  v0.9.3')
    expect(plain[3]).toContain('local agent workbench')
    expect(plain[5]).toContain('·ᴗ·  ready · daemon warm 0.42s')
    expect(plain.slice(0, 8).join('')).toMatch(/[⠁-⣿]/)
    expect(plain[9]).toMatch(/^ ✦ Tip {2}Press ctrl\+o to see the plugins\. {2}NEW +$/)
    expect(plain[11]).toMatch(/^ ╭─ local-dev · default ─+ #822ce1de · g1 ─╮ $/)
    const card = plain.slice(11).join('\n')
    expect(card).toContain('Good evening. What shall we build?')
    expect(card).toContain('● deepseek-flash   reasoning high')
    expect(card).toContain('⌂ ~/agnes-harness • feat/x  +2 ahead')
    expect(card).toContain('◉ 12 plugins   ◉ 8 skills   ◉ 2 MCP servers')
    expect(card).toMatch(/│ Start here +│/)
    expect(card).toMatch(/\/resume +pick up where you left off/)
    expect(card).toMatch(/│ Recent +│/)
    expect(card).toMatch(/2h {2}DevBoard seed review/)
    expect(card).toMatch(/1d {2}Cold-start profiling/)
    expect(card).toContain('/resume for more')
    expect(plain.at(-1)).toMatch(/^ ╰─+╯ $/)
    // The shadow row and the colours: drop shadow in the selection tone, gradient on the pixels.
    const theme = new TuiTheme('dark')
    const ansi = theme.ansi(createAnsi('256'))
    expect(lines[1]).toContain(ansi.fg('selection', '██'))
    expect(lines[0]).toContain(ansi.fg(theme.rampAt(0) as `#${string}`, '██'))
    expect(lines[11]).toContain(ansi.fg('border', '╭─'))
  })

  it.each([
    // [cols, rows, first-line shape]
    [132, 40, 'full'],
    [120, 36, 'full'],
    [120, 35, 'half'],
    [119, 40, 'half'],
    [100, 30, 'half'],
    [80, 24, 'half'],
    [79, 24, 'half'],
    [60, 24, 'half'],
    [59, 40, 'line'],
    [100, 23, 'line'],
    [50, 20, 'line'],
  ] as const)('chooses the layout for %i x %i', (cols, rows, shape) => {
    const lines = make({ rows }).render(cols).map(strip)
    if (shape === 'full') expect(lines[0]).toContain('██')
    else if (shape === 'half') {
      expect(lines[0]).toContain('▄▀▀▀▄')
      expect(lines.join('')).not.toContain('██')
    } else {
      expect(lines).toHaveLength(2)
      expect(lines[0]).toContain('agnes ·ᴗ· v0.9.3 · deepseek-flash')
      expect(lines[1]).toContain('local-dev · default · ~/agnes-harness • feat/x')
    }
  })

  it('puts recent sessions under the card from 80 columns and drops the right column below', () => {
    const wide = text(make({ rows: 40 }).render(100))
    expect(wide).toMatch(
      /\n Recent *\n {3}2h {2}DevBoard seed review *\n {3}1d {2}Cold-start profiling *\n \/resume for more/,
    )
    expect(wide).toMatch(/│ Start here +│/)
    const narrow = text(make({ rows: 40 }).render(70))
    expect(narrow).not.toContain('Recent')
    expect(narrow).toMatch(/│ Start here +│/)
    expect(narrow).toMatch(/│ \/skills +browse installed skills +│/)
    expect((narrow.split('\n').find((l) => l.includes('Start here')) ?? '').split('│')).toHaveLength(3)
  })

  it('never exceeds the width or the rows left above the composer, at every breakpoint', () => {
    for (const theme of ['dark', 'light', 'mono'] as const)
      for (const returning of [false, true])
        for (const cols of [1, 2, 10, 23, 24, 30, 50, 59, 60, 70, 79, 80, 99, 100, 119, 120, 132, 200])
          for (const rows of [undefined, 20, 24, 30, 36, 50]) {
            const lines = make({ theme, ...(rows ? { rows } : {}), facts: { ...FACTS, returning } }).render(
              cols,
            )
            expect(lines.every((line) => displayWidth(line) <= cols)).toBe(true)
            if (rows && cols >= 24 && rows >= 24 && !returning)
              expect(lines.length).toBeLessThanOrEqual(rows - 5)
          }
  })

  it('draws the same dust field at every width, flush right', () => {
    const tail = (cols: number): string =>
      (text(make({ rows: 40 }).render(cols)).split('\n')[7] ?? '').slice(-35, -1)
    expect(tail(132)).toBe(tail(160))
    expect(tail(132)).toMatch(/[⠁-⣿]/)
    expect(make({ rows: 40 }).render(132)).toEqual(make({ rows: 40 }).render(132))
  })
})

describe('welcome degradation', () => {
  it('omits every field it has no data for and says the model is still resolving', () => {
    const bare = make({ rows: 40, facts: {}, model: '' })
    const unresolved = new WelcomeBanner({
      profile: 'p',
      branding: BRANDING,
      ansi: new TuiTheme('dark').ansi(createAnsi('256')),
      theme: new TuiTheme('dark'),
      rows: () => 40,
      now: () => NOW,
    })
    const out = text(unresolved.render(132))
    for (const gone of ['ahead', 'plugins', '◉', 'MCP', 'Recent', 'daemon', 'Tip', '#', 'v0'])
      expect(out).not.toContain(gone)
    expect(out).toContain('resolving model')
    expect(out).toContain('Start here')
    unresolved.setModel('kimi-for-coding-highspeed')
    unresolved.update({ workspace: { root: '~/w', ahead: 0 }, resources: { mcp: 1 } })
    const filled = text(unresolved.render(132))
    expect(filled).toContain('● kimi-for-coding-highspeed')
    expect(filled).not.toContain('resolving model')
    expect(filled).toContain('⌂ ~/w')
    expect(filled).not.toContain('ahead')
    expect(filled).toContain('◉ 1 MCP server')
    expect(filled).not.toContain('plugins')
    expect(bare.render(60).length).toBeGreaterThan(0)
  })

  it('emits no escape sequence on the none tier, and bold only in mono', () => {
    for (const cols of [10, 50, 60, 100, 132])
      for (const returning of [false, true])
        expect(
          make({ tier: 'none', rows: 40, facts: { ...FACTS, returning } })
            .render(cols)
            .join('\n'),
        ).not.toContain('\x1b')
    const mono = make({ theme: 'mono', rows: 40 }).render(132)
    expect(mono[0]?.startsWith(' \x1b[1m ')).toBe(true)
    expect(strip(mono[0] as string)).toMatch(/^ +██/)
    const joined = mono.join('\n')
    expect(strip(joined)).not.toContain('\x1b')
    expect(joined).not.toMatch(/\[[34]8;/)
    expect(joined).not.toMatch(/[⠁-⣿]/)
    // No shadow: the row below the last glyph row is empty of blocks.
    expect(strip(mono[7] as string).trim()).toBe('')
  })

  it('never lets a supplied brand wear the AGNES glyphs and escapes outside text', () => {
    const acme = { accent: '#00875A', mark: 'acme', selfLabel: 'Acme\x1b[31m Workbench' }
    for (const [cols, rows] of [
      [132, 40],
      [100, 30],
      [70, 24],
      [50, 20],
    ] as const) {
      const out = text(
        make({
          branding: acme,
          rows,
          tier: 'none',
          facts: { ...FACTS, workspace: { root: '~/a\nb', branch: 'x\x1b[2Jy' } },
        }).render(cols),
      )
      expect(out).not.toMatch(/[█▀▄]/)
      expect(out).toContain('Acme[31m Workbench')
      expect(out).not.toContain('Agnes AI')
    }
    const hero = make({ branding: { ...acme, selfLabel: 'Acme Workbench' }, rows: 40 }).render(132)
    expect(strip(hero[0] as string)).toContain('Acme Workbench')
    expect(hero[0]).toContain('\x1b[1m')
  })

  it('localizes the greeting and follows the injected clock', () => {
    expect(text(make({ rows: 40, locale: 'zh-CN' }).render(132))).toContain('晚上好，今天想做点什么？')
    const morning = new Date(2026, 9, 21, 8, 0, 0).getTime()
    const theme = new TuiTheme('dark')
    const b = new WelcomeBanner({
      profile: 'p',
      branding: BRANDING,
      ansi: theme.ansi(createAnsi('none')),
      theme,
      now: () => morning,
    })
    expect(text(b.render(100))).toContain('Good morning. What shall we build?')
  })
})

describe('returning visit', () => {
  it('condenses to three rows with the mark, identity, resources, workspace and the last session', () => {
    const lines = make({ rows: 40, facts: { ...FACTS, returning: true } })
      .render(100)
      .map(strip)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('▄▀▀▄  Agnes AI  v0.9.3  ·ᴗ· welcome back')
    expect(lines[1]).toContain('█▀▀█  ● deepseek-flash · local-dev · default · ◉ 12 plugins')
    expect(lines[2]).toContain('▀  ▀  ⌂ ~/agnes-harness • feat/x  +2 ahead')
    expect(lines[2]).toContain('last: DevBoard seed review · /resume')
    const acme = make({
      branding: { accent: '#00875A', mark: 'acme', selfLabel: 'Acme' },
      facts: { ...FACTS, returning: true },
    })
    expect(text(acme.render(100))).not.toMatch(/[█▀▄]/)
  })
})
