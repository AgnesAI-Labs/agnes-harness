import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  aggregate,
  buildBundle,
  cacheScope,
  callsPerInference,
  computeK,
  decideStats,
  finalAnswer,
  loadSuite,
  orderLanes,
  presetName,
  renderReport,
  scoreTurn,
  sessionBalance,
  toolSchemaCheck,
  turnMetrics,
  turnWindow,
  verdict,
} from '../bench/lib.mjs'

const families = fileURLToPath(new URL('../bench/suites/fastapi-families.json', import.meta.url))
const smoke = fileURLToPath(new URL('../bench/suites/smoke.json', import.meta.url))

describe('bench suites', () => {
  it('loads the exported FastAPI families: 3 scenarios, 20 turns, Chinese goals, attribution', () => {
    const s = loadSuite(families)
    expect(s.scenarios.map((x) => [x.id, x.turns.length])).toEqual([
      ['fastapi-observation-reuse', 6],
      ['fastapi-generation', 6],
      ['fastapi-mixed', 8],
    ])
    expect(s.scenarios[0]?.turns[0]?.goal).toMatch(/FastAPI/)
    expect((s as unknown as { source: { commit: string } }).source.commit).toBe('61e7994')
    expect(s.scenarios[1]?.turns[0]?.bash?.[0]?.contains).toBe('FAMILY_GENERATION_T1_OK')
  })
  it('loads the smoke suite with checks rewritten as probes', () => {
    const s = loadSuite(smoke)
    expect(s.scenarios).toHaveLength(6)
    expect(
      s.scenarios
        .flatMap((x) => x.turns)
        .every((t) => (t.bash?.length ?? 0) > 0 || (t.answer_contains?.length ?? 0) > 0),
    ).toBe(true)
    expect(s.scenarios.find((x) => x.id === 'ledger-continuity')?.turns[2]?.bash?.[0]?.soft).toBe(true)
  })
})

describe('bench configuration', () => {
  const suite = loadSuite(families)
  it('isolates prompt caches per scenario, lane and repetition', () => {
    expect(cacheScope('a', 'jev', 1)).toMatch(/^\[cache-scope:[0-9a-f]{16}\]$/)
    expect(cacheScope('a', 'jev', 1)).not.toBe(cacheScope('a', 'default', 1))
    expect(presetName('a', 'jev', 1)).toMatch(/^bench-[0-9a-f]{12}$/)
  })
  it('builds one bundle: the Jev row, seven tools and a preset per cell', () => {
    const b = buildBundle({ suite, lanes: ['default', 'jev'], reps: 3, stepCap: 20 }) as {
      profile: { plugins: object; tools: string[] }
      presets: Record<string, { budget: object; model: { system_prompt: { personaPrefix: string } } }>
    }
    expect(b.profile).toEqual({
      plugins: { 'ext:agnes.jev/loop': { enabled: true, config: { stepCap: 20 } } },
      tools: ['ls', 'read', 'grep', 'find', 'write', 'edit', 'shell'],
    })
    expect(Object.keys(b.presets)).toHaveLength(18)
    expect(Object.values(b.presets)[0]).toMatchObject({ extends: 'standard', budget: { max_steps: 20 } })
  })
  it('alternates lane order by repetition', () => {
    expect(orderLanes(['default', 'jev'], 0)).toEqual(['default', 'jev'])
    expect(orderLanes(['default', 'jev'], 1)).toEqual(['jev', 'default'])
  })
})

describe('bench scoring', () => {
  const turn = {
    goal: 'g',
    answer_contains: ['Lantern Catalog', 'orchard-ops'],
    bash: [{ command: 'x', contains: 'M_OK' }],
  }
  it('passes only with probes, answer checks and a completed turn', () => {
    expect(
      scoreTurn({
        turn,
        answer: 'lantern catalog by ORCHARD-OPS',
        endReason: 'completed',
        probes: [{ exit: 0, output: 'M_OK' }],
      }),
    ).toMatchObject({ pass: true, probesPass: true, answerPass: true })
    expect(
      scoreTurn({
        turn,
        answer: 'lantern catalog',
        endReason: 'completed',
        probes: [{ exit: 0, output: 'M_OK' }],
      }),
    ).toMatchObject({ pass: false, probesPass: true, answerPass: false })
    expect(
      scoreTurn({
        turn,
        answer: 'Lantern Catalog orchard-ops',
        endReason: 'completed',
        probes: [{ exit: 1, output: 'M_OK' }],
      }).probesPass,
    ).toBe(false)
    expect(
      scoreTurn({
        turn,
        answer: 'Lantern Catalog orchard-ops',
        endReason: 'max_steps',
        probes: [{ exit: 0, output: 'M_OK' }],
      }).pass,
    ).toBe(false)
  })
  it('ignores soft probes and enforces answer_max_chars', () => {
    expect(
      scoreTurn({
        turn: { goal: 'g', bash: [{ command: 'x', contains: 'Z', soft: true }] },
        answer: '',
        endReason: 'completed',
        probes: [{ exit: 1, output: '' }],
      }).pass,
    ).toBe(true)
    expect(
      scoreTurn({
        turn: { goal: 'g', answer_contains: ['3'], answer_max_chars: 5 },
        answer: 'there are 3 lines',
        endReason: 'completed',
        probes: [],
      }).answerPass,
    ).toBe(false)
  })
  it('takes the last end_turn assistant message of the turn as the answer', () => {
    const ev = [
      {
        seq: 1,
        type: 'assistant/message',
        data: { content: [{ type: 'text', text: 'old' }], stopReason: 'end_turn' },
      },
      { seq: 5, type: 'assistant/message', data: { content: [], stopReason: 'tool_use' } },
      {
        seq: 7,
        type: 'assistant/message',
        data: { content: [{ type: 'text', text: 'new' }], stopReason: 'end_turn' },
      },
    ]
    expect(finalAnswer(ev, 2)).toBe('new')
  })
})

describe('bench metrics', () => {
  const cost = (purpose: string, usdMicros: number) => ({
    type: 'cost/ledger',
    data: {
      purpose,
      tokens: { input: 10, output: 1, cacheRead: 5, cacheWrite: 0 },
      credits: 1,
      billing: { usdMicros, source: 'gateway', subscription: false },
    },
  })
  const decide = (status: string) => ({ type: 'x/agnes/base/jev.decide', data: { status, latencyMs: 1 } })
  it('counts inference and side-call rows and reconciles with jev.step and jev.decide', () => {
    const m = turnMetrics([
      cost('inference', 100),
      cost('side-call', 7),
      cost('side-call', 7),
      decide('ok'),
      decide('ok'),
      decide('refused'),
      { type: 'x/agnes/base/jev.step', data: { route: 'answer', llm: { attempts: 1 } } },
      { type: 'x/agnes/base/jev.step', data: { route: 'direct' } },
    ])
    expect(m).toMatchObject({
      inference: 1,
      sideCall: 2,
      usdMicros: 114,
      reconciled: true,
      jev: { steps: 2, llmAttempts: 1, decideCalls: 2 },
    })
    // A Jev call without its ledger row, or a row without its call, breaks the reconciliation.
    expect(turnMetrics([cost('side-call', 7), decide('ok'), decide('ok')]).reconciled).toBe(false)
  })
  it('keeps side calls on other routes out of the Jev counts and the cost', () => {
    const on = (route: string, usdMicros: number) => {
      const row = cost('side-call', usdMicros)
      return { ...row, data: { ...row.data, route } }
    }
    const events = [
      cost('inference', 100),
      on('jev', 7),
      on('chat', 50),
      on('chat', 50),
      decide('ok'),
      { type: 'x/agnes/base/jev.step', data: { route: 'answer', llm: { attempts: 1 } } },
    ]
    const m = turnMetrics(events, undefined, { jevRoute: 'jev' })
    expect(m).toMatchObject({
      inference: 1,
      sideCall: 1,
      usdMicros: 107,
      credits: 2,
      tokens: { input: 20, output: 2, cacheRead: 10, cacheWrite: 0 },
      otherSideCalls: { count: 2, usdMicros: 100, tokens: { input: 20, output: 2, cacheRead: 10 } },
      reconciled: true,
    })
    expect(m.purposes).toEqual({ inference: 1, 'side-call': 3 })
    const { billing: _billing, ...unbilled } = on('chat', 50).data
    expect(
      turnMetrics([...events, { type: 'cost/ledger', data: { ...unbilled, interrupted: true } }], () => 23, {
        jevRoute: 'jev',
      }),
    ).toMatchObject({
      sideCall: 1,
      usdMicros: 107,
      otherSideCalls: { count: 3, usdMicros: 123, tokens: { input: 30, output: 3, cacheRead: 15 } },
    })
    // Without a Jev route every side-call row is another one; left out, every row counts as Jev.
    expect(turnMetrics(events, undefined, { jevRoute: null })).toMatchObject({
      sideCall: 0,
      otherSideCalls: { count: 3 },
      usdMicros: 100,
    })
    expect(turnMetrics(events)).toMatchObject({
      sideCall: 3,
      otherSideCalls: { count: 0 },
      reconciled: false,
    })
  })
  it('windows each turn from its own start to its own end', () => {
    const types = [
      'turn/start',
      'cost/ledger',
      'turn/end',
      'cost/ledger',
      'turn/start',
      'cost/ledger',
      'turn/end',
    ]
    const events = types.map((type, i) => ({ seq: i + 1, type, data: {} }))
    const first = turnWindow(events, 0)
    expect(first.events.map((e) => e.seq)).toEqual([1, 2, 3])
    // The row between the turns (seq 4) belongs to neither; the second turn starts after the first.
    const second = turnWindow(events, first.upper)
    expect(second.events.map((e) => e.seq)).toEqual([5, 6, 7])
    expect(second.lower).toBe(4)
    // Without an end the window stops before the next turn, or at the fallback when one is given.
    const open = events.filter((e) => e.seq !== 3)
    expect(turnWindow(open, 0).events.map((e) => e.seq)).toEqual([1, 2, 4])
    expect(turnWindow(open, 0, 2).upper).toBe(2)
    // Another lane's turn rows do not open or close the main lane's turn.
    const side = [
      { seq: 1, type: 'turn/start', lane: 'child', data: {} },
      ...events.map((e) => ({ ...e, seq: e.seq + 1 })),
    ]
    expect(turnWindow(side, 0).start?.seq).toBe(2)
  })
  it('checks that the turns of a session add up to its ledger rows', () => {
    const on = (purpose: string, route?: string) => ({ type: 'cost/ledger', data: { purpose, route } })
    const session = [
      on('inference'),
      on('inference'),
      on('side-call', 'jev'),
      on('side-call', 'chat'),
      on('title'),
    ]
    const turn = (inference: number, sideCall: number) => ({ metrics: { inference, sideCall } })
    expect(sessionBalance(session, [turn(1, 0), turn(1, 1)], 'jev')).toEqual({
      inferenceRows: 2,
      turnInference: 2,
      jevSideCallRows: 1,
      turnJevSideCalls: 1,
      ok: true,
    })
    // Windows that each start at the session's beginning count the first turn's rows twice.
    expect(sessionBalance(session, [turn(1, 0), turn(2, 1)], 'jev')).toMatchObject({
      turnInference: 3,
      ok: false,
    })
    expect(sessionBalance(session, [turn(2, 0)], 'jev')).toMatchObject({ ok: false })
    expect(sessionBalance(session, [turn(2, 0)], null)).toMatchObject({ jevSideCallRows: 0, ok: true })
  })
  it('computes k from the baseline pilot', () => {
    const events = [
      { type: 'assistant/message', data: { stopReason: 'tool_use' } },
      { type: 'tool/call', data: { toolUseId: 'a', name: 'edit' } },
      { type: 'tool/call', data: { toolUseId: 'b', name: 'edit' } },
      { type: 'tool/result', data: { toolUseId: 'a' } },
      { type: 'tool/result', data: { toolUseId: 'b' } },
      { type: 'assistant/message', data: { stopReason: 'tool_use' } },
      { type: 'tool/call', data: { toolUseId: 'c', name: 'read' } },
      { type: 'tool/result', data: { toolUseId: 'c' } },
      { type: 'assistant/message', data: { stopReason: 'tool_use' } },
      { type: 'tool/call', data: { toolUseId: 'd', name: 'write' } },
      { type: 'tool/result', data: { toolUseId: 'd', code: 'TOOL_ARGS_INVALID' } },
    ]
    expect(computeK([{ events }])).toEqual({ k: 1, mutableCalls: 2, toolInferences: 3 })
    expect(computeK([{ events: events.slice(0, 5) }]).k).toBe(2)
    expect(callsPerInference([{ events }, { events: events.slice(0, 3) }])).toEqual({
      '2 mutable + 0 read-only': 2,
      '0 mutable + 1 read-only': 1,
      '1 mutable + 0 read-only': 1,
    })
    const answered = [{ type: 'assistant/message', data: { stopReason: 'end_turn' } }, ...events.slice(6, 8)]
    expect(callsPerInference([{ events: answered }])).toEqual({})
  })
  it('sums the Jev calls of a turn by status and latency', () => {
    const decide = (status: string, latencyMs: number) => ({
      type: 'x/agnes/base/jev.decide',
      data: { status, latencyMs },
    })
    expect(
      decideStats([
        decide('ok', 10),
        { type: 'cost/ledger', data: {} },
        decide('failed', 40),
        decide('ok', 5),
      ]),
    ).toEqual({
      calls: 3,
      byStatus: { ok: 2, failed: 1 },
      latencyMs: 55,
      maxLatencyMs: 40,
      failedLatencyMs: 40,
    })
  })
  it('compares the lanes only when their tool schemas agree', () => {
    const e = (scenario: string, lane: string, rep: number, hash?: string) => ({ scenario, lane, rep, hash })
    expect(toolSchemaCheck([e('a', 'default', 0, 'h1'), e('a', 'jev', 0, 'h1')])).toMatchObject({
      valid: true,
      compared: 1,
    })
    const differ = toolSchemaCheck([
      e('a', 'default', 0, 'h1'),
      e('a', 'jev', 0, 'h2'),
      e('b', 'jev', 0, 'h1'),
    ])
    expect(differ.valid).toBe(false)
    expect(differ.mismatches).toEqual([{ scenario: 'a', rep: 0, hashes: { default: 'h1', jev: 'h2' } }])
    const missing = toolSchemaCheck([e('a', 'default', 0, 'h1'), e('a', 'jev', 0)])
    expect(missing).toMatchObject({ valid: false, compared: 0, unchecked: [{ scenario: 'a' }] })
    expect(toolSchemaCheck([e('a', 'default', 0, 'h1')]).valid).toBe(false)
  })
  it('judges the three gates on totals', () => {
    const rec = (lane: string, pass: boolean, inference: number, usd: number) => ({
      scenario: 's',
      category: 'c',
      lane,
      rep: 0,
      turn: 0,
      score: { pass, probesPass: pass, answerPass: pass, completed: true, checks: [] },
      metrics: { inference, usdMicros: usd } as never,
      wallMs: 1,
    })
    const totals = aggregate([rec('default', true, 10, 1000), rec('jev', true, 7, 790)])
    expect(verdict(totals, 1)).toEqual({ passGate: true, callGate: true, costGate: true })
    expect(verdict(aggregate([rec('default', true, 10, 1000), rec('jev', true, 8, 790)]), 1).callGate).toBe(
      false,
    )
    expect(verdict(aggregate([rec('default', true, 10, 1000), rec('jev', true, 14, 790)]), 2).callGate).toBe(
      true,
    )
  })
})

describe('bench suite validation', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })
  const write = (suite: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-suite-'))
    dirs.push(dir)
    const path = join(dir, 'suite.json')
    writeFileSync(path, JSON.stringify(suite))
    return path
  }
  const scenario = (id: string, turn: object = { goal: 'g' }) => ({ id, category: 'c', turns: [turn] })
  it('rejects unknown keys, empty goals and duplicate ids', () => {
    expect(() =>
      loadSuite(write({ suite: 's', scenarios: [scenario('a', { goal: 'g', files: [] })] })),
    ).toThrow(/unknown key "files"/)
    expect(() => loadSuite(write({ suite: 's', scenarios: [scenario('a', { goal: '  ' })] }))).toThrow(/goal/)
    expect(() => loadSuite(write({ suite: 's', scenarios: [scenario('a'), scenario('a')] }))).toThrow(
      /duplicate/,
    )
    expect(() => loadSuite(write({ suite: 's', extra: 1, scenarios: [scenario('a')] }))).toThrow(
      /unknown key "extra"/,
    )
    expect(() =>
      loadSuite(
        write({
          suite: 's',
          scenarios: [scenario('a', { goal: 'g', bash: [{ command: 'x', contains: 'y', note: 1 }] })],
        }),
      ),
    ).toThrow(/unknown key "note"/)
  })
  it('refuses a bundle over the 64-cell limit', () => {
    const suite = loadSuite(families)
    expect(() => buildBundle({ suite, lanes: ['default', 'jev'], reps: 11, stepCap: 20 })).toThrow(/64/)
    expect(
      Object.keys(buildBundle({ suite, lanes: ['default', 'jev'], reps: 10, stepCap: 20 }).presets),
    ).toHaveLength(60)
  })
  it('counts request headers and reconciles a lane without Jev events', () => {
    const m = turnMetrics([
      { type: 'request/header', data: { tool_schema_hash: 'h1', prompt_prefix_hash: 'p1' } },
      { type: 'request/header', data: { tool_schema_hash: 'h1', prompt_prefix_hash: null } },
      { type: 'cost/ledger', data: { purpose: 'inference', tokens: {} } },
    ])
    expect(m).toMatchObject({
      toolSchemaHashes: ['h1', 'h1'],
      promptPrefixHashes: ['p1'],
      inference: 1,
      reconciled: true,
    })
  })
  it('flags a lane whose inference rows differ from the Jev attempts', () => {
    const m = turnMetrics(
      [
        { type: 'cost/ledger', data: { purpose: 'inference', tokens: {} } },
        { type: 'x/a/b/jev.step', data: { route: 'answer', llm: { attempts: 2 } } },
      ],
      () => 5,
    )
    expect(m).toMatchObject({ reconciled: false, usdMicros: 5 })
  })
  it('renders the family, turn and total tables with ratios and the verdict', () => {
    const rec = (lane: string, usd: number) => ({
      scenario: 's',
      category: 'c',
      lane,
      rep: 0,
      turn: 0,
      score: { pass: true, probesPass: true, answerPass: true, completed: true, checks: [] },
      metrics: { inference: 4, usdMicros: usd } as never,
      wallMs: 2000,
    })
    const records = [rec('default', 1000), rec('jev', 700)]
    const totals = aggregate(records)
    const md = renderReport({ suite: 'demo', totals, verdict: verdict(totals, 1), k: 1, records })
    expect(md).toMatch(/## By family[\s\S]*## By turn[\s\S]*## Totals[\s\S]*## Ratios[\s\S]*## Verdict/)
    expect(md).toContain('| s | jev | 1/1 | 1 | 1 | 4 | $0.000700 | 2.0 s |')
    expect(md).toContain('| Cost | jev cost <= 0.8 x default cost | PASS |')
  })

  it('derives steps from the step events, not from the metrics counters', () => {
    const m = turnMetrics([
      { type: 'x/a/b/jev.step', data: { route: 'direct', dispatch: { results: ['ok'] } } },
      { type: 'x/a/b/jev.step', data: { route: 'decision_failed', reason: 'MODEL_UNAVAILABLE' } },
      {
        type: 'x/a/b/jev.metrics',
        data: {
          steps: 99,
          directSuccess: 3,
          noCall: 2,
          droppedCalls: 1,
          droppedEvents: 4,
          decisionFailures: { MODEL_UNAVAILABLE: 5 },
        },
      },
    ])
    expect(m.jev).toMatchObject({
      steps: 2,
      directSuccess: 3,
      noCall: 2,
      droppedCalls: 1,
      droppedEvents: 4,
      decisionFailed: { MODEL_UNAVAILABLE: 5 },
    })
  })
  it('fails every gate when a lane has no records', () => {
    const rec = (lane: string) => ({
      scenario: 's',
      category: 'c',
      lane,
      rep: 0,
      turn: 0,
      score: { pass: true, probesPass: true, answerPass: true, completed: true, checks: [] },
      metrics: { inference: 1, usdMicros: 1 } as never,
      wallMs: 1,
    })
    const none = { passGate: false, callGate: false, costGate: false }
    expect(verdict(aggregate([rec('default')]), 1)).toEqual(none)
    expect(verdict(aggregate([rec('jev')]), 1)).toEqual(none)
    expect(verdict(aggregate([]), 1)).toEqual(none)
  })
  it('does not count soft answer checks and fails on a missing probe result', () => {
    const base = { endReason: 'completed', probes: [] }
    expect(scoreTurn({ ...base, turn: { goal: 'g', answer_contains: ['x'] }, answer: 'y' }).checks).toEqual([
      { name: 'answer contains "x"', ok: false, soft: false },
    ])
    const missing = scoreTurn({
      turn: {
        goal: 'g',
        bash: [
          { command: 'c', contains: 'm' },
          { command: 'c2', contains: 'm2', soft: true },
        ],
      },
      answer: '',
      endReason: 'completed',
      probes: [],
    })
    expect(missing).toMatchObject({ pass: false, probesPass: false })
    expect(missing.checks.map((c) => [c.ok, c.soft])).toEqual([
      [false, false],
      [false, true],
    ])
    expect(
      scoreTurn({
        turn: { goal: 'g', bash: [{ command: 'c', contains: 'm' }] },
        answer: '',
        endReason: 'completed',
        probes: [{ exit: null, output: 'm' }],
      }).probesPass,
    ).toBe(false)
  })
  it('returns an empty answer when no end_turn message follows fromSeq', () => {
    const ev = [
      {
        seq: 1,
        type: 'assistant/message',
        data: { content: [{ type: 'text', text: 'old' }], stopReason: 'end_turn' },
      },
      {
        seq: 3,
        type: 'assistant/message',
        data: { content: [{ type: 'text', text: 'mid' }], stopReason: 'tool_use' },
      },
      { seq: 4, type: 'tool/result', data: {} },
    ]
    expect(finalAnswer(ev, 1)).toBe('')
    expect(finalAnswer([], 0)).toBe('')
  })
  it('keeps k at 1 when there are no tool-using inferences', () => {
    expect(computeK([])).toEqual({ k: 1, mutableCalls: 0, toolInferences: 0 })
    expect(computeK([{ events: [{ type: 'assistant/message', data: { stopReason: 'end_turn' } }] }])).toEqual(
      { k: 1, mutableCalls: 0, toolInferences: 0 },
    )
  })
})
