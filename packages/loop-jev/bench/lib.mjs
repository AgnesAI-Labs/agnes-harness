// Portions adapted from JevLoop (https://github.com/parkavenue9639/jevloop, 61e7994), Apache-2.0; modified.
// Scoring and configuration helpers for the Jev loop bench tools. Pure functions only: no
// process, network or session access, so every rule here is covered by unit tests.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const LANES = {
  default: { id: 'agnes.default', version: '1.0.0' },
  jev: { id: 'agnes.jev', version: '0.1.0' },
}
export const BENCH_TOOLS = ['ls', 'read', 'grep', 'find', 'write', 'edit', 'shell']

const MAX_BUNDLE_CELLS = 64
const MAX_STEPS_PER_TURN = 20
const REFUSAL_CODES = new Set([
  'TOOL_ARGS_INVALID',
  'TOOL_NOT_FOUND',
  'TOOL_NOT_DISCLOSED',
  'TOOL_POLICY_INVALID',
])
const DEFAULT_MUTABLE = ['write', 'edit', 'shell']

const SUITE_KEYS = new Set(['suite', 'description', 'source', 'scenarios'])
const SCENARIO_KEYS = new Set(['id', 'category', 'favor', 'description', 'max_steps', 'turns'])
const TURN_KEYS = new Set(['goal', 'answer_contains', 'answer_max_chars', 'bash', 'inject_files'])
const PROBE_KEYS = new Set(['command', 'contains', 'soft'])
const INJECT_KEYS = new Set(['name', 'content'])

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const round2 = (n) => Math.round(n * 100) / 100

// ---- suites -------------------------------------------------------------------------------

function rejectUnknown(value, allowed, where) {
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`${where}: unknown key "${key}"`)
}

function checkTurn(turn, where) {
  if (!isObject(turn)) throw new Error(`${where}: a turn must be an object`)
  rejectUnknown(turn, TURN_KEYS, where)
  if (typeof turn.goal !== 'string' || turn.goal.trim() === '')
    throw new Error(`${where}: goal must be a non-empty string`)
  if (
    turn.answer_contains !== undefined &&
    !(Array.isArray(turn.answer_contains) && turn.answer_contains.every((s) => typeof s === 'string'))
  ) {
    throw new Error(`${where}: answer_contains must be an array of strings`)
  }
  if (
    turn.answer_max_chars !== undefined &&
    !(Number.isInteger(turn.answer_max_chars) && turn.answer_max_chars >= 0)
  ) {
    throw new Error(`${where}: answer_max_chars must be a non-negative integer`)
  }
  if (turn.bash !== undefined) {
    if (!Array.isArray(turn.bash)) throw new Error(`${where}: bash must be an array`)
    turn.bash.forEach((probe, i) => {
      const at = `${where} bash[${i}]`
      if (!isObject(probe)) throw new Error(`${at}: must be an object`)
      rejectUnknown(probe, PROBE_KEYS, at)
      if (typeof probe.command !== 'string' || probe.command.trim() === '')
        throw new Error(`${at}: command must be a non-empty string`)
      if (typeof probe.contains !== 'string') throw new Error(`${at}: contains must be a string`)
      if (probe.soft !== undefined && typeof probe.soft !== 'boolean')
        throw new Error(`${at}: soft must be a boolean`)
    })
  }
  if (turn.inject_files !== undefined) {
    if (!Array.isArray(turn.inject_files)) throw new Error(`${where}: inject_files must be an array`)
    turn.inject_files.forEach((file, i) => {
      const at = `${where} inject_files[${i}]`
      if (!isObject(file)) throw new Error(`${at}: must be an object`)
      rejectUnknown(file, INJECT_KEYS, at)
      if (typeof file.name !== 'string' || file.name.trim() === '')
        throw new Error(`${at}: name must be a non-empty string`)
      if (typeof file.content !== 'string') throw new Error(`${at}: content must be a string`)
    })
  }
}

/** Reads a suite file and validates it with the rules of the reference `Turn.from_json`. */
export function loadSuite(path) {
  const suite = JSON.parse(readFileSync(path, 'utf8'))
  if (!isObject(suite)) throw new Error('suite: must be an object')
  rejectUnknown(suite, SUITE_KEYS, 'suite')
  if (typeof suite.suite !== 'string' || suite.suite === '')
    throw new Error('suite: "suite" must be a non-empty string')
  if (!Array.isArray(suite.scenarios) || suite.scenarios.length === 0)
    throw new Error('suite: scenarios must be a non-empty array')
  const seen = new Set()
  for (const scenario of suite.scenarios) {
    if (!isObject(scenario)) throw new Error('suite: a scenario must be an object')
    rejectUnknown(scenario, SCENARIO_KEYS, `scenario ${String(scenario.id)}`)
    if (typeof scenario.id !== 'string' || scenario.id === '')
      throw new Error('suite: a scenario needs a string id')
    if (seen.has(scenario.id)) throw new Error(`suite: duplicate scenario id "${scenario.id}"`)
    seen.add(scenario.id)
    if (typeof scenario.category !== 'string' || scenario.category === '')
      throw new Error(`${scenario.id}: category must be a non-empty string`)
    if (
      scenario.max_steps !== undefined &&
      !(Number.isInteger(scenario.max_steps) && scenario.max_steps > 0)
    ) {
      throw new Error(`${scenario.id}: max_steps must be a positive integer`)
    }
    scenario.max_steps ??= MAX_STEPS_PER_TURN
    if (!Array.isArray(scenario.turns) || scenario.turns.length === 0)
      throw new Error(`${scenario.id}: at least one turn is required`)
    for (const [i, turn] of scenario.turns.entries()) checkTurn(turn, `${scenario.id} turn ${i + 1}`)
  }
  return suite
}

// ---- configuration ------------------------------------------------------------------------

export const cacheScope = (scenarioId, lane, rep) =>
  `[cache-scope:${sha256(`${scenarioId}|${lane}|${rep}`).slice(0, 16)}]`
export const presetName = (scenarioId, lane, rep) =>
  `bench-${sha256(`${scenarioId}|${lane}|${rep}`).slice(0, 12)}`

/** The headless bundle: the plugin row and tool set for the profile, one preset per (scenario, lane, repetition). */
export function buildBundle({ suite, lanes, reps, stepCap, basePreset }) {
  const cells = suite.scenarios.length * lanes.length * reps
  if (cells > MAX_BUNDLE_CELLS)
    throw new Error(`bundle would hold ${cells} presets; the limit is ${MAX_BUNDLE_CELLS}`)
  const presets = {}
  for (const scenario of suite.scenarios) {
    for (const lane of lanes) {
      for (let rep = 0; rep < reps; rep++) {
        const name = presetName(scenario.id, lane, rep)
        presets[name] = {
          name,
          extends: basePreset ?? 'standard',
          budget: { max_steps: MAX_STEPS_PER_TURN },
          model: { system_prompt: { personaPrefix: cacheScope(scenario.id, lane, rep) } },
        }
      }
    }
  }
  return {
    profile: {
      plugins: { 'ext:agnes.jev/loop': { enabled: true, config: { stepCap } } },
      tools: [...BENCH_TOOLS],
    },
    presets,
  }
}

/** Even repetitions run the lanes in the given order, odd ones in reverse. */
export const orderLanes = (lanes, rep) => (rep % 2 === 0 ? [...lanes] : [...lanes].reverse())

// ---- scoring ------------------------------------------------------------------------------

/** The text of the last `end_turn` assistant message after `fromSeq`. */
export function finalAnswer(events, fromSeq) {
  let text = ''
  for (const event of events) {
    if (event.seq <= fromSeq || event.type !== 'assistant/message') continue
    const data = event.data
    if (!isObject(data) || data.stopReason !== 'end_turn') continue
    const blocks = Array.isArray(data.content) ? data.content : []
    text = blocks
      .filter((b) => isObject(b) && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
  }
  return text
}

/** Hard checks: every probe, every answer check and a completed turn. */
export function scoreTurn({ turn, answer, endReason, probes }) {
  const probeChecks = (turn.bash ?? []).map((want, i) => {
    const got = probes[i]
    return {
      name: `probe ${i + 1}`,
      ok: got !== undefined && got.exit === 0 && got.output.includes(want.contains),
      soft: want.soft === true,
    }
  })
  const text = answer.trim()
  const low = text.toLowerCase()
  const answerChecks = (turn.answer_contains ?? []).map((needle) => ({
    name: `answer contains ${JSON.stringify(needle)}`,
    ok: low.includes(needle.toLowerCase()),
    soft: false,
  }))
  if (turn.answer_max_chars !== undefined) {
    answerChecks.push({
      name: `answer at most ${turn.answer_max_chars} chars`,
      ok: text.length <= turn.answer_max_chars,
      soft: false,
    })
  }
  const hardPass = (checks) => checks.every((c) => c.soft || c.ok)
  const probesPass = hardPass(probeChecks)
  const answerPass = hardPass(answerChecks)
  const completed = endReason === 'completed'
  return {
    pass: probesPass && answerPass && completed,
    probesPass,
    answerPass,
    completed,
    checks: [...probeChecks, ...answerChecks],
  }
}

// ---- metrics ------------------------------------------------------------------------------

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const bump = (map, key, by = 1) => {
  map[key] = (map[key] ?? 0) + by
}

/**
 * Per-turn counters from the session events of one turn.
 *
 * `jevRoute` names the Jev side-call route. When it is given, only side-call rows on that route are
 * Jev calls; side-call rows on any other route (a host feature calling a model on its own) go to
 * `otherSideCalls` and stay out of `tokens`, `usdMicros` and `credits`, which feed the gates.
 * `null` means no Jev route, so every side-call row is another one. Left out, every side-call row
 * counts as a Jev call.
 */
export function turnMetrics(events, price, { jevRoute } = {}) {
  const m = {
    inference: 0,
    sideCall: 0,
    otherSideCalls: { count: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, usdMicros: 0 },
    compaction: 0,
    purposes: {},
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    usdMicros: 0,
    credits: 0,
    jev: {
      steps: 0,
      byRoute: {},
      llmAttempts: 0,
      noCall: 0,
      droppedCalls: 0,
      decisionFailed: {},
      directSuccess: 0,
      droppedEvents: 0,
      decideCalls: 0,
    },
    toolSchemaHashes: [],
    promptPrefixHashes: [],
    reconciled: true,
  }
  let sawJev = false
  let metricsEvent
  for (const event of events) {
    const data = event.data ?? {}
    if (event.type === 'cost/ledger') {
      const purpose = typeof data.purpose === 'string' ? data.purpose : 'unknown'
      bump(m.purposes, purpose)
      const tokens = isObject(data.tokens) ? data.tokens : {}
      const billed = isObject(data.billing) ? data.billing.usdMicros : undefined
      const usd = typeof billed === 'number' ? billed : price ? num(price(data)) : 0
      const other = purpose === 'side-call' && jevRoute !== undefined && data.route !== jevRoute
      const into = other ? m.otherSideCalls.tokens : m.tokens
      into.input += num(tokens.input)
      into.output += num(tokens.output)
      into.cacheRead += num(tokens.cacheRead)
      into.cacheWrite += num(tokens.cacheWrite)
      if (other) {
        m.otherSideCalls.count++
        m.otherSideCalls.usdMicros += usd
        continue
      }
      if (purpose === 'inference') m.inference++
      else if (purpose === 'side-call') m.sideCall++
      else if (purpose === 'compaction') m.compaction++
      m.credits += num(data.credits)
      m.usdMicros += usd
    } else if (event.type.endsWith('/jev.decide')) {
      sawJev = true
      // A refused Jev call never reached the provider and has no ledger row.
      if (data.status !== 'refused') m.jev.decideCalls++
    } else if (event.type === 'request/header') {
      if (typeof data.tool_schema_hash === 'string') m.toolSchemaHashes.push(data.tool_schema_hash)
      if (typeof data.prompt_prefix_hash === 'string') m.promptPrefixHashes.push(data.prompt_prefix_hash)
    } else if (event.type.endsWith('/jev.step')) {
      sawJev = true
      m.jev.steps++
      const route = typeof data.route === 'string' ? data.route : 'unknown'
      bump(m.jev.byRoute, route)
      const llm = isObject(data.llm) ? data.llm : {}
      m.jev.llmAttempts += num(llm.attempts)
      m.jev.droppedCalls += num(llm.droppedCalls)
      if (llm.outcome === 'no_call') m.jev.noCall++
      if (route === 'decision_failed')
        bump(m.jev.decisionFailed, typeof data.reason === 'string' ? data.reason : 'unknown')
      if (route === 'direct' && isObject(data.dispatch)) {
        const results = [data.dispatch.results].flat()
        if (results.length > 0 && results.every((r) => r === 'ok')) m.jev.directSuccess++
      }
    } else if (event.type.endsWith('/jev.metrics')) {
      sawJev = true
      metricsEvent = data
    }
  }
  // The per-turn counters are exact even when the per-step events were capped, so they win.
  if (metricsEvent) {
    if (isObject(metricsEvent.decisionFailures)) m.jev.decisionFailed = { ...metricsEvent.decisionFailures }
    if (typeof metricsEvent.directSuccess === 'number') m.jev.directSuccess = metricsEvent.directSuccess
    if (typeof metricsEvent.noCall === 'number') m.jev.noCall = metricsEvent.noCall
    if (typeof metricsEvent.droppedCalls === 'number') m.jev.droppedCalls = metricsEvent.droppedCalls
    m.jev.droppedEvents = num(metricsEvent.droppedEvents)
  }
  // Inference rows match the loop's model attempts, and Jev-route side-call rows its Jev calls.
  m.reconciled = sawJev ? m.inference === m.jev.llmAttempts && m.sideCall === m.jev.decideCalls : true
  return m
}

/**
 * The events of one turn: from the first main-lane `turn/start` after `fromSeq` to the first
 * main-lane `turn/end` after that start and before the next turn/start. Rows written between turns belong to no turn. Without an
 * end the window runs to `fallbackSeq` when given, else to the event before the next turn/start,
 * else to the last event. `upper` is where the next turn's search starts.
 */
export function turnWindow(events, fromSeq, fallbackSeq) {
  const main = (e) => !e.lane || e.lane === 'main'
  const start = events.find((e) => e.seq > fromSeq && e.type === 'turn/start' && main(e))
  const after = start?.seq ?? fromSeq
  const next = events.find((e) => e.seq > after && e.type === 'turn/start' && main(e))
  // An end after the next turn/start is that turn's end, not this one's.
  const end = events.find(
    (e) => e.seq > after && (!next || e.seq < next.seq) && e.type === 'turn/end' && main(e),
  )
  const lower = start ? start.seq - 1 : fromSeq
  const upper = end ? end.seq : (fallbackSeq ?? (next ? next.seq - 1 : (events.at(-1)?.seq ?? fromSeq)))
  return { start, end, lower, upper, events: events.filter((e) => e.seq > lower && e.seq <= upper) }
}

/**
 * The turns of one session must add up to its ledger: inference rows, and side-call rows on the Jev
 * route, counted over all the session's events against the sum of the per-turn counts in `records`.
 * `jevRoute: null` means no Jev route, so only inference is compared.
 */
export function sessionBalance(events, records, jevRoute) {
  const rows = (test) =>
    events.filter((e) => e.type === 'cost/ledger' && test(isObject(e.data) ? e.data : {})).length
  const sum = (key) => records.reduce((total, r) => total + num(r.metrics?.[key]), 0)
  const check = {
    inferenceRows: rows((d) => d.purpose === 'inference'),
    turnInference: sum('inference'),
    jevSideCallRows: jevRoute === null ? 0 : rows((d) => d.purpose === 'side-call' && d.route === jevRoute),
    turnJevSideCalls: jevRoute === null ? 0 : sum('sideCall'),
  }
  return {
    ...check,
    ok: check.inferenceRows === check.turnInference && check.jevSideCallRows === check.turnJevSideCalls,
  }
}

/** Baseline pilot: mutable calls per tool-using inference request. */
export function computeK(turns, mutable = DEFAULT_MUTABLE) {
  let mutableCalls = 0
  let toolInferences = 0
  for (const { events } of turns) {
    const results = new Map()
    for (const event of events)
      if (event.type === 'tool/result') results.set(event.data.toolUseId, event.data)
    for (const event of events) {
      if (event.type === 'assistant/message' && event.data.stopReason === 'tool_use') toolInferences++
      if (event.type !== 'tool/call' || !mutable.includes(event.data.name)) continue
      const result = results.get(event.data.toolUseId)
      if (result && !REFUSAL_CODES.has(result.code)) mutableCalls++
    }
  }
  const k = toolInferences === 0 ? 1 : Math.max(1, round2(mutableCalls / toolInferences))
  return { k, mutableCalls, toolInferences }
}

/**
 * Baseline pilot: how many tool calls each tool-using inference request made, as a histogram keyed
 * "<mutable> mutable + <read-only> read-only". Calls belong to the assistant message before them.
 */
export function callsPerInference(turns, mutable = DEFAULT_MUTABLE) {
  const histogram = {}
  for (const { events } of turns) {
    let open
    const close = () => {
      if (open && open.mutable + open.readOnly > 0)
        bump(histogram, `${open.mutable} mutable + ${open.readOnly} read-only`)
    }
    for (const event of events) {
      if (event.type === 'assistant/message') {
        close()
        open = event.data?.stopReason === 'tool_use' ? { mutable: 0, readOnly: 0 } : undefined
      } else if (event.type === 'tool/call' && open) {
        if (mutable.includes(event.data?.name)) open.mutable++
        else open.readOnly++
      }
    }
    close()
  }
  return histogram
}

/**
 * The Jev calls of one turn from its `jev.decide` events: count by status, total and largest
 * latency, and the time spent in calls that did not answer (status other than `ok`).
 */
export function decideStats(events) {
  const stats = { calls: 0, byStatus: {}, latencyMs: 0, maxLatencyMs: 0, failedLatencyMs: 0 }
  for (const event of events) {
    if (!event.type.endsWith('/jev.decide')) continue
    const data = isObject(event.data) ? event.data : {}
    const status = typeof data.status === 'string' ? data.status : 'unknown'
    const latency = num(data.latencyMs)
    stats.calls++
    bump(stats.byStatus, status)
    stats.latencyMs += latency
    stats.maxLatencyMs = Math.max(stats.maxLatencyMs, latency)
    if (status !== 'ok') stats.failedLatencyMs += latency
  }
  return stats
}

/**
 * The lanes compare only when they send the same tool schema. `entries` hold the first request's
 * `tool_schema_hash` of each (scenario, lane, repetition); entries of one scenario and repetition
 * must agree. A pair with a missing hash cannot be checked and is listed apart. With no pair
 * compared at all, nothing shows the lanes comparable, so the result is not valid either.
 */
export function toolSchemaCheck(entries) {
  const groups = new Map()
  for (const e of entries) {
    const key = `${e.scenario}|${e.rep}`
    groups.set(key, [...(groups.get(key) ?? []), e])
  }
  const mismatches = []
  const unchecked = []
  let compared = 0
  for (const list of groups.values()) {
    if (list.length < 2) continue
    const where = { scenario: list[0].scenario, rep: list[0].rep }
    const hashes = Object.fromEntries(list.map((e) => [e.lane, e.hash ?? null]))
    if (list.some((e) => typeof e.hash !== 'string')) {
      unchecked.push({ ...where, hashes })
      continue
    }
    compared++
    if (new Set(list.map((e) => e.hash)).size > 1) mismatches.push({ ...where, hashes })
  }
  return { valid: compared > 0 && mismatches.length === 0, compared, mismatches, unchecked }
}

// ---- aggregation and gates ----------------------------------------------------------------

const slot = (map, key, make) => {
  if (map[key] === undefined) map[key] = make()
  return map[key]
}
const emptyTotals = () => ({
  turns: 0,
  passes: 0,
  probesOnly: 0,
  answerOnly: 0,
  inference: 0,
  usdMicros: 0,
  wallMs: 0,
})

function addRecord(totals, r) {
  totals.turns++
  if (r.score.pass) totals.passes++
  if (r.score.probesPass) totals.probesOnly++
  if (r.score.answerPass) totals.answerOnly++
  totals.inference += num(r.metrics?.inference)
  totals.usdMicros += num(r.metrics?.usdMicros)
  totals.wallMs += num(r.wallMs)
}

function ratioOf(top, bottom) {
  const ratio = (key) => (bottom && bottom[key] > 0 && top ? top[key] / bottom[key] : null)
  return {
    passes: ratio('passes'),
    inference: ratio('inference'),
    usdMicros: ratio('usdMicros'),
    wallMs: ratio('wallMs'),
  }
}

/** Sums by lane, scenario family and repetition; `ratios` are Jev over default (ratio of totals). */
export function aggregate(records) {
  const byLane = {}
  const byFamily = {}
  const byRep = {}
  for (const r of records) {
    addRecord(slot(byLane, r.lane, emptyTotals), r)
    addRecord(
      slot(
        slot(byFamily, r.scenario, () => ({})),
        r.lane,
        emptyTotals,
      ),
      r,
    )
    addRecord(
      slot(
        slot(byRep, r.rep, () => ({})),
        r.lane,
        emptyTotals,
      ),
      r,
    )
  }
  const ratios = { ...ratioOf(byLane.jev, byLane.default), byFamily: {}, byRep: {} }
  for (const [family, lanes] of Object.entries(byFamily))
    ratios.byFamily[family] = ratioOf(lanes.jev, lanes.default)
  for (const [rep, lanes] of Object.entries(byRep)) ratios.byRep[rep] = ratioOf(lanes.jev, lanes.default)
  return { byLane, byFamily, byRep, ratios }
}

/** The three acceptance gates on the totals; `k` scales only the inference-count gate. */
export function verdict(totals, k) {
  const jev = totals.byLane.jev
  const base = totals.byLane.default
  // A gate cannot be met by a lane that never ran: without both lanes every gate fails.
  if (!jev || !base) return { passGate: false, callGate: false, costGate: false }
  return {
    passGate: jev.passes >= base.passes,
    callGate: jev.inference <= 0.75 * k * base.inference,
    costGate: jev.usdMicros <= 0.8 * base.usdMicros,
  }
}

// ---- report -------------------------------------------------------------------------------

const usd = (micros) => `$${(micros / 1e6).toFixed(6)}`
const seconds = (ms) => (ms === null || ms === undefined ? '-' : `${(ms / 1000).toFixed(1)} s`)
const ratioCell = (v) => (v === null || v === undefined ? '-' : v.toFixed(2))
const table = (head, rows) =>
  [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n')
const totalsRow = (label, lane, t) => [
  label,
  lane,
  `${t.passes}/${t.turns}`,
  `${t.probesOnly}`,
  `${t.answerOnly}`,
  `${t.inference}`,
  usd(t.usdMicros),
  seconds(t.wallMs),
]
const TOTALS_HEAD = ['Group', 'Lane', 'Pass', 'Probes only', 'Answer only', 'Inference', 'Cost', 'Wall']

export function renderReport({ suite, totals, verdict: gates, k, records }) {
  const out = [`# Bench report: ${suite}`, '']
  const laneNames = Object.keys(totals.byLane).sort()
  out.push('## By family', '')
  out.push(
    table(
      TOTALS_HEAD,
      Object.entries(totals.byFamily).flatMap(([family, lanes]) =>
        laneNames.filter((l) => lanes[l]).map((l) => totalsRow(family, l, lanes[l])),
      ),
    ),
  )
  out.push('', '## By turn', '')
  const rows = [...records].sort(
    (a, b) =>
      a.scenario.localeCompare(b.scenario) ||
      a.turn - b.turn ||
      a.rep - b.rep ||
      a.lane.localeCompare(b.lane),
  )
  out.push(
    table(
      [
        'Scenario',
        'Turn',
        'Rep',
        'Lane',
        'Pass',
        'Probes',
        'Answer',
        'Completed',
        'Inference',
        'Cost',
        'Wall',
      ],
      rows.map((r) => [
        r.scenario,
        `${r.turn + 1}`,
        `${r.rep + 1}`,
        r.lane,
        r.score.pass ? 'yes' : 'NO',
        r.score.probesPass ? 'yes' : 'NO',
        r.score.answerPass ? 'yes' : 'NO',
        r.score.completed ? 'yes' : 'NO',
        `${r.metrics?.inference ?? 0}`,
        usd(r.metrics?.usdMicros ?? 0),
        seconds(r.wallMs),
      ]),
    ),
  )
  out.push('', '## Totals', '')
  out.push(
    table(
      TOTALS_HEAD,
      laneNames.map((l) => totalsRow('all', l, totals.byLane[l])),
    ),
  )
  out.push('', '## Ratios (jev / default)', '')
  const ratioRow = (label, r) => [
    label,
    ratioCell(r.passes),
    ratioCell(r.inference),
    ratioCell(r.usdMicros),
    ratioCell(r.wallMs),
  ]
  out.push(
    table(
      ['Group', 'Pass', 'Inference', 'Cost', 'Wall'],
      [
        ratioRow('all', totals.ratios),
        ...Object.entries(totals.ratios.byFamily).map(([f, r]) => ratioRow(f, r)),
        ...Object.entries(totals.ratios.byRep).map(([rep, r]) => ratioRow(`rep ${Number(rep) + 1}`, r)),
      ],
    ),
  )
  if (gates) {
    const mark = (ok) => (ok ? 'PASS' : 'FAIL')
    out.push('', '## Verdict', '')
    out.push(`k = ${k ?? 1}`, '')
    out.push(
      table(
        ['Gate', 'Rule', 'Result'],
        [
          ['Pass', 'jev passes >= default passes', mark(gates.passGate)],
          ['Calls', `jev inference <= 0.75 x k x default inference (k = ${k ?? 1})`, mark(gates.callGate)],
          ['Cost', 'jev cost <= 0.8 x default cost', mark(gates.costGate)],
        ],
      ),
    )
  }
  return `${out.join('\n')}\n`
}
