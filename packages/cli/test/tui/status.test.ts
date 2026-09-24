import { describe, expect, it } from 'vitest'
import { createAnsi } from '../../src/tui/ansi.js'
import { displayWidth } from '../../src/tui/terminal.js'
import { Header, StatusBar } from '../../src/tui/views/status-bar.js'

const BRANDING = { accent: '#5E57FE', mark: 'agnes', selfLabel: 'Agnes AI' }

describe('status bar and header (cli 稿 §9.2)', () => {
  it('composes slot lines, budget, parked and link state', () => {
    const s = new StatusBar(createAnsi('none'))
    s.setSlots([{ text: '数据截至 9/6', level: 'warn' }])
    s.setBudget(78, 100)
    s.setParked('tk-abcdefgh')
    s.setLink('reconnecting')
    const line = s.render(80)[0] as string
    expect(line).toContain('[warn] 数据截至 9/6')
    expect(line).toContain('credits 78/100 · 78%')
    expect(line).toContain('parked tk-abcde')
    expect(line).toContain('reconnecting')
    // Reverse-verification: clearing a field must remove its fragment from the render, not just
    // stop adding new content on top of it.
    s.setLink('ok')
    s.setParked(undefined)
    const cleared = s.render(80)[0] as string
    expect(cleared).not.toContain('parked')
    expect(cleared).not.toContain('reconnecting')
    expect(cleared).toContain('credits 78/100 · 78%')
  })

  it('renders the projected usage as a separate Pi-style footer and clears it', () => {
    const s = new StatusBar(createAnsi('none'))
    s.setUsage({
      totals: { input: 1_600, output: 58, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      cost: { usdMicros: 1_000, source: 'estimated', subscription: false },
      context: { tokens: 2_000, window: 1_000_000, autoCompact: true },
      model: { route: 'deepseek', id: 'deepseek-v4-pro', thinking: 'high' },
    })
    const lines = s.render(100)
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('Σ ↑1.6k ↓58 ≈$0.001 ≈0.2%/1.0M (auto)')
    expect(lines[1]).not.toContain('deepseek-v4-pro')
    s.setUsage(undefined)
    expect(s.render(100)).toHaveLength(1)
  })

  it('header shows brand, profile, preset, session tail, generation and op state', () => {
    const h = new Header(createAnsi('none'), BRANDING)
    h.set({
      profile: 'local-dev',
      preset: 'standard',
      sessionId: 'agnes:x:y:cli:dm:12345678',
      generation: 2,
      opState: { turn: 3, step: 2, phase: 'tools' },
    })
    expect(h.render(80)[0]).toBe(
      'agnes · local-dev · standard · 12345678 · g2 · turn 3 step 2 tools'.padEnd(80),
    )
  })

  it('header paints the brand in the accent colour and dims the separators on a colour tier', () => {
    const h = new Header(createAnsi('256'), BRANDING)
    h.set({ profile: 'local-dev', preset: 'standard', sessionId: 'agnes:x:y:cli:dm:12345678', generation: 1 })
    const line = h.render(60)[0] as string
    expect(line).toContain('\x1b[1m\x1b[38;5;63magnes\x1b[39m\x1b[22m')
    expect(line).toContain('\x1b[2m · \x1b[22m')
    expect(line).not.toContain('\x1b[2m · \x1b[22m\x1b[2m')
    // The none tier must emit zero escape sequences for the very same content.
    const plain = new Header(createAnsi('none'), BRANDING)
    plain.set({ profile: 'p', preset: 's', sessionId: 'id:12345678', generation: 1 })
    expect(plain.render(60)[0]).not.toContain('\x1b')
  })

  it('takes the compact mark and accent from the shared branding contract', () => {
    const h = new Header(createAnsi('none'), {
      accent: '#00875A',
      mark: 'acme',
      selfLabel: 'Acme Workbench',
    })
    h.set({ profile: 'p', preset: 's', sessionId: 'id:12345678', generation: 1 })
    expect(h.render(60)[0]).toContain('acme · p · s')
    expect(h.render(60)[0]).not.toContain('agnes')
  })

  it('status bar colors the budget segment, the notice and the link spinner', () => {
    const s = new StatusBar(createAnsi('256'))
    s.setBudget(92, 100)
    s.setNotice('执行中断，30 s 内自动恢复', 'error')
    s.setLink('reconnecting')
    const line = s.render(100)[0] as string
    expect(line).toContain('\x1b[38;5;196mcredits 92/100 · 92% ⚠\x1b[39m')
    expect(line).toContain('\x1b[38;5;203m执行中断，30 s 内自动恢复\x1b[39m')
    expect(line).toContain('\x1b[38;5;178m⟳\x1b[39m')
    s.setNotice('模型已切换', 'success')
    expect(s.render(100)[0]).toContain('\x1b[38;5;78m模型已切换\x1b[39m')
    s.setNotice('普通提示')
    expect(s.render(100)[0]).toContain('\x1b[2m普通提示\x1b[22m')
    // The link glyph only lights up while the link is not ok.
    s.setLink('ok')
    expect(s.render(100)[0]).not.toContain('⟳')
    // none tier: identical text, zero escapes.
    const plain = new StatusBar(createAnsi('none'))
    plain.setBudget(92, 100)
    plain.setNotice('n')
    plain.setLink('catching-up')
    const plainLine = plain.render(100)[0] as string
    expect(plainLine).not.toContain('\x1b')
    expect(plainLine).toContain('credits 92/100 · 92% ⚠ · n · ⟳ catching up')
  })

  it('localizes fixed parked and link-state copy without changing slot content', () => {
    const s = new StatusBar(createAnsi('none'), 'zh-CN')
    s.setSlots([{ text: 'source-owned', level: 'info' }])
    s.setParked('tk-abcdefgh')
    s.setLink('catching-up')
    const line = s.render(80)[0] as string
    expect(line).toContain('[info] source-owned')
    expect(line).toContain('挂起 tk-abcde…')
    expect(line).toContain('⟳ 追赶中')
  })

  it('bounds header and status chrome to one row at narrow terminal widths', () => {
    const status = new StatusBar(createAnsi('none'), 'zh-CN')
    status.setSlots([{ text: '一条很长的状态文本', level: 'warn' }])
    status.setBudget(5, 100)
    status.setParked('tk-abcdefgh')
    status.setLink('reconnecting')
    const header = new Header(createAnsi('none'), BRANDING)
    header.set({
      profile: 'local-development-profile',
      preset: 'standard',
      sessionId: 'agnes:x:y:cli:dm:12345678',
      generation: 2,
    })

    for (const width of [1, 2, 10, 20, 40]) {
      for (const component of [status, header]) {
        const lines = component.render(width)
        expect(lines).toHaveLength(1)
        expect(displayWidth(lines[0] as string)).toBeLessThanOrEqual(width)
      }
    }
  })

  it('hides the credits segment below the 70% warning threshold, however large the raw numbers', () => {
    const s = new StatusBar(createAnsi('none'))
    s.setBudget(50, 100)
    expect(s.render(80)[0]).not.toContain('credits')
  })

  it('never shows credits without a hard cap, however large the accumulated amount', () => {
    const s = new StatusBar(createAnsi('none'))
    s.setBudget(999_999.999, undefined)
    expect(s.render(80)[0]).not.toContain('credits')
  })

  it('renders a fractional credits amount rounded, never the raw float', () => {
    const s = new StatusBar(createAnsi('none'))
    s.setBudget(0.02808099999999999, 0.04)
    expect(s.render(80)[0]).toContain('credits 0.03/0.04 · 70%')
    expect(s.render(80)[0]).not.toContain('028080')
  })
})
