import { expect, it } from 'vitest'
import { ANSI_RE, createAnsi } from '../../src/tui/ansi.js'
import { displayWidth } from '../../src/tui/terminal.js'
import { WelcomeBanner } from '../../src/tui/views/welcome-banner.js'

const BRANDING = { accent: '#5E57FE', mark: 'agnes', selfLabel: 'Agnes AI' }

const strip = (s: string): string => s.replace(ANSI_RE, '')

it('renders a compact Agnes session card with brand, context, model and command hint', () => {
  const banner = new WelcomeBanner({
    profile: 'local-dev',
    preset: 'standard',
    model: 'deepseek-v4-pro',
    branding: BRANDING,
    ansi: createAnsi('none'),
  })
  const lines = banner.render(80)
  expect(lines).toHaveLength(5)
  expect(lines[0]).toContain('Agnes AI ·ᴗ·')
  expect(strip(lines[1] as string)).toContain('新的想法，从这里开始')
  expect(strip(lines[2] as string)).toContain('local-dev · standard')
  expect(strip(lines[3] as string)).toContain('● deepseek-v4-pro')
  expect(strip(lines[3] as string)).toContain('输入 / 查看命令')
  expect(lines[4]).toContain('╰')
  // Before the opening projection arrives, the card reports resolution in progress rather than
  // claiming the session has no model. Projection truth then replaces that temporary copy.
  const noModel = new WelcomeBanner({
    profile: 'local-dev',
    preset: 'standard',
    branding: BRANDING,
    ansi: createAnsi('none'),
  })
  const narrowed = noModel.render(50)
  expect(strip(narrowed[2] as string)).toContain('local-dev · standard')
  expect(strip(narrowed[3] as string)).toContain('正在解析模型')
  noModel.setModel('kimi-for-coding-highspeed')
  expect(strip(noModel.render(50)[3] as string)).toContain('kimi-for-coding-highspeed')
  expect(strip(noModel.render(50)[3] as string)).not.toContain('正在解析模型')
})

it('uses the website violet for the brand and dims supporting copy, none tier stays plain', () => {
  const banner = new WelcomeBanner({ profile: 'p', preset: 's', branding: BRANDING, ansi: createAnsi('256') })
  const lines = banner.render(40)
  expect(lines[0]).toContain('\x1b[38;5;63m')
  expect(lines[0]).toContain('\x1b[1m')
  expect(lines[1]).toContain('\x1b[1m')
  expect(lines[2]).toContain('\x1b[2m')
  expect(lines[3]).toContain('\x1b[38;5;78m')
  const plain = new WelcomeBanner({ profile: 'p', preset: 's', branding: BRANDING, ansi: createAnsi('none') })
  expect(plain.render(40).join('\n')).not.toContain('\x1b')
})

it('stays within the given width at narrow and wide sizes', () => {
  const banner = new WelcomeBanner({
    profile: 'local-dev',
    preset: 'standard',
    branding: BRANDING,
    ansi: createAnsi('256'),
  })
  for (const width of [1, 2, 10, 30, 50, 120])
    expect(banner.render(width).every((line) => displayWidth(line) <= width)).toBe(true)
})

it('renders a supplied branding contract instead of a local product-name source', () => {
  const banner = new WelcomeBanner({
    profile: 'p',
    preset: 's',
    branding: { accent: '#00875A', mark: 'acme', selfLabel: 'Acme Workbench' },
    ansi: createAnsi('none'),
  })
  expect(banner.render(80).join('\n')).toContain('Acme Workbench')
  expect(banner.render(80).join('\n')).toContain('p · s')
  expect(banner.render(80).join('\n')).not.toContain('Agnes AI')
})
