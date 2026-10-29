import type { UsageView } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { ANSI_RE, createAnsi } from '../src/tui/ansi.js'
import {
  contextPressure,
  formatContextUsage,
  formatCredits,
  formatTokenCount,
  formatTokenCountShort,
  formatTurnSummary,
  formatUsageLine,
  formatUsdApprox,
  formatUsdMicros,
} from '../src/tui/format-usage.js'
import { displayWidth } from '../src/tui/terminal.js'
import { TuiTheme } from '../src/tui/theme.js'

const PLAIN = new TuiTheme('mono').ansi(createAnsi('none'))

const usage = (overrides: Partial<UsageView> = {}): UsageView => ({
  totals: { input: 1_600, output: 58, cacheRead: 20, cacheWrite: 0, reasoning: 12 },
  cost: { usdMicros: 1_000, source: 'gateway', subscription: true },
  context: { tokens: 2_000, window: 1_000_000, autoCompact: true },
  model: { route: 'agnes-subscription', id: 'deepseek-v4-pro', thinking: 'high' },
  ...overrides,
})

describe('usage number formatting', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1_000, '1.0k'],
    [1_600, '1.6k'],
    [999_949, '999.9k'],
    [999_950, '1.0M'],
    [999_999, '1.0M'],
    [1_000_000, '1.0M'],
    [999_949_999, '999.9M'],
    [999_999_999, '1.0G'],
  ])('formats %d tokens as %s using deterministic SI units', (tokens, expected) => {
    expect(formatTokenCount(tokens)).toBe(expected)
  })

  it.each([
    [0, '$0.000'],
    [1, '$0.000001'],
    [1_000, '$0.001'],
    [1_234, '$0.001234'],
    [1_234_000, '$1.234'],
    [1_234_500, '$1.2345'],
    [1_234_567, '$1.234567'],
  ])('formats %d integer micros as %s without floating-point accumulation', (micros, expected) => {
    expect(formatUsdMicros(micros)).toBe(expected)
  })

  it.each([
    [0, '0'],
    [999, '999'],
    [1_000, '1k'],
    [1_600, '1.6k'],
    [200_000, '200k'],
    [999_999, '1M'],
    [1_000_000, '1M'],
    [999_999_999, '1G'],
    [1_200_000, '1.2M'],
  ])('formats %d tokens as %s without a trailing .0', (tokens, expected) => {
    expect(formatTokenCountShort(tokens)).toBe(expected)
  })

  it.each([
    [0, '$0'],
    [1, '$0.000001'],
    [42, '$0.000042'],
    [1_000, '$0.001'],
    [5_291, '$0.0053'],
    [999_999, '$1.00'],
    [1_000_000, '$1.00'],
    [1_234_567, '$1.23'],
    [18_427_310, '$18.43'],
  ])('formats %d micros as the rounded approximation %s', (micros, expected) => {
    expect(formatUsdApprox(micros)).toBe(expected)
  })

  it('formats context without clamping and freezes strict 70/90 percent boundaries', () => {
    expect(formatContextUsage({ tokens: 0, window: 1_000 })).toBe('0.0%/1.0k')
    expect(formatContextUsage({ tokens: 2_000, window: 1_000_000 })).toBe('0.2%/1.0M')
    expect(formatContextUsage({ tokens: 1_100, window: 1_000 })).toBe('110.0%/1.0k')

    expect(contextPressure({ tokens: 0, window: 100 })).toBe('normal')
    expect(contextPressure({ tokens: 70, window: 100 })).toBe('normal')
    expect(contextPressure({ tokens: 701, window: 1_000 })).toBe('warning')
    expect(contextPressure({ tokens: 90, window: 100 })).toBe('warning')
    expect(contextPressure({ tokens: 901, window: 1_000 })).toBe('error')
    expect(contextPressure({ tokens: 100, window: 100 })).toBe('error')
  })

  it('rejects values outside the protocol numeric domain', () => {
    for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => formatTokenCount(invalid)).toThrow(/token/i)
      expect(() => formatUsdMicros(invalid)).toThrow(/micros/i)
      expect(() => formatUsdApprox(invalid)).toThrow(/micros/i)
    }
    expect(() => formatContextUsage({ tokens: 1, window: 0 })).toThrow(/window/i)
  })
})

// The production call: no model on the line, and the context gauge only below the rail's floor.
const production = (u: UsageView, width: number, locale = 'en', ansi = PLAIN) =>
  formatUsageLine(u, width, ansi, false, width < 40, locale)

const aligned = (left: string, right: string, width: number) =>
  `${left}${' '.repeat(width - displayWidth(left) - displayWidth(right))}${right}`

describe('usage footer degradation', () => {
  const MODEL = 'deepseek-v4-pro'

  it('freezes the full-width footer text in English and Chinese', () => {
    expect(formatUsageLine(usage(), 120, PLAIN)).toBe(
      aligned('Session total  in 1.6k · out 58 · cost $0.001 ctx ~0.2%/1M (auto)', `${MODEL} • high`, 120),
    )
    expect(formatUsageLine(usage(), 120, PLAIN, true, true, 'zh-CN')).toBe(
      aligned(
        '本会话累计  输入 1.6k · 输出 58 · 费用 $0.001 上下文 约 0.2%/1M (auto)',
        `${MODEL} • high`,
        120,
      ),
    )
  })

  it('has exact 120/80/59/40/20-column footers per tier with the model shown', () => {
    const lines = [120, 80, 59, 40, 20].map((width) => formatUsageLine(usage(), width, PLAIN))
    expect(lines).toEqual([
      aligned('Session total  in 1.6k · out 58 · cost $0.001 ctx ~0.2%/1M (auto)', `${MODEL} • high`, 120),
      aligned('session  in 1.6k · out 58 · $0.001 ctx ~0.2%/1M', MODEL, 80),
      aligned('in 1.6k  out 58  $0.001', MODEL, 59),
      aligned('in 1.6k  out 58  $0.001', MODEL, 40),
      aligned('', MODEL, 20),
    ])
    const zh = [120, 80, 59, 40, 20].map((width) =>
      formatUsageLine(usage(), width, PLAIN, true, true, 'zh-CN'),
    )
    expect(zh[1]).toBe(aligned('会话  输入 1.6k · 输出 58 · $0.001 上下文 约 0.2%/1M', MODEL, 80))
    expect(zh[2]).toBe(aligned('入 1.6k  出 58  $0.001', MODEL, 59))
    expect(zh[3]).toBe(aligned('入 1.6k  出 58  $0.001', MODEL, 40))
  })

  it.each([
    ['en', 120, 'Session total  in 1.6k · out 58 · cost $0.001'],
    ['en', 80, 'session  in 1.6k · out 58 · $0.001'],
    ['en', 59, 'in 1.6k  out 58  $0.001'],
    ['en', 40, 'in 1.6k  out 58  $0.001'],
    ['en', 39, 'ctx ~0.2%/1M'],
    ['en', 20, 'ctx ~0.2%/1M'],
    ['zh-CN', 120, '本会话累计  输入 1.6k · 输出 58 · 费用 $0.001'],
    ['zh-CN', 80, '会话  输入 1.6k · 输出 58 · $0.001'],
    ['zh-CN', 59, '入 1.6k  出 58  $0.001'],
    ['zh-CN', 40, '入 1.6k  出 58  $0.001'],
    ['zh-CN', 39, '上下文 约 0.2%/1M'],
    ['zh-CN', 20, '上下文 约 0.2%/1M'],
  ])('renders the production footer for %s at %d columns', (locale, width, text) => {
    const line = production(usage(), width, locale)
    expect(line).toBe(`${text}${' '.repeat(width - displayWidth(text))}`)
  })

  it('falls back to English for an unknown locale', () => {
    expect(production(usage(), 120, 'xx').trim()).toBe('Session total  in 1.6k · out 58 · cost $0.001')
  })

  it('colours the footer without changing its text at any width', () => {
    const ansi = new TuiTheme('light').ansi(createAnsi('truecolor'))
    for (const locale of ['en', 'zh-CN'])
      for (const width of [120, 80, 59, 40, 20])
        expect(formatUsageLine(usage(), width, ansi, true, true, locale).replace(ANSI_RE, '')).toBe(
          formatUsageLine(usage(), width, PLAIN, true, true, locale),
        )
    const line = production(usage({ billingComplete: false }), 120, 'en', ansi)
    for (const part of [
      ansi.fg('muted', 'Session total'),
      `${ansi.fg('muted', 'in')} ${ansi.fg('fg', '1.6k')}`,
      `${ansi.fg('muted', 'out')} ${ansi.fg('fg', '58')}`,
      `${ansi.fg('muted', 'cost')} ${ansi.fg('fg', '$0.001')}`,
      ansi.fg('faint', ' · '),
      ansi.fg('warning', ' (partial)'),
    ])
      expect(line).toContain(part)
    expect(production(usage({ billingComplete: false }), 60, 'en', ansi)).toContain(ansi.fg('warning', '+'))
    const gauge = production(usage(), 39, 'en', ansi)
    expect(gauge).toContain(`${ansi.fg('muted', 'ctx')} ${ansi.fg('fg', '~0.2%/1M')}`)
  })

  const base = usage({
    totals: { input: 10_800, output: 1_100, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    cost: { usdMicros: 5_291, source: 'estimated', subscription: false },
  })
  const { cost: _unusedCost, ...baseNoCost } = base
  const states: [string, UsageView, string, string][] = [
    [
      'estimated',
      base,
      '本会话累计  输入 10.8k · 输出 1.1k · 费用 约 $0.0053',
      '会话  输入 10.8k · 输出 1.1k · 约 $0.0053',
    ],
    [
      'gateway',
      { ...base, cost: { usdMicros: 5_291, source: 'gateway', subscription: false } },
      '本会话累计  输入 10.8k · 输出 1.1k · 费用 $0.005291',
      '会话  输入 10.8k · 输出 1.1k · $0.005291',
    ],
    ['no cost', baseNoCost, '本会话累计  输入 10.8k · 输出 1.1k', '会话  输入 10.8k · 输出 1.1k'],
    [
      'billing incomplete',
      { ...base, billingComplete: false },
      '本会话累计  输入 10.8k · 输出 1.1k · 费用 约 $0.0053（部分缺失）',
      '会话  输入 10.8k · 输出 1.1k · 约 $0.0053+',
    ],
    [
      'billing complete',
      { ...base, billingComplete: true },
      '本会话累计  输入 10.8k · 输出 1.1k · 费用 约 $0.0053',
      '会话  输入 10.8k · 输出 1.1k · 约 $0.0053',
    ],
    [
      'large',
      {
        ...base,
        totals: { ...base.totals, input: 1_234_567, output: 999_999 },
        cost: { usdMicros: 18_427_310, source: 'estimated', subscription: false },
      },
      '本会话累计  输入 1.2M · 输出 1M · 费用 约 $18.43',
      '会话  输入 1.2M · 输出 1M · 约 $18.43',
    ],
    [
      'tiny',
      {
        ...base,
        totals: { ...base.totals, input: 312, output: 48 },
        cost: { usdMicros: 42, source: 'estimated', subscription: false },
      },
      '本会话累计  输入 312 · 输出 48 · 费用 约 $0.000042',
      '会话  输入 312 · 输出 48 · 约 $0.000042',
    ],
  ]
  it.each(states)('renders the %s state at 120 and 60 columns in zh-CN', (_name, view, at120, at60) => {
    expect(production(view, 120, 'zh-CN').trimEnd()).toBe(at120)
    expect(production(view, 60, 'zh-CN').trimEnd()).toBe(at60)
  })

  it('marks partial billing and the estimate prefix in every tier in English', () => {
    const view = { ...base, billingComplete: false }
    expect(production(view, 120).trimEnd()).toBe(
      'Session total  in 10.8k · out 1.1k · cost ~$0.0053 (partial)',
    )
    expect(production(view, 60).trimEnd()).toBe('session  in 10.8k · out 1.1k · ~$0.0053+')
    expect(production(view, 50).trimEnd()).toBe('in 10.8k  out 1.1k  ~$0.0053+')
    expect(production(view, 50, 'zh-CN').trimEnd()).toBe('入 10.8k  出 1.1k  约$0.0053+')
  })

  it('keeps the worst case inside each tier floor without truncating', () => {
    const worst = usage({
      totals: { input: 999_999, output: 999_999, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      cost: { usdMicros: 1_234_567_891, source: 'gateway', subscription: false },
      billingComplete: false,
    })
    for (const locale of ['en', 'zh-CN'])
      for (const floor of [100, 60, 40]) {
        const line = production(worst, floor, locale)
        expect(line).not.toContain('…')
        expect(displayWidth(line.trimEnd())).toBeLessThanOrEqual(floor)
        expect(line).toContain('$1234.567891')
      }
  })

  it('shows the context gauge in the lowest tier and escalates it by pressure', () => {
    const ansi = new TuiTheme('dark').ansi(createAnsi('16'))
    const cases = [
      [{ tokens: 70, window: 100, autoCompact: false }, ansi.fg('fg', '~70.0%/100')],
      [{ tokens: 701, window: 1_000, autoCompact: false }, ansi.fg('warning', '~70.1%/1k')],
      [{ tokens: 90, window: 100, autoCompact: false }, ansi.fg('warning', '~90.0%/100')],
      [{ tokens: 901, window: 1_000, autoCompact: false }, ansi.fg('danger', '~90.1%/1k')],
    ] as const
    for (const [context, marker] of cases) {
      const line = production(usage({ context }), 36, 'en', ansi)
      expect(line).toContain(marker)
      expect(line.replace(ANSI_RE, '')).not.toContain('\u001b')
      expect(displayWidth(line)).toBe(36)
    }
  })

  it('omits the dollar segment entirely when billing is absent', () => {
    const { cost: _cost, ...withoutCost } = usage()
    const line = formatUsageLine(withoutCost, 120, PLAIN)
    expect(line).not.toContain('$')
    expect(line).toContain('in 1.6k · out 58 ctx')
    expect(line).not.toContain('cost')
  })

  it('clips hostile labels by display width and leaves no live controls or ANSI fragments', () => {
    const hostile = usage({
      model: {
        route: 'agnes-subscription',
        id: `前缀\n\u2028\u001b[31m${'很长'.repeat(40)}\u0000尾`,
        thinking: 'high',
      },
    })
    for (const width of [120, 80, 59, 40, 20, 1, 0]) {
      const line = formatUsageLine(hostile, width, new TuiTheme('dark').ansi(createAnsi('256')))
      expect(displayWidth(line)).toBe(Math.max(1, width))
      for (const control of ['\n', '\r', '\u0000', '\u2028', '\u2029']) expect(line).not.toContain(control)
      expect(line.replace(ANSI_RE, '')).not.toContain('\u001b')
    }
  })
})

describe('formatCredits', () => {
  it('rounds a fractional amount to at most two decimal places, dropping trailing zeroes', () => {
    expect(formatCredits(0.02808099999999999)).toBe('0.03')
    expect(formatCredits(4_000)).toBe('4000')
    expect(formatCredits(0)).toBe('0')
  })

  it('rejects a negative or non-finite amount', () => {
    expect(() => formatCredits(-1)).toThrow(/non-negative/)
    expect(() => formatCredits(Number.NaN)).toThrow(/non-negative/)
  })
})

describe('formatTurnSummary', () => {
  it('renders the turn number and elapsed seconds to one decimal place', () => {
    expect(formatTurnSummary(3, 42_100)).toBe('turn 3 · 42.1s')
    expect(formatTurnSummary(1, 702)).toBe('turn 1 · 0.7s')
  })

  it('rejects a negative or non-finite elapsed time rather than printing garbage', () => {
    expect(() => formatTurnSummary(1, -1)).toThrow(/non-negative/)
    expect(() => formatTurnSummary(1, Number.NaN)).toThrow(/non-negative/)
  })
})
