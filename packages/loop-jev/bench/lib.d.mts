export type Probe = { command: string; contains: string; soft?: boolean }
export type Turn = {
  goal: string
  answer_contains?: string[]
  answer_max_chars?: number
  bash?: Probe[]
  inject_files?: Array<{ name: string; content: string }>
}
export type Suite = {
  suite: string
  scenarios: Array<{ id: string; category: string; max_steps: number; turns: Turn[] }>
}

export type SessionEvent = { type: string; data: unknown; seq: number }
export type MetricEvent = { type: string; data: Record<string, unknown> }

export type Check = { name: string; ok: boolean; soft: boolean }
export type TurnScore = {
  pass: boolean
  probesPass: boolean
  answerPass: boolean
  completed: boolean
  checks: Check[]
}

export type TurnMetrics = {
  inference: number
  /** Side-call rows on the Jev route. */
  sideCall: number
  /** Side-call rows on any other route; not in `tokens`, `usdMicros` or `credits`. */
  otherSideCalls: {
    count: number
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
    usdMicros: number
  }
  compaction: number
  purposes: Record<string, number>
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
  usdMicros: number
  credits: number
  jev: {
    steps: number
    byRoute: Record<string, number>
    llmAttempts: number
    noCall: number
    droppedCalls: number
    decisionFailed: Record<string, number>
    directSuccess: number
    droppedEvents: number
    /** `jev.decide` events other than refused ones: Jev calls that reached the provider. */
    decideCalls: number
  }
  toolSchemaHashes: string[]
  promptPrefixHashes: string[]
  reconciled: boolean
}

export type BenchRecord = {
  scenario: string
  category: string
  lane: string
  rep: number
  turn: number
  score: TurnScore
  metrics: TurnMetrics
  wallMs: number | null
}

/** `turns` counts records; `probesOnly` counts turns whose probes pass, `answerOnly` those whose answer checks pass. */
export type LaneTotals = {
  turns: number
  passes: number
  probesOnly: number
  answerOnly: number
  inference: number
  usdMicros: number
  wallMs: number
}
export type Ratios = {
  passes: number | null
  inference: number | null
  usdMicros: number | null
  wallMs: number | null
}
export type Totals = {
  byLane: Record<string, LaneTotals>
  byFamily: Record<string, Record<string, LaneTotals>>
  byRep: Record<string, Record<string, LaneTotals>>
  /** jev over default, as a ratio of totals; null when the default total is 0. */
  ratios: Ratios & { byFamily: Record<string, Ratios>; byRep: Record<string, Ratios> }
}
export type Verdict = { passGate: boolean; callGate: boolean; costGate: boolean }

export const LANES: { default: { id: string; version: string }; jev: { id: string; version: string } }
export const BENCH_TOOLS: string[]

export function loadSuite(path: string): Suite
export function cacheScope(scenarioId: string, lane: string, rep: number): string
export function presetName(scenarioId: string, lane: string, rep: number): string
export function buildBundle(o: {
  suite: Suite
  lanes: string[]
  reps: number
  stepCap: number
  basePreset?: string
}): { profile: object; presets: Record<string, object> }
export function orderLanes(lanes: string[], rep: number): string[]
export function finalAnswer(events: SessionEvent[], fromSeq: number): string
export function scoreTurn(o: {
  turn: Turn
  answer: string
  endReason: string
  probes: Array<{ exit: number | null; output: string }>
}): TurnScore
export function turnMetrics(
  events: MetricEvent[],
  price?: (row: Record<string, unknown>) => number,
  options?: { jevRoute?: string | null | undefined },
): TurnMetrics
export function computeK(
  turns: Array<{ events: MetricEvent[] }>,
  mutable?: string[],
): { k: number; mutableCalls: number; toolInferences: number }
export function callsPerInference(
  turns: Array<{ events: MetricEvent[] }>,
  mutable?: string[],
): Record<string, number>
export function turnWindow(
  events: SessionEvent[],
  fromSeq: number,
  fallbackSeq?: number,
): {
  start: SessionEvent | undefined
  end: SessionEvent | undefined
  lower: number
  upper: number
  events: SessionEvent[]
}
export function sessionBalance(
  events: MetricEvent[],
  records: Array<{ metrics?: Partial<TurnMetrics> }>,
  jevRoute: string | null,
): {
  inferenceRows: number
  turnInference: number
  jevSideCallRows: number
  turnJevSideCalls: number
  ok: boolean
}
export type DecideStats = {
  calls: number
  byStatus: Record<string, number>
  latencyMs: number
  maxLatencyMs: number
  failedLatencyMs: number
}
export function decideStats(events: MetricEvent[]): DecideStats
export type SchemaEntry = { scenario: string; lane: string; rep: number; hash?: string | null | undefined }
export type SchemaPair = { scenario: string; rep: number; hashes: Record<string, string | null> }
export function toolSchemaCheck(entries: SchemaEntry[]): {
  valid: boolean
  compared: number
  mismatches: SchemaPair[]
  unchecked: SchemaPair[]
}
export function aggregate(records: BenchRecord[]): Totals
export function verdict(totals: Totals, k: number): Verdict
export function renderReport(o: {
  suite: string
  totals: Totals
  verdict?: Verdict
  k?: number
  records: unknown[]
}): string
