import type { UISpan, UITurn, UITurnCall } from '@agnes/protocol'

export type TraceMetric<T> =
  | { readonly state: 'known'; readonly value: T }
  | {
      readonly state: 'unknown'
      readonly reason:
        | 'earlier-history-unloaded'
        | 'request-order-unverifiable'
        | 'tokens-unreported'
        | 'duration-unreported'
        | 'ttft-unreported'
    }

export type TraceTokenMetrics = Readonly<{
  input: TraceMetric<number>
  output: TraceMetric<number>
  cacheRead: TraceMetric<number>
  cacheWrite: TraceMetric<number>
  reasoning: TraceMetric<number>
}>

export type TraceRequestMetrics = Readonly<{
  /** Sequence of the cost/ledger event; this is the exact UISpan.callSeq lookup key. */
  callSeq: number
  purpose: UITurnCall['purpose']
  model: string
  /** Start order across all recorded calls, only when every start is unambiguous and history is complete. */
  requestNumber: TraceMetric<number>
  /** Completion/ledger order; useful even when a request start could not be recovered. */
  ledgerNumber: TraceMetric<number>
  tokens: TraceTokenMetrics
  /** Totals through this ledger event, not an estimate of a concurrent request's start-order prefix. */
  cumulativeTokens: TraceTokenMetrics
  durationMs: TraceMetric<number>
  /** Sum of recorded call durations through this ledger event, not session wall time. */
  cumulativeCallDurationMs: TraceMetric<number>
  ttftMs: TraceMetric<number>
  durationSource: 'ledger' | 'trace' | 'unknown'
  ttftSource: 'ledger' | 'trace' | 'unknown'
}>

export type TraceRequestMetricsOptions = Readonly<{
  /** Must reflect whether any preceding session history is absent from `turns`. */
  hasEarlier: boolean
}>

const known = <T>(value: T): TraceMetric<T> => ({ state: 'known', value })
const unknown = (
  reason: Extract<TraceMetric<never>, { state: 'unknown' }>['reason'],
): TraceMetric<never> => ({
  state: 'unknown',
  reason,
})

const tokenMetrics = (call: UITurnCall): TraceTokenMetrics => {
  const tokens = call.tokens
  if (!tokens) {
    const missing = unknown('tokens-unreported')
    return { input: missing, output: missing, cacheRead: missing, cacheWrite: missing, reasoning: missing }
  }
  return {
    input: known(tokens.input),
    output: known(tokens.output),
    cacheRead: known(tokens.cacheRead),
    cacheWrite: known(tokens.cacheWrite),
    reasoning: tokens.reasoning === undefined ? unknown('tokens-unreported') : known(tokens.reasoning),
  }
}

const sum = (left: TraceMetric<number>, right: TraceMetric<number>): TraceMetric<number> => {
  if (left.state === 'unknown') return left
  if (right.state === 'unknown') return right
  return known(left.value + right.value)
}

const addTokens = (left: TraceTokenMetrics, right: TraceTokenMetrics): TraceTokenMetrics => ({
  input: sum(left.input, right.input),
  output: sum(left.output, right.output),
  cacheRead: sum(left.cacheRead, right.cacheRead),
  cacheWrite: sum(left.cacheWrite, right.cacheWrite),
  reasoning: sum(left.reasoning, right.reasoning),
})

const initialTokens = (hasEarlier: boolean): TraceTokenMetrics => {
  const value = hasEarlier ? unknown('earlier-history-unloaded') : known(0)
  return { input: value, output: value, cacheRead: value, cacheWrite: value, reasoning: value }
}

type CallPlacement = { turnId: string; call: UITurnCall }
type SpanPlacement = { turnId: string; span: UISpan }

function linkedSpan(
  spans: ReadonlyMap<number, readonly SpanPlacement[]>,
  placement: CallPlacement,
): UISpan | undefined {
  const { call, turnId } = placement
  const matches = spans.get(call.seq) ?? []
  const match = matches.length === 1 ? matches[0] : undefined
  const span = match?.turnId === turnId ? match.span : undefined
  if (!span || span.startSeq >= call.seq) return undefined
  if (span.effectId !== undefined && span.effectId !== call.id) return undefined
  if (span.purpose !== undefined && span.purpose !== call.purpose) return undefined
  return span
}

function indexSpans(turns: readonly UITurn[]): Map<number, SpanPlacement[]> {
  const byCallSeq = new Map<number, SpanPlacement[]>()
  const visit = (turnId: string, span: UISpan): void => {
    if (span.callSeq !== undefined) {
      const matches = byCallSeq.get(span.callSeq) ?? []
      matches.push({ turnId, span })
      byCallSeq.set(span.callSeq, matches)
    }
    for (const child of span.children) visit(turnId, child)
  }
  for (const turn of turns) if (turn.trace) visit(turn.id, turn.trace)
  return byCallSeq
}

/**
 * Project recorded model-call facts for the trace inspector. `usage.calls[].seq` is a ledger event,
 * while a matching span's `startSeq` records the effect start. The request number is the order of
 * ledger-backed effect starts. If any ledger call lacks a
 * unique earlier start, this number is unknown rather than inferred from completion order.
 * Adjustments are omitted because they are billing corrections, not additional requests.
 */
export function buildTraceRequestMetrics(
  turns: readonly UITurn[],
  options: TraceRequestMetricsOptions,
): ReadonlyMap<number, TraceRequestMetrics> {
  const calls: CallPlacement[] = turns.flatMap((turn) =>
    turn.usage.calls.filter((call) => !call.adjustment).map((call) => ({ turnId: turn.id, call })),
  )
  calls.sort((left, right) => left.call.seq - right.call.seq)
  // A ledger seq is the lookup key. Duplicate keys cannot be attributed to one inspector row.
  const uniqueCallSeqs = new Set(calls.map(({ call }) => call.seq))
  if (uniqueCallSeqs.size !== calls.length) return new Map()
  const spans = indexSpans(turns)
  const starts = new Map<number, number>()
  for (const placement of calls) {
    const span = linkedSpan(spans, placement)
    if (span) starts.set(placement.call.seq, span.startSeq)
  }
  const uniqueStarts = new Set(starts.values())
  const requestOrderKnown =
    !options.hasEarlier && starts.size === calls.length && uniqueStarts.size === calls.length
  const requestNumberBySeq = new Map<number, number>()
  if (requestOrderKnown) {
    const ordered = [...starts.entries()].sort((left, right) => left[1] - right[1])
    for (const [index, [callSeq]] of ordered.entries()) requestNumberBySeq.set(callSeq, index + 1)
  }

  let cumulativeTokens = initialTokens(options.hasEarlier)
  let cumulativeDuration: TraceMetric<number> = options.hasEarlier
    ? unknown('earlier-history-unloaded')
    : known(0)
  const byCallSeq = new Map<number, TraceRequestMetrics>()
  for (const [index, placement] of calls.entries()) {
    const { call } = placement
    const span = linkedSpan(spans, placement)
    const durationSource =
      call.timing?.durationMs !== undefined ? 'ledger' : span?.durationMs !== undefined ? 'trace' : 'unknown'
    const ttftSource =
      call.timing?.ttftMs !== undefined ? 'ledger' : span?.ttftMs !== undefined ? 'trace' : 'unknown'
    const durationMs = call.timing?.durationMs ?? span?.durationMs
    const ttftMs = call.timing?.ttftMs ?? span?.ttftMs
    const tokens = tokenMetrics(call)
    const duration = durationMs === undefined ? unknown('duration-unreported') : known(durationMs)
    cumulativeTokens = addTokens(cumulativeTokens, tokens)
    cumulativeDuration = sum(cumulativeDuration, duration)
    const requestNumber = requestNumberBySeq.get(call.seq)
    byCallSeq.set(call.seq, {
      callSeq: call.seq,
      purpose: call.purpose,
      model: call.model,
      requestNumber:
        requestOrderKnown && requestNumber !== undefined
          ? known(requestNumber)
          : unknown(options.hasEarlier ? 'earlier-history-unloaded' : 'request-order-unverifiable'),
      ledgerNumber: options.hasEarlier ? unknown('earlier-history-unloaded') : known(index + 1),
      tokens,
      cumulativeTokens,
      durationMs: duration,
      cumulativeCallDurationMs: cumulativeDuration,
      ttftMs: ttftMs === undefined ? unknown('ttft-unreported') : known(ttftMs),
      durationSource,
      ttftSource,
    })
  }
  return byCallSeq
}
