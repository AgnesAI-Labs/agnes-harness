import type { UsageView } from '@agnes/protocol'
import type { Ansi } from './ansi.js'
import { displayWidth } from './terminal.js'

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
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`
  return `${(tokens / 1_000_000).toFixed(1)}M`
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
 * RP3: the local wall clock from prompt to yield, tool calls included -- the span an operator
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

function sanitizeLabel(label: string): string {
  return label.replace(UNSAFE_LABEL, '')
}

function clipLabel(label: string, width: number): string {
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

function styledContext(usage: UsageView, ansi: Ansi): string {
  const context = `≈${formatContextUsage(usage.context)}`
  const pressure = contextPressure(usage.context)
  if (pressure === 'error') return ansi.fg(196, context)
  if (pressure === 'warning') return ansi.fg(214, context)
  return ansi.dim(context)
}

/**
 * Produces one terminal-width line. Width tiers are intentionally structural rather than dependent
 * on label length, so a model switch cannot make cost/input fields flicker in and out.
 */
export function formatUsageLine(
  usage: UsageView,
  requestedWidth: number,
  ansi: Ansi,
  showModel = true,
): string {
  if (!Number.isFinite(requestedWidth)) throw new Error('usage footer width must be finite')
  const width = Math.max(1, Math.trunc(requestedWidth))
  const context = styledContext(usage, ansi)
  const model = sanitizeLabel(usage.model.id)

  if (width >= 100) {
    const left = [
      `Σ ↑${formatTokenCount(usage.totals.input)}`,
      `↓${formatTokenCount(usage.totals.output)}`,
      usage.cost === undefined
        ? ''
        : `${usage.cost.source === 'estimated' ? '≈' : ''}${formatUsdMicros(usage.cost.usdMicros)}${usage.billingComplete === false ? '*' : ''}`,
      context,
      usage.context.autoCompact ? '(auto)' : '',
    ]
      .filter(Boolean)
      .join(' ')
    const right = showModel ? `${model} • ${sanitizeLabel(usage.model.thinking)}` : ''
    return alignGroups(left, right, width)
  }

  if (width >= 60) {
    const left = `Σ ↑${formatTokenCount(usage.totals.input)} ↓${formatTokenCount(usage.totals.output)} ${context}`
    return alignGroups(left, showModel ? model : '', width)
  }

  if (width >= 30 || !showModel) return alignGroups(context, showModel ? model : '', width)
  return alignGroups('', model, width)
}
