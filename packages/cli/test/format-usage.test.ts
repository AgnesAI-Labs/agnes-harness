import type { UsageView } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { ANSI_RE, createAnsi } from '../src/tui/ansi.js'
import {
  contextPressure,
  formatContextUsage,
  formatCredits,
  formatTokenCount,
  formatTurnSummary,
  formatUsageLine,
  formatUsdMicros,
} from '../src/tui/format-usage.js'
import { displayWidth } from '../src/tui/terminal.js'

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
    [999_999, '1000.0k'],
    [1_000_000, '1.0M'],
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
    }
    expect(() => formatContextUsage({ tokens: 1, window: 0 })).toThrow(/window/i)
  })
})

describe('usage footer degradation', () => {
  // The design's sample text is exactly 80 cells although the explicit tier table says full detail
  // starts at >=100. Task-owner ruling: the tier table wins; the sample freezes the full line's two
  // content groups, while the 120-column snapshot below freezes their actual right alignment.
  it('preserves the canonical full footer content at the full-width tier', () => {
    const line = formatUsageLine(usage(), 120, createAnsi('none'))
    expect(line.startsWith('Σ ↑1.6k ↓58 $0.001 ≈0.2%/1.0M (auto)')).toBe(true)
    expect(line.endsWith('deepseek-v4-pro • high')).toBe(true)
  })

  it('has exact 120/80/59/40/20-column snapshots', () => {
    const rendered = [120, 80, 59, 40, 20].map((width) =>
      formatUsageLine(usage(), width, createAnsi('none')).replaceAll(' ', '·'),
    )
    expect(rendered).toMatchInlineSnapshot(`
      [
        "Σ·↑1.6k·↓58·$0.001·≈0.2%/1.0M·(auto)······························································deepseek-v4-pro·•·high",
        "Σ·↑1.6k·↓58·≈0.2%/1.0M···········································deepseek-v4-pro",
        "≈0.2%/1.0M··································deepseek-v4-pro",
        "≈0.2%/1.0M···············deepseek-v4-pro",
        "·····deepseek-v4-pro",
      ]
    `)
  })

  it('omits the dollar segment entirely when billing is absent', () => {
    const { cost: _cost, ...withoutCost } = usage()
    const line = formatUsageLine(withoutCost, 120, createAnsi('none'))
    expect(line).not.toContain('$')
    expect(line).toContain('↑1.6k ↓58')
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
      const line = formatUsageLine(hostile, width, createAnsi('256'))
      expect(displayWidth(line)).toBe(Math.max(1, width))
      for (const control of ['\n', '\r', '\u0000', '\u2028', '\u2029']) expect(line).not.toContain(control)
      expect(line.replace(ANSI_RE, '')).not.toContain('\u001b')
    }
  })

  it('styles exact 70/90 boundaries without leaving an unterminated SGR sequence', () => {
    const cases = [
      [{ tokens: 70, window: 100, autoCompact: false }, '\u001b[2m≈70.0%/100\u001b[22m'],
      [{ tokens: 701, window: 1_000, autoCompact: false }, '\u001b[93m≈70.1%/1.0k\u001b[39m'],
      [{ tokens: 90, window: 100, autoCompact: false }, '\u001b[93m≈90.0%/100\u001b[39m'],
      [{ tokens: 901, window: 1_000, autoCompact: false }, '\u001b[91m≈90.1%/1.0k\u001b[39m'],
    ] as const
    for (const [context, marker] of cases) {
      const line = formatUsageLine(usage({ context }), 120, createAnsi('16'))
      expect(line).toContain(marker)
      expect(line.replace(ANSI_RE, '')).not.toContain('\u001b')
      expect(displayWidth(line)).toBe(120)
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
