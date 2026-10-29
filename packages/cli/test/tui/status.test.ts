import { describe, expect, it } from 'vitest'
import { ANSI_RE, createAnsi } from '../../src/tui/ansi.js'
import { Loader } from '../../src/tui/components/loader.js'
import { displayWidth } from '../../src/tui/terminal.js'
import { TuiTheme } from '../../src/tui/theme.js'
import { Hints } from '../../src/tui/views/hints.js'
import { StatusBar } from '../../src/tui/views/status-bar.js'

const _BRANDING = { accent: '#5E57FE', mark: 'agnes', selfLabel: 'Agnes AI' }
const PLAIN = new TuiTheme('mono').ansi(createAnsi('none'))

describe('status bar and header (cli 稿 §9.2)', () => {
  it.each([
    ['error', '✗ '],
    ['warning', '▲ '],
    ['success', '✓ '],
    ['info', ''],
  ] as const)('marks a %s notice with "%s"', (tone, mark) => {
    const s = new StatusBar(PLAIN)
    s.setNotice('something happened', tone)
    expect((s.render(80)[0] as string).startsWith(`${mark}something happened`)).toBe(true)
  })

  it('composes slot lines, budget, parked and link state', () => {
    const s = new StatusBar(PLAIN)
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
    // The safe-mode marker stays for the whole run.
    expect(cleared).not.toContain('safe mode')
    expect(new StatusBar(PLAIN, 'en', true).render(80)[0]).toContain('safe mode')
  })

  it('shows the preset, and a loud full-access marker only while yolo is on', () => {
    const s = new StatusBar(PLAIN)
    expect(s.render(80)[0]).not.toContain('preset')
    expect(new StatusBar(PLAIN, 'en', false, '(default)').render(80)[0]).not.toContain('preset')
    s.setPreset('strict')
    expect(s.render(80)[0]).toContain('preset strict')
    s.setUsage(undefined, true)
    const line = s.render(80)[0] as string
    expect(line).toContain('⚠ full access')
    expect(line).not.toContain('preset strict')
    s.setUsage(undefined)
    expect(s.render(80)[0]).toContain('preset strict')
    const zh = new StatusBar(PLAIN, 'zh-CN')
    zh.setUsage(undefined, true)
    expect(zh.render(80)[0]).toContain('完全访问')
  })

  it('renders the projected usage as a separate Pi-style footer and clears it', () => {
    const s = new StatusBar(PLAIN)
    s.setUsage({
      totals: { input: 1_600, output: 58, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      cost: { usdMicros: 1_000, source: 'estimated', subscription: false },
      context: { tokens: 2_000, window: 1_000_000, autoCompact: true },
      model: { route: 'deepseek', id: 'deepseek-v4-pro', thinking: 'high' },
    })
    const lines = s.render(100)
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('Session total  in 1.6k · out 58 · cost ~$0.001')
    expect(lines[1]).not.toContain('deepseek-v4-pro')
    // The composer rail carries the context gauge; below its floor the footer takes it back.
    expect(lines[1]).not.toContain('0.2%')
    expect(lines[1]).not.toContain('(auto)')
    // From 40 columns the compact usage row sits under the status line, labelled in words.
    const compact = s.render(50)
    expect(compact).toHaveLength(2)
    expect(compact[1]?.trimEnd()).toBe('in 1.6k  out 58  ~$0.001')
    expect(s.render(39)[1]).toContain('ctx ~0.2%/1M')
    s.setUsage(undefined)
    expect(s.render(100)).toHaveLength(1)
  })

  it('status bar colors slot levels, the budget segment, the notice and the link state', () => {
    const ansi = new TuiTheme('dark').ansi(createAnsi('256'))
    const s = new StatusBar(ansi)
    s.setBudget(92, 100)
    s.setNotice('执行中断，30 s 内自动恢复', 'error')
    s.setLink('reconnecting')
    const line = s.render(100)[0] as string
    expect(line).toContain(ansi.bold(ansi.fg('danger', 'credits 92/100 · 92% ⚠')))
    expect(line).toContain(ansi.fg('danger', '执行中断，30 s 内自动恢复'))
    expect(line).toContain(ansi.fg('warning', '⟳ reconnecting'))
    expect(line).toContain(ansi.fg('faint', ' · '))
    s.setNotice(
      'The operation was refused. Review the candidate and request a new approval before retrying.',
      'error',
    )
    const narrow = s
      .render(40)
      .map((line) => line.replace(ANSI_RE, ''))
      .join(' ')
      .replace(/\s+/g, ' ')
    expect(s.render(40).every((line) => displayWidth(line) <= 40)).toBe(true)
    expect(narrow).toContain(
      'The operation was refused. Review the candidate and request a new approval before retrying.',
    )
    s.setNotice('模型已切换', 'success')
    expect(s.render(100)[0]).toContain(ansi.fg('success', '模型已切换'))
    s.setNotice('普通提示')
    expect(s.render(100)[0]).toContain(ansi.fg('info', '普通提示'))
    s.setSlots([{ text: '数据截至 9/6', level: 'warn' }])
    expect(s.render(100)[0]).toContain(`${ansi.fg('warning', '[warn]')} ${ansi.dim('数据截至 9/6')}`)
    // The link glyph only lights up while the link is not ok.
    s.setLink('ok')
    expect(s.render(100)[0]).not.toContain('⟳')
    // none tier: identical text, zero escapes.
    const plain = new StatusBar(PLAIN)
    plain.setBudget(92, 100)
    plain.setNotice('n')
    plain.setLink('catching-up')
    const plainLine = plain.render(100)[0] as string
    expect(plainLine).not.toContain('\x1b')
    expect(plainLine).toContain('credits 92/100 · 92% ⚠ · n · ⟳ catching up')
  })

  it('localizes fixed parked and link-state copy without changing slot content', () => {
    const s = new StatusBar(PLAIN, 'zh-CN')
    s.setSlots([{ text: 'source-owned', level: 'info' }])
    s.setParked('tk-abcdefgh')
    s.setLink('catching-up')
    const line = s.render(80)[0] as string
    expect(line).toContain('[info] source-owned')
    expect(line).toContain('挂起 tk-abcde…')
    expect(line).toContain('⟳ 追赶中')
  })

  it('bounds status chrome to one row at narrow terminal widths', () => {
    const status = new StatusBar(PLAIN, 'zh-CN')
    status.setSlots([{ text: '一条很长的状态文本', level: 'warn' }])
    status.setBudget(5, 100)
    status.setParked('tk-abcdefgh')
    status.setLink('reconnecting')

    for (const width of [1, 2, 10, 20, 40]) {
      for (const component of [status]) {
        const lines = component.render(width)
        expect(lines).toHaveLength(1)
        expect(displayWidth(lines[0] as string)).toBeLessThanOrEqual(width)
      }
    }
  })

  it('hides the credits segment below the 70% warning threshold, however large the raw numbers', () => {
    const s = new StatusBar(PLAIN)
    s.setBudget(50, 100)
    expect(s.render(80)[0]).not.toContain('credits')
  })

  it('never shows credits without a hard cap, however large the accumulated amount', () => {
    const s = new StatusBar(PLAIN)
    s.setBudget(999_999.999, undefined)
    expect(s.render(80)[0]).not.toContain('credits')
  })

  it('renders a fractional credits amount rounded, never the raw float', () => {
    const s = new StatusBar(PLAIN)
    s.setBudget(0.02808099999999999, 0.04)
    expect(s.render(80)[0]).toContain('credits 0.03/0.04 · 70%')
    expect(s.render(80)[0]).not.toContain('028080')
  })

  it('colours hint keys and the spinner, and freezes on a success check', () => {
    const ansi = new TuiTheme('light').ansi(createAnsi('truecolor'))
    const hints = new Hints(ansi)
    hints.set([
      { id: 'a', label: 'Export' },
      { id: 'b', label: 'Rerun' },
    ])
    const keyed = (key: string, label: string) =>
      `${ansi.bold(ansi.fg('accentSoft', key))} ${ansi.fg('muted', label)}`
    expect(hints.render(60)[0]).toContain(`${keyed('F1', 'Export')}  ${keyed('F2', 'Rerun')}`)
    const loader = new Loader('thinking', ansi)
    expect(loader.render(30)[0]).toContain(`${ansi.fg('accent', '⠋')} ${ansi.dim('thinking')}`)
    loader.stop('turn 1 · 0.7s')
    expect(loader.render(30)[0]).toContain(`${ansi.fg('success', '✓')} ${ansi.fg('faint', 'turn 1 · 0.7s')}`)
    // Mono keeps the same text and leans on weight and dim instead.
    const monoAnsi = new TuiTheme('mono').ansi(createAnsi('256'))
    const mono = new Hints(monoAnsi)
    mono.set([{ id: 'a', label: 'Export' }])
    expect(mono.render(30)[0]).toContain(
      `${monoAnsi.bold(monoAnsi.fg('accentSoft', 'F1'))} ${monoAnsi.fg('muted', 'Export')}`,
    )
  })
  it('shows the way back to the bottom above the F-key row, or alone, only while it is offered', () => {
    let note: string | undefined = '↓ New output below · End to jump back'
    const hints = new Hints(PLAIN, () => note)
    const rows = () => hints.render(60).map((row) => row.trimEnd())
    expect(rows()).toEqual([note])
    hints.set([{ id: 'a', label: 'Export' }])
    expect(rows()).toEqual([note, 'F1 Export'])
    note = undefined
    expect(rows()).toEqual(['F1 Export'])
  })
})

describe('status bar with fields turned off', () => {
  const hide = (...hidden: string[]) => ({ shows: (field: string) => !hidden.includes(field) })
  const bar = (...hidden: string[]) => {
    const s = new StatusBar(PLAIN, 'en', false, 'review', hide(...hidden) as never)
    s.setSlots([{ text: 'extension note', level: 'info' }])
    s.setLink('reconnecting')
    s.setBudget(95, 100)
    s.setParked('tk-abcdefgh')
    s.setNotice('something failed', 'error')
    return s.render(200)[0] as string
  }

  it('drops the fields that were turned off and nothing else', () => {
    const all = bar()
    for (const text of ['extension note', 'reconnecting', 'preset review']) expect(all).toContain(text)
    expect(bar('slots')).not.toContain('extension note')
    expect(bar('link')).not.toContain('reconnecting')
    expect(bar('preset')).not.toContain('preset review')
    expect(bar('slots')).toContain('reconnecting')
  })

  it('never hides the budget warning, a parked approval ticket or an error notice', () => {
    const line = bar('model', 'preset', 'usage', 'cwd', 'branch', 'link', 'slots')
    expect(line).toContain('credits 95/100')
    expect(line).toContain('parked tk-abcde')
    expect(line).toContain('something failed')
  })
})
