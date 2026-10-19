import { expect, it } from 'vitest'
import { ANSI_RE, type Colour, createAnsi } from '../../src/tui/ansi.js'
import { displayWidth } from '../../src/tui/terminal.js'
import { TuiTheme } from '../../src/tui/theme.js'
import { WelcomeBanner } from '../../src/tui/views/welcome-banner.js'

const BRANDING = { accent: '#5E57FE', mark: 'agnes', selfLabel: 'Agnes AI' }

const MONO = new TuiTheme('mono')
const PLAIN = MONO.ansi(createAnsi('none'))
const strip = (s: string): string => s.replace(ANSI_RE, '')
const WORDMARK = ['▄▀▀▄ ▄▀▀▀ █▄ █ █▀▀▀ ▄▀▀▀', '█▀▀█ █ ▀█ █ ▀█ █▀▀   ▀▀▄', '▀  ▀  ▀▀▀ ▀  ▀ ▀▀▀▀ ▀▀▀']

it('renders a compact Agnes session card with brand, context, model and command hint', () => {
  const banner = new WelcomeBanner({
    profile: 'local-dev',
    preset: 'standard',
    model: 'deepseek-v4-pro',
    branding: BRANDING,
    ansi: PLAIN,
    theme: MONO,
  })
  const lines = banner.render(80)
  expect(lines).toHaveLength(9)
  expect(lines.slice(0, 3)).toEqual([` ${WORDMARK[0]}`, ` ${WORDMARK[1]} ·ᴗ·`, ` ${WORDMARK[2]}`])
  expect(lines[3]).toContain('Agnes AI ·ᴗ·')
  expect(lines[4]).toContain('╭')
  expect(strip(lines[5] as string)).toContain('New ideas start here')
  expect(strip(lines[6] as string)).toContain('local-dev · standard')
  expect(strip(lines[7] as string)).toContain('● deepseek-v4-pro')
  expect(strip(lines[7] as string)).toContain('Type / for commands')
  expect(lines[8]).toContain('╰')
  // Before the opening projection arrives, the card reports resolution in progress rather than
  // claiming the session has no model. Projection truth then replaces that temporary copy.
  const noModel = new WelcomeBanner({
    profile: 'local-dev',
    preset: 'standard',
    branding: BRANDING,
    ansi: PLAIN,
    theme: MONO,
  })
  // Below 60 columns the wordmark drops and the title line leads.
  const narrowed = noModel.render(50)
  expect(narrowed).toHaveLength(6)
  expect(narrowed[0]).toContain('Agnes AI ·ᴗ·')
  expect(strip(narrowed[3] as string)).toContain('local-dev · standard')
  expect(strip(narrowed[4] as string)).toContain('resolving model')
  noModel.setModel('kimi-for-coding-highspeed')
  expect(strip(noModel.render(50)[4] as string)).toContain('kimi-for-coding-highspeed')
  expect(strip(noModel.render(50)[4] as string)).not.toContain('resolving model')
})

it('uses the theme accent for the stock brand, the brand ramp for the wordmark, none tier stays plain', () => {
  const theme = new TuiTheme('dark')
  const ansi = theme.ansi(createAnsi('256'))
  const banner = new WelcomeBanner({ profile: 'p', preset: 's', branding: BRANDING, ansi, theme })
  const lines = banner.render(40)
  expect(lines[0]).toContain(ansi.fg('accent', 'Agnes AI'))
  expect(lines[0]).toContain('\x1b[1m')
  expect(lines[0]).toContain(ansi.fg('accentSoft', '·ᴗ·'))
  expect(lines[2]).toContain('\x1b[1m')
  expect(lines[3]).toContain(ansi.fg('border', '│'))
  expect(lines[4]).toContain(ansi.fg('success', '●'))
  const wide = banner.render(60)
  const ramp = theme.ramp()
  for (const [i, row] of WORDMARK.entries())
    expect(wide[i]).toContain(ansi.bold(ansi.fg(ramp[i] as Colour, row)))
  expect(wide[1]).toContain(ansi.fg('accentSoft', '·ᴗ·'))
  // Mono has no ramp: the wordmark carries the brand by weight alone.
  const mono = new WelcomeBanner({
    profile: 'p',
    preset: 's',
    branding: BRANDING,
    ansi: MONO.ansi(createAnsi('256')),
    theme: MONO,
  })
  expect(mono.render(60)[0]).toBe(` \x1b[1m${WORDMARK[0]}\x1b[22m`)
  const plain = new WelcomeBanner({ profile: 'p', preset: 's', branding: BRANDING, ansi: PLAIN, theme: MONO })
  expect(plain.render(60).join('\n')).not.toContain('\x1b')
})

it('stays within the given width at narrow and wide sizes', () => {
  const banner = new WelcomeBanner({
    profile: 'local-dev',
    preset: 'standard',
    branding: BRANDING,
    ansi: new TuiTheme('dark').ansi(createAnsi('256')),
    theme: new TuiTheme('dark'),
  })
  for (const width of [1, 2, 10, 30, 50, 59, 60, 120])
    expect(banner.render(width).every((line) => displayWidth(line) <= width)).toBe(true)
})

it('renders a supplied branding contract instead of a local product-name source', () => {
  const banner = new WelcomeBanner({
    profile: 'p',
    preset: 's',
    branding: { accent: '#00875A', mark: 'acme', selfLabel: 'Acme Workbench' },
    ansi: PLAIN,
    theme: MONO,
  })
  // The half-block glyphs spell the default brand, so a supplied brand opens on its own title.
  expect(banner.render(80)[0]).toContain('Acme Workbench')
  expect(banner.render(80).join('\n')).toContain('p · s')
  expect(banner.render(80).join('\n')).not.toContain('Agnes AI')
})
