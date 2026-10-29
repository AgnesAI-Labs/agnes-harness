import type { UsageView } from '@agnes/protocol'
import { type ExtendedKey, tt } from './locale-extended.js'
import { displayWidth } from './terminal.js'
import type { ThemedAnsi } from './theme.js'

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
// Labels have already passed protocol validation, but the renderer remains a trust boundary. This
// also removes bidi/format controls that could make the right-aligned model label misleading.
const UNSAFE_LABEL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

export type ContextPressure = 'normal' | 'warning' | 'error'

function nonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} must be a non-negative safe integer`)
}

export function formatTokenCount(tokens: number): string {
  nonNegativeInteger(tokens, 'token count')
  if (tokens < 1_000) return String(tokens)
  // Round first, then pick the unit, so 999_999 carries to `1.0M` rather than reading `1000.0k`.
  const rounded = (size: number) => Number((tokens / size).toFixed(1))
  if (rounded(1e3) < 1_000) return `${(tokens / 1e3).toFixed(1)}k`
  if (rounded(1e6) < 1_000) return `${(tokens / 1e6).toFixed(1)}M`
  return `${(tokens / 1e9).toFixed(1)}G`
}

/** `formatTokenCount` without the trailing `.0` (`1.0M` -> `1M`), as the composer rail draws it. */
export function formatTokenCountShort(tokens: number): string {
  return formatTokenCount(tokens).replace(/\.0(?=[kMG]$)/, '')
}

/** Renders the exact integer-micro value, trimming only zeroes beyond the required three decimals. */
export function formatUsdMicros(micros: number): string {
  nonNegativeInteger(micros, 'USD micros')
  const whole = Math.floor(micros / 1_000_000)
  let fraction = String(micros % 1_000_000).padStart(6, '0')
  while (fraction.length > 3 && fraction.endsWith('0')) fraction = fraction.slice(0, -1)
  return `$${whole}.${fraction}`
}

/**
 * A rounded estimate for the status line: two significant digits below $1, whole cents from there
 * on. Rounds first and compares after, so 999_999 and 1_000_000 both read `$1.00`. The `/usage`
 * panel keeps the exact `formatUsdMicros` value.
 */
export function formatUsdApprox(micros: number): string {
  nonNegativeInteger(micros, 'USD micros')
  if (micros === 0) return '$0'
  const rounded = Number((micros / 1_000_000).toPrecision(2))
  if (micros < 1_000_000 && rounded < 1) return `$${rounded}`
  const cents = Math.round(micros / 10_000)
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`
}

/**
 * The local wall clock from prompt to yield, tool calls included -- the span an operator
 * actually waited. The provider's own TTFT/duration pair (rendered by `formatCallUsage` in
 * usage-details.ts) does not add up to this by itself: neither field counts tool execution,
 * approval waits, or retry backoff.
 */
export function formatTurnSummary(turn: number, elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0)
    throw new Error('elapsed time must be a non-negative finite number')
  return `turn ${turn} · ${(elapsedMs / 1_000).toFixed(1)}s`
}

export const PRESSURE_WARNING_FRACTION = 0.7
export const PRESSURE_ERROR_FRACTION = 0.9

/**
 * A budget/credit amount is a plain, possibly-fractional `number` (protocol's `BudgetState`), not
 * USD micros -- reusing `formatUsdMicros` here would misread a value like 0.028 as 28 micro-
 * dollars. Rounds to at most two decimal places and drops trailing zeroes, so the raw float noise
 * a user reported (`0.02808099999999999`) reads `0.03`.
 */
export function formatCredits(value: number): string {
  if (!Number.isFinite(value) || value < 0)
    throw new Error('credits amount must be a non-negative finite number')
  return String(Math.round(value * 100) / 100)
}

type ContextUsage = Readonly<{ tokens: number; window: number }>

function checkContext(context: ContextUsage): void {
  nonNegativeInteger(context.tokens, 'context token count')
  if (!Number.isSafeInteger(context.window) || context.window <= 0) {
    throw new Error('context window must be a positive safe integer')
  }
}

export function formatContextUsage(context: ContextUsage): string {
  checkContext(context)
  return `${((context.tokens / context.window) * 100).toFixed(1)}%/${formatTokenCount(context.window)}`
}

export function contextPressure(context: ContextUsage): ContextPressure {
  checkContext(context)
  const fraction = context.tokens / context.window
  if (fraction > PRESSURE_ERROR_FRACTION) return 'error'
  if (fraction > PRESSURE_WARNING_FRACTION) return 'warning'
  return 'normal'
}

export function sanitizeLabel(label: string): string {
  return label.replace(UNSAFE_LABEL, '')
}

/** Clips by display width, ending in `…` when anything was cut. */
export function clipLabel(label: string, width: number): string {
  if (width <= 0) return ''
  if (displayWidth(label) <= width) return label
  if (width === 1) return '…'
  let result = ''
  let used = 0
  for (const { segment } of SEGMENTER.segment(label)) {
    const segmentWidth = displayWidth(segment)
    if (used + segmentWidth > width - 1) break
    result += segment
    used += segmentWidth
  }
  return `${result}…`
}

function alignGroups(left: string, right: string, width: number): string {
  const leftWidth = displayWidth(left)
  if (leftWidth >= width) return clipLabel(left, width).padEnd(width)
  const clippedRight = clipLabel(right, width - leftWidth - (left === '' ? 0 : 1))
  const gap = width - leftWidth - displayWidth(clippedRight)
  return `${left}${' '.repeat(gap)}${clippedRight}`
}

function styledContext(usage: UsageView, ansi: ThemedAnsi, locale: string): string {
  checkContext(usage.context)
  const { tokens, window } = usage.context
  const value = `${tt('usage.line.approx', locale)}${((tokens / window) * 100).toFixed(1)}%/${formatTokenCountShort(window)}`
  const pressure = contextPressure(usage.context)
  const tone = pressure === 'error' ? 'danger' : pressure === 'warning' ? 'warning' : 'fg'
  return `${ansi.fg('muted', tt('usage.line.context', locale))} ${ansi.fg(tone, value)}`
}

/**
 * Produces one terminal-width line. Width tiers are intentionally structural rather than dependent
 * on label length, so a model switch cannot make cost/input fields flicker in and out. The words
 * and the `~` / `+` / `(partial)` marks carry the meaning; colour only emphasises it.
 */
export function formatUsageLine(
  usage: UsageView,
  requestedWidth: number,
  ansi: ThemedAnsi,
  showModel = true,
  /** False where the composer rail already draws the context gauge. */
  showContext = true,
  locale = 'en',
): string {
  if (!Number.isFinite(requestedWidth)) throw new Error('usage footer width must be finite')
  const width = Math.max(1, Math.trunc(requestedWidth))
  const context = showContext ? styledContext(usage, ansi, locale) : ''
  const model = sanitizeLabel(usage.model.id)
  // Only the left group is styled: the right group may be clipped, and clipping counts characters.
  const word = (key: ExtendedKey) => ansi.fg('muted', tt(key, locale))
  const count = (key: ExtendedKey, n: number, gap: string) =>
    `${word(key)}${gap}${ansi.fg('fg', formatTokenCountShort(n))}`
  const dot = ansi.fg('faint', ' · ')
  // Estimates carry the approx mark; a gateway record is exact and carries none.
  const cost = (approx: ExtendedKey, partial: string, label: boolean) => {
    if (usage.cost === undefined) return ''
    const estimated = usage.cost.source === 'estimated'
    const amount = estimated ? formatUsdApprox(usage.cost.usdMicros) : formatUsdMicros(usage.cost.usdMicros)
    const text = `${label ? `${word('usage.line.cost')} ` : ''}${ansi.fg('fg', `${estimated ? tt(approx, locale) : ''}${amount}`)}`
    return usage.billingComplete === false ? `${text}${ansi.fg('warning', partial)}` : text
  }

  if (width >= 100) {
    const left = [
      `${word('usage.line.sessionTotal')}  ${[
        count('usage.line.input', usage.totals.input, ' '),
        count('usage.line.output', usage.totals.output, ' '),
        cost('usage.line.approx', tt('usage.line.partial', locale), true),
      ]
        .filter(Boolean)
        .join(dot)}`,
      context,
      showContext && usage.context.autoCompact ? ansi.fg('faint', '(auto)') : '',
    ]
      .filter(Boolean)
      .join(' ')
    const right = showModel ? `${model} • ${sanitizeLabel(usage.model.thinking)}` : ''
    return alignGroups(left, right, width)
  }

  if (width >= 60) {
    const tokens = `${word('usage.line.session')}  ${[
      count('usage.line.input', usage.totals.input, ' '),
      count('usage.line.output', usage.totals.output, ' '),
      cost('usage.line.approx', '+', false),
    ]
      .filter(Boolean)
      .join(dot)}`
    return alignGroups([tokens, context].filter(Boolean).join(' '), showModel ? model : '', width)
  }

  if (width >= 40)
    return alignGroups(
      [
        count('usage.line.inputShort', usage.totals.input, ' '),
        count('usage.line.outputShort', usage.totals.output, ' '),
        cost('usage.line.approxTight', '+', false),
      ]
        .filter(Boolean)
        .join('  '),
      showModel ? model : '',
      width,
    )

  if (width >= 30 || !showModel) return alignGroups(context, showModel ? model : '', width)
  return alignGroups('', model, width)
}
