import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parsePrimeSession, runMetrics, toRunRecord } from './metrics.js'
import { buildReport } from './report.js'
import type { EvalTask, PromptWindow, RunOutcome, RunRecord } from './types.js'

const fixture = (name: string): string =>
  readFileSync(join(fileURLToPath(new URL('./fixtures/', import.meta.url)), name), 'utf8')

const prompt = (text: string) => ({ text, checks: [], solution: [] })
const session = () => ({
  prompts: [
    prompt('Add function alpha and run the tests'),
    prompt('Add function beta and run the tests'),
    prompt('Add function gamma and run the tests'),
  ],
})

const task: EvalTask = {
  id: 'dir-demo',
  category: 'directory',
  description: 'demo',
  trap: { signatures: ['tests must be run from build/'], reproduce: 'make test', note: 'n' },
  sessions: [session()],
}

const crossTask: EvalTask = {
  ...task,
  id: 'cross-demo',
  category: 'cross-session',
  sessions: [session(), session()],
}

const record = (over: Partial<RunRecord> = {}): RunRecord => ({
  system: 'prime',
  taskId: 'dir-demo',
  category: 'directory',
  setting: 'on',
  rep: 1,
  exit: 'ok',
  windows: [],
  refine: { auto: 0, user: 0, self: 0, appliedEdits: 0 },
  harnessLookups: 0,
  compactions: 0,
  usage: { requests: 0, unknown: 0, tokens: 0, costUsd: 0 },
  ...over,
})

const win = (sessionIndex: number, promptIndex: number, over: Partial<PromptWindow> = {}): PromptWindow => ({
  session: sessionIndex,
  prompt: promptIndex,
  ran: true,
  trapHit: false,
  checksPassed: true,
  ...over,
})

describe('parsePrimeSession', () => {
  it('matches the trap in python stdout even when isError is false', () => {
    const parsed = parsePrimeSession(fixture('prime-session-stdout-trap.jsonl'), task, 0)
    expect(parsed.windows).toEqual([
      { session: 0, prompt: 0, ran: true, trapHit: true },
      { session: 0, prompt: 1, ran: true, trapHit: false },
      { session: 0, prompt: 2, ran: true, trapHit: true },
    ])
  })

  it('marks prompts after an aborted /refine as not ran and counts them as not passed', () => {
    const parsed = parsePrimeSession(fixture('prime-session-aborted-refine.jsonl'), task, 0)
    expect(parsed.windows).toEqual([
      { session: 0, prompt: 0, ran: true, trapHit: true },
      { session: 0, prompt: 1, ran: false, trapHit: false },
      { session: 0, prompt: 2, ran: false, trapHit: false },
    ])
    // Even if a stray check result says "passed", a prompt that never ran is not passed.
    const metrics = runMetrics(
      record({
        windows: [
          win(0, 0, { trapHit: true, checksPassed: true }),
          win(0, 1, { ran: false, checksPassed: true }),
          win(0, 2, { ran: false, checksPassed: null }),
        ],
      }),
    )
    expect(metrics.completion).toBeCloseTo(1 / 3)
  })

  it('returns null recurrence when the trap never fires', () => {
    const parsed = parsePrimeSession(fixture('prime-session-no-trap.jsonl'), task, 0)
    expect(parsed.windows.every((w) => w.ran && !w.trapHit)).toBe(true)
    const metrics = runMetrics(record({ windows: parsed.windows.map((w) => ({ ...w, checksPassed: true })) }))
    expect(metrics.recurrence).toBeNull()
    expect(metrics.completion).toBe(1)
  })

  it('returns null recurrence when the only hit has no later ran prompt', () => {
    const parsed = parsePrimeSession(fixture('prime-session-aborted-refine.jsonl'), task, 0)
    const metrics = runMetrics(
      record({ windows: parsed.windows.map((w) => ({ ...w, checksPassed: false })) }),
    )
    expect(metrics.recurrence).toBeNull()
  })

  it('counts refine runs by source and harness lookups in kernel code', () => {
    const a = parsePrimeSession(fixture('prime-session-stdout-trap.jsonl'), task, 0)
    // r1 has an auto notice; r2 applied nothing so it has no notice and counts as user.
    expect(a.refine).toEqual({ auto: 1, user: 1, self: 0, appliedEdits: 3 })
    expect(a.harnessLookups).toBe(3)
    expect(a.compactions).toBe(1)

    const c = parsePrimeSession(fixture('prime-session-no-trap.jsonl'), task, 0)
    expect(c.refine).toEqual({ auto: 0, user: 0, self: 1, appliedEdits: 1 })
    expect(c.harnessLookups).toBe(1)
    expect(c.compactions).toBe(0)
  })

  it('does not open a window for a /refine message or count blank lines and unknown entries', () => {
    const jsonl = [
      '',
      '{"type":"unknown_future_entry","x":1}',
      '{"type":"message","message":{"role":"user","content":"/refine --global","timestamp":1}}',
      '{"type":"message","message":{"role":"user","content":"Add function alpha and run the tests","timestamp":2}}',
      'not json',
    ].join('\n')
    const parsed = parsePrimeSession(jsonl, task, 0)
    expect(parsed.windows.map((w) => w.ran)).toEqual([true, false, false])
  })
})

describe('runMetrics', () => {
  it('averages recurrence over sessions that have one and skips the rest', () => {
    const metrics = runMetrics(
      record({
        category: 'cross-session',
        windows: [
          // session 0: hit at prompt 0, then 1 of 2 later prompts hits again -> 0.5
          win(0, 0, { trapHit: true }),
          win(0, 1, { trapHit: true }),
          win(0, 2),
          // session 1: never hit -> undefined, not 0
          win(1, 0),
          win(1, 1),
        ],
      }),
    )
    expect(metrics.recurrence).toBe(0.5)
  })

  it('counts only prompts that ran after the first hit', () => {
    const metrics = runMetrics(
      record({ windows: [win(0, 0, { trapHit: true }), win(0, 1), win(0, 2, { ran: false })] }),
    )
    expect(metrics.recurrence).toBe(0)
  })

  it('crossSessionAvoided is true only when session 2 ran and never hit the trap', () => {
    const avoided = (windows: PromptWindow[], category: RunRecord['category'] = 'cross-session') =>
      runMetrics(record({ category, windows })).crossSessionAvoided
    const s1 = [win(0, 0, { trapHit: true }), win(0, 1), win(0, 2)]
    expect(avoided([...s1, win(1, 0), win(1, 1), win(1, 2)])).toBe(true)
    expect(avoided([...s1, win(1, 0), win(1, 1, { trapHit: true }), win(1, 2)])).toBe(false)
    expect(
      avoided([...s1, win(1, 0, { ran: false }), win(1, 1, { ran: false }), win(1, 2, { ran: false })]),
    ).toBe(false)
    expect(avoided(s1)).toBe(false)
    expect(avoided([...s1, win(1, 0), win(1, 1), win(1, 2)], 'directory')).toBeNull()
  })
})

describe('toRunRecord', () => {
  const outcome = (over: Partial<RunOutcome> = {}): RunOutcome => ({
    runId: 'cross-demo.on.r3',
    sessions: [
      { exitCode: 0, timedOut: false, stdoutFile: 's0.out', sessionFiles: ['a.jsonl'] },
      { exitCode: 1, timedOut: false, stdoutFile: 's1.out', sessionFiles: ['b.jsonl'] },
    ],
    checks: [{ session: 0, prompt: 0, passed: true }],
    ...over,
  })
  const files: Record<string, string> = {
    'a.jsonl': fixture('prime-session-stdout-trap.jsonl'),
    'b.jsonl': fixture('prime-session-aborted-refine.jsonl'),
  }
  const usage = new Map([
    [
      'cross-demo.on.r3',
      {
        requests: 5,
        unknown: 1,
        tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
        costUsd: 0.5,
      },
    ],
  ])

  it('builds a record from the run id, the session files, the checks and the usage summary', () => {
    const rec = toRunRecord(crossTask, outcome(), usage, { readFile: (p) => files[p] as string })
    expect(rec).toMatchObject({
      system: 'prime',
      taskId: 'cross-demo',
      category: 'cross-session',
      setting: 'on',
      rep: 3,
      exit: 'error',
      harnessLookups: 3,
      compactions: 1,
      refine: { auto: 1, user: 1, self: 0, appliedEdits: 3 },
      usage: { requests: 5, unknown: 1, tokens: 100, costUsd: 0.5 },
    })
    expect(rec.windows).toHaveLength(6)
    expect(rec.windows[0]).toEqual({ session: 0, prompt: 0, ran: true, trapHit: true, checksPassed: true })
    // no check result for a prompt that ran -> unknown, not passed
    expect(rec.windows[1]?.checksPassed).toBeNull()
    expect(rec.windows[4]).toMatchObject({ session: 1, prompt: 1, ran: false, checksPassed: null })
  })

  it('maps timeouts and clean exits', () => {
    const read = { readFile: (p: string) => files[p] as string }
    const timedOut = outcome({
      sessions: [
        { exitCode: null, timedOut: true, stdoutFile: 'x', sessionFiles: ['a.jsonl'] },
        { exitCode: 0, timedOut: false, stdoutFile: 'y', sessionFiles: [] },
      ],
    })
    expect(toRunRecord(crossTask, timedOut, usage, read).exit).toBe('timeout')
    const clean = outcome({
      sessions: [
        { exitCode: 0, timedOut: false, stdoutFile: 'x', sessionFiles: ['a.jsonl'] },
        { exitCode: 0, timedOut: false, stdoutFile: 'y', sessionFiles: [] },
      ],
    })
    const rec = toRunRecord(crossTask, clean, new Map(), read)
    expect(rec.exit).toBe('ok')
    expect(rec.usage).toEqual({ requests: 0, unknown: 0, tokens: 0, costUsd: 0 })
    expect(rec.windows.filter((w) => w.session === 1).every((w) => !w.ran)).toBe(true)
  })
})

describe('buildReport', () => {
  const primeOf = (json: object) => JSON.parse(JSON.stringify(json)).systems.prime
  // A run whose first prompt hits the trap; `again` says whether the later prompts hit it again.
  const run = (
    taskId: string,
    setting: RunRecord['setting'],
    rep: number,
    again: boolean,
    over: Partial<RunRecord> = {},
  ): RunRecord =>
    record({
      taskId,
      setting,
      rep,
      windows: [win(0, 0, { trapHit: true }), win(0, 1, { trapHit: again }), win(0, 2, { trapHit: again })],
      usage: {
        requests: 4,
        unknown: 0,
        tokens: setting === 'on' ? 150 : 100,
        costUsd: setting === 'on' ? 1.5 : 1,
      },
      ...over,
    })

  const tasks = ['t1', 't2', 't3', 't4']
  const records = tasks.flatMap((id) => [
    run(id, 'on', 1, false, { refine: { auto: 1, user: 2, self: 0, appliedEdits: 3 }, harnessLookups: 2 }),
    run(id, 'on', 2, id === 't4', { compactions: 1 }),
    run(id, 'off', 1, true),
    run(id, 'off', 2, true, { exit: 'timeout' }),
  ])

  it('reports the three metrics with their directions and the criterion (1) verdict', () => {
    const { json, markdown } = buildReport(records, { resamples: 500 })
    const prime = primeOf(json)
    // off recurrence 1, on recurrence 0 (t1..t3) and 0.5 average for t4 -> mean difference 0.875
    expect(prime.repeatErrorDrop.difference.estimate).toBeCloseTo(0.875)
    expect(prime.repeatErrorDrop.difference.ci95[0]).toBeGreaterThan(0)
    expect(prime.criterion1.pass).toBe(true)
    expect(prime.costOverhead.tokens.relative.estimate).toBeCloseTo(0.5)
    expect(prime.costOverhead.costUsd.relative.estimate).toBeCloseTo(0.5)
    expect(prime.settings.on.refine).toEqual({ auto: 4, user: 8, self: 0, appliedEdits: 12 })
    expect(prime.settings.on.harnessLookups).toBe(8)
    expect(prime.settings.on.compactions).toBe(4)
    expect(prime.settings.off.exit).toEqual({ ok: 4, error: 0, timeout: 4 })
    expect(markdown).toContain('off minus on')
    expect(markdown).toContain('on minus off')
    expect(markdown).toContain('Verdict: PASS')
    expect(JSON.stringify(json)).not.toMatch(/\/Users|\/work|\/tmp/)
  })

  it('fails criterion (1) when the interval includes 0 and when nothing can be paired', () => {
    const noEffect = tasks.flatMap((id) => [run(id, 'on', 1, true), run(id, 'off', 1, true)])
    const flat = buildReport(noEffect, { resamples: 200 })
    expect(primeOf(flat.json).criterion1.pass).toBe(false)
    expect(flat.markdown).toContain('Verdict: FAIL')

    // trap never fires anywhere: every recurrence is undefined, so nothing is paired
    const silent = tasks.flatMap((id) => [
      run(id, 'on', 1, false, { windows: [win(0, 0), win(0, 1)] }),
      run(id, 'off', 1, false, { windows: [win(0, 0), win(0, 1)] }),
    ])
    const none = buildReport(silent, { resamples: 200 })
    const prime = primeOf(none.json)
    expect(prime.repeatErrorDrop.difference.estimate).toBeNull()
    expect(prime.repeatErrorDrop.difference.excludedRuns).toBe(8)
    expect(prime.criterion1).toMatchObject({ pass: false, evaluable: false })
    expect(none.markdown).toContain('NOT EVALUABLE')
  })

  it('uses only cross-session tasks for reuse and counts unknown usage', () => {
    const cross = (setting: RunRecord['setting'], avoided: boolean) =>
      record({
        taskId: 'x1',
        category: 'cross-session',
        setting,
        windows: [
          win(0, 0, { trapHit: true }),
          win(0, 1),
          win(1, 0, { trapHit: !avoided }),
          win(1, 1, { trapHit: !avoided }),
        ],
        usage: { requests: 3, unknown: 2, tokens: 10, costUsd: 0.1 },
      })
    const { json, markdown } = buildReport([
      cross('on', true),
      cross('off', false),
      run('d1', 'on', 1, false),
    ])
    const prime = primeOf(json)
    expect(prime.crossSessionReuse.difference.estimate).toBe(1)
    expect(prime.crossSessionReuse.difference.tasks).toBe(1)
    expect(prime.settings.on.usage.unknownRequests).toBe(2)
    expect(markdown).toContain('unknown usage')
  })
})
