import { describe, expect, it } from 'vitest'
import { ANSI_RE, createAnsi } from '../../src/tui/ansi.js'
import { installKeymap, Keymap } from '../../src/tui/keymap.js'
import type { KeyName } from '../../src/tui/keys.js'
import { displayWidth } from '../../src/tui/terminal.js'
import { TuiTheme, type TuiThemeName } from '../../src/tui/theme.js'
import { WelcomeBanner, type WelcomeFacts, welcomeTips } from '../../src/tui/views/welcome-banner.js'

const BRANDING = { accent: '#5E57FE', mark: 'agnes', selfLabel: 'Agnes AI' }
const NOW = new Date(2026, 9, 21, 20, 0, 0).getTime()
const FACTS: WelcomeFacts = {
  version: '0.9.3',
  workspace: { root: '~/agnes-harness', branch: 'feat/x', ahead: 2 },
  modelDetail: 'reasoning high',
  resources: { plugins: 12, skills: 8, mcp: 2 },
  recent: [
    { at: NOW - 2 * 3600_000, title: 'DevBoard seed review' },
    { at: NOW - 26 * 3600_000, title: 'Cold-start profiling' },
  ],
  tip: { text: 'Press ctrl+o to see the plugins.', fresh: true },
}

const MARK = [
  ' █████╗  ██████╗ ███╗   ██╗███████╗███████╗',
  '██╔══██╗██╔════╝ ████╗  ██║██╔════╝██╔════╝',
  '███████║██║  ███╗██╔██╗ ██║█████╗  ███████╗',
  '██╔══██║██║   ██║██║╚██╗██║██╔══╝  ╚════██║',
  '██║  ██║╚██████╔╝██║ ╚████║███████╗███████║',
  '╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝╚══════╝╚══════╝',
]

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
    model: o.model ?? 'deepseek-flash',
    branding: o.branding ?? BRANDING,
    ansi: theme.ansi(createAnsi(o.tier ?? '256')),
    theme,
    ...(o.locale ? { locale: o.locale } : {}),
    ...(o.rows ? { viewport: () => ({ rows: o.rows as number }) } : {}),
    now: () => NOW,
  })
  banner.update(o.facts ?? FACTS)
  return banner
}

describe('welcome layouts', () => {
  it('draws the full hero at 120x36 and above: shadowed wordmark, identity, dust, tip and a two-column card', () => {
    const lines = make({ rows: 40 }).render(132)
    const plain = lines.map(strip)
    // The ANSI Shadow wordmark on six rows, the identity in the middle of them, dust on the right.
    expect(plain.slice(0, 6).map((l) => l.slice(1, 44))).toEqual(MARK)
    expect(
      make({ tier: 'none', rows: 40 })
        .render(132)
        .slice(0, 6)
        .map((l) => l.slice(1, 44)),
    ).toEqual(MARK)
    expect(plain[1]).toContain('Agnes AI  v0.9.3')
    expect(plain[2]).toContain('local agent workbench')
    expect(plain[4]).toContain('·ᴗ·')
    expect(plain.slice(0, 6).join('')).toMatch(/[⠁-⣿]/)
    expect(plain[6]?.trim()).toBe('')
    expect(plain[7]).toMatch(/^ ✦ Tip {2}Press ctrl\+o to see the plugins\. {2}NEW +$/)
    expect(plain[9]).toMatch(/^ ╭─+╮ $/)
    // The card hugs its content: no blank row under the top border or above the bottom one.
    expect(plain[10]).toContain('Good evening')
    expect(plain.at(-2)).toContain('/resume for more')
    const card = plain.slice(9).join('\n')
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
    // Colours: the blocks take the gradient, the shadow strokes one quieter tone.
    const theme = new TuiTheme('dark')
    const ansi = theme.ansi(createAnsi('256'))
    expect(lines[0]).toContain(ansi.fg(theme.rampAt(0) as `#${string}`, '█'))
    expect(lines[0]).toContain(ansi.fg('borderStrong', '╗'))
    expect(lines[9]).toContain(ansi.fg('border', `╭${'─'.repeat(128)}╮`))
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
    if (shape === 'full') expect(lines.slice(0, 6).join('')).toMatch(/[⠁-⣿]/)
    if (shape === 'full' || shape === 'half') {
      // The same 44-column wordmark at every tier from 60 columns; only the full hero has dust.
      expect(lines.slice(0, 6).map((l) => l.slice(1, 44))).toEqual(MARK)
      if (shape === 'half') expect(lines.join('')).not.toMatch(/[⠁-⣿]/)
    } else {
      expect(lines).toHaveLength(2)
      expect(lines[0]).toContain('agnes ·ᴗ· v0.9.3 · deepseek-flash')
      expect(lines[1]).toContain('local-dev · ~/agnes-harness • feat/x')
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
      for (const cols of [1, 2, 10, 23, 24, 30, 50, 59, 60, 70, 79, 80, 99, 100, 119, 120, 132, 200])
        for (const rows of [undefined, 20, 24, 30, 36, 50]) {
          const lines = make({ theme, ...(rows ? { rows } : {}) }).render(cols)
          expect(lines.every((line) => displayWidth(line) <= cols)).toBe(true)
          if (rows && cols >= 24 && rows >= 24) expect(lines.length).toBeLessThanOrEqual(rows - 5)
        }
  })

  it('draws the same dust field at every width, flush right', () => {
    const tail = (cols: number): string =>
      (text(make({ rows: 40 }).render(cols)).split('\n')[5] ?? '').slice(-35, -1)
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
      viewport: () => ({ rows: 40 }),
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
      expect(make({ tier: 'none', rows: 40 }).render(cols).join('\n')).not.toContain('\x1b')
    const mono = make({ theme: 'mono', rows: 40 }).render(132)
    expect(strip(mono[0] as string)).toMatch(/^ +█████╗/)
    const joined = mono.join('\n')
    // Blocks bold, shadow strokes dim, nothing coloured and no dust.
    expect(joined).toContain('\x1b[1m█████')
    expect(joined).toContain('\x1b[2m╗')
    expect(strip(joined)).not.toContain('\x1b')
    expect(joined).not.toMatch(/\[[34]8;/)
    expect(joined).not.toMatch(/[⠁-⣿]/)
    // The identity keeps its column whatever the glyph row's length.
    expect(mono.map((l) => strip(l).indexOf('Agnes AI')).filter((i) => i >= 0)).toEqual([47])
    expect(strip(mono[2] as string).indexOf('local agent')).toBe(47)
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

it('spells tip key names from the keymap and keeps each tip to one line', () => {
  const tips = welcomeTips('en').map((tip) => tip.text)
  expect(tips.join('\n')).toContain('Press ctrl+o to expand')
  expect(tips.join('\n')).toContain('Press alt+enter while a turn runs')
  expect(tips.every((tip) => !tip.includes('{') && !tip.includes('\n'))).toBe(true)
  expect(welcomeTips('zh-CN').map((tip) => tip.text)).not.toEqual(tips)
})

describe('welcome motion', () => {
  const T0 = NOW
  function animated(
    over: { theme?: TuiThemeName; tier?: 'none' | '256'; motion?: boolean; random?: number } = {},
  ) {
    let t = T0
    const theme = new TuiTheme(over.theme ?? 'dark')
    const banner = new WelcomeBanner({
      profile: 'local-dev',
      model: 'deepseek-flash',
      branding: BRANDING,
      ansi: theme.ansi(createAnsi(over.tier ?? '256')),
      theme,
      viewport: () => ({ rows: 40 }),
      now: () => t,
      random: () => over.random ?? 0.5,
      motion: over.motion ?? true,
    })
    banner.update(FACTS)
    return {
      banner,
      at: (ms: number) => {
        t = T0 + ms
      },
    }
  }
  const still = make({ rows: 40 }).render(132)

  it('sweeps a shine across the wordmark for 1.2 s, then draws exactly the still layout', () => {
    const { banner, at } = animated()
    banner.start()
    at(0)
    expect(banner.tick()).toBe(60)
    const first = banner.render(132)
    at(600)
    const middle = banner.render(132)
    expect(middle).not.toEqual(first)
    expect(middle.map(strip)).toEqual(still.map(strip))
    at(1199)
    expect(banner.tick()).toBe(60)
    at(1200)
    // The NEW tag is still cycling its hue here; everything else is back to the still picture.
    expect(banner.render(132).slice(0, 6)).toEqual(still.slice(0, 6))
    expect(banner.render(132).slice(9)).toEqual(still.slice(9))
  })

  it('cycles the NEW tag for 2.4 s and holds the plain accent afterwards', () => {
    const { banner, at } = animated()
    banner.start()
    at(1000)
    expect(banner.render(132)[7]).not.toEqual(still[7])
    at(1500)
    expect(banner.tick()).toBe(80)
    at(2400)
    expect(banner.render(132)).toEqual(still)
  })

  it('blinks every four to six seconds for 150 ms and reopens on settle', () => {
    // 0.25 puts the first blink at 4.5 s, between two sweeps.
    const { banner, at } = animated({ random: 0.25 })
    banner.start()
    at(2400)
    expect(banner.tick()).toBe(2100)
    expect(strip(banner.render(132)[4] as string)).toContain('·ᴗ·')
    at(4500)
    expect(banner.tick()).toBe(150)
    expect(strip(banner.render(132)[4] as string)).toContain('˘ᴗ˘')
    at(4600)
    banner.settle()
    expect(strip(banner.render(132)[4] as string)).toContain('·ᴗ·')
    at(4650)
    expect(banner.tick()).toBe(350)
    expect(banner.render(132)).toEqual(still)
  })

  it('repeats the shine every 5 s: sweep, rest, sweep again', () => {
    const { banner, at } = animated()
    banner.start()
    const wordmark = () => banner.render(132).slice(0, 6)
    at(600)
    const sweep = wordmark()
    expect(sweep).not.toEqual(still.slice(0, 6))
    at(3000)
    // Resting: the still layout, and the next wake-up is the next sweep (or a blink before it).
    expect(wordmark()).toEqual(still.slice(0, 6))
    expect(banner.tick()).toBe(2000)
    at(5000)
    expect(banner.tick()).toBe(60)
    at(5600)
    expect(wordmark()).toEqual(sweep)
    at(6200)
    expect(wordmark()).toEqual(still.slice(0, 6))
    at(15600)
    expect(wordmark()).toEqual(sweep)
  })

  it('stays still without motion, in mono and on the none tier', () => {
    for (const over of [{ motion: false }, { theme: 'mono' as const }, { tier: 'none' as const }]) {
      const { banner, at } = animated(over)
      banner.start()
      at(5000)
      expect(banner.animates).toBe(false)
      expect(banner.tick()).toBeUndefined()
      const stillBanner = make({ ...over, rows: 40 })
      expect(banner.render(132)).toEqual(stillBanner.render(132))
    }
  })
})

it('spells every separator of a multi-modifier binding in the tips', () => {
  installKeymap(new Keymap(new Map([['card-toggle', ['ctrl-alt-x' as KeyName]]])))
  try {
    expect(
      welcomeTips('en')
        .map((tip) => tip.text)
        .join('\n'),
    ).toContain('Press ctrl+alt+x to expand')
  } finally {
    installKeymap(new Keymap())
  }
})
