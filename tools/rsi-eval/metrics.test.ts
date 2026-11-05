import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseAghSession, parsePrimeSession, runMetrics, toRunRecord } from './metrics.js'
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
  it('matches the trap in the output of a failed run and in stderr even when isError is false', () => {
    const parsed = parsePrimeSession(fixture('prime-session-stdout-trap.jsonl'), task, 0)
    expect(parsed.windows).toEqual([
      { session: 0, prompt: 0, ran: true, trapHit: true },
      { session: 0, prompt: 1, ran: true, trapHit: false },
      { session: 0, prompt: 2, ran: true, trapHit: true },
    ])
  })

  it('does not count reading the source or a successful run as a hit', () => {
    const parsed = parsePrimeSession(fixture('prime-session-source-read.jsonl'), task, 0)
    expect(parsed.windows.map((w) => w.trapHit)).toEqual([false, false, false])
  })

  it('counts a failed run, a repeated failure and ignores the success that follows', () => {
    const parsed = parsePrimeSession(fixture('prime-session-repeat-failure.jsonl'), task, 0)
    expect(parsed.windows.map((w) => w.trapHit)).toEqual([true, true, false])
    expect(
      runMetrics(record({ windows: parsed.windows.map((w) => ({ ...w, checksPassed: true })) })).recurrence,
    ).toBe(0.5)
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

// One AGH ledger row per line, as the AGH runner writes a session file.
const row = (seq: number, type: string, data: object, over: { lane?: string | null; origin?: string } = {}) =>
  JSON.stringify({
    seq,
    ts: '2026-11-03T00:00:00Z',
    type,
    lane: over.lane ?? 'main',
    origin: over.origin ?? 'user',
    data,
  })
const userText = (text: string) => ({ content: [{ type: 'text', text }] })
const toolText = (text: string, isError = false) => ({ content: [{ type: 'text', text }], isError })
const runRow = (seq: number, runId: string, state: string, extra: object = {}) =>
  row(
    seq,
    'x/core/refinement-run',
    { version: 1, runId, state, ...extra },
    { lane: 'refinement', origin: 'system' },
  )

const aghSession = [
  row(1, 'session/start', {}, { origin: 'system' }),
  row(2, 'user/message', userText('Add function alpha and run the tests')),
  row(
    3,
    'user/message',
    { kind: 'runtime_context', content: [{ type: 'text', text: 'Add function beta and run the tests' }] },
    { origin: 'system' },
  ),
  row(4, 'tool/call', { name: 'shell', toolUseId: 't1', args: { command: 'make test' } }),
  row(5, 'tool/result', {
    toolUseId: 't1',
    ...toolText('[stderr]\nerror: tests must be run from build/', true),
  }),
  runRow(6, 'r1', 'queued', { trigger: { kind: 'manual', seq: 5 } }),
  runRow(7, 'r1', 'planning'),
  runRow(8, 'r1', 'applied'),
  row(
    9,
    'harness/refine',
    { outcome: 'applied', runId: 'r1', edits: [{ op: 'upsert' }, { op: 'upsert' }] },
    { origin: 'system' },
  ),
  row(10, 'user/message', userText('Add function beta and run the tests')),
  row(11, 'tool/call', { name: 'harness_inspect', toolUseId: 't2' }),
  row(12, 'tool/result', toolText('ok, ran from build/: 3 passed')),
  runRow(13, 'r2', 'queued', { trigger: { kind: 'repeated-failure', seq: 12 } }),
  runRow(14, 'r2', 'planning'),
  runRow(15, 'r2', 'no-op'),
  runRow(16, 'r3', 'queued', { trigger: { kind: 'compaction', seq: 12 } }),
  runRow(17, 'r3', 'superseded'),
  runRow(18, 'r4', 'proposed', { trigger: { kind: 'model', seq: 12 } }),
  row(
    19,
    'harness/refine',
    { outcome: 'applied', rollbackOf: 9, edits: [{ op: 'upsert' }] },
    { origin: 'system' },
  ),
  row(20, 'harness/refine', { outcome: 'rejected', edits: [{ op: 'upsert' }] }, { origin: 'system' }),
  row(21, 'x/core/compaction-end', {}, { origin: 'system' }),
  row(
    22,
    'tool/result',
    { toolUseId: 't1', ...toolText('[stderr]\ntests must be run from build/', true) },
    { lane: 'child' },
  ),
  'not json',
  '',
].join('\n')

describe('parseAghSession', () => {
  it("opens windows at the user's own prompts and reads the trap from main-lane tool results", () => {
    const parsed = parseAghSession(aghSession, task, 0)
    expect(parsed.windows).toEqual([
      { session: 0, prompt: 0, ran: true, trapHit: true },
      { session: 0, prompt: 1, ran: true, trapHit: false },
      { session: 0, prompt: 2, ran: false, trapHit: false },
    ])
    expect(parsed.harnessLookups).toBe(1)
    expect(parsed.compactions).toBe(1)
  })

  describe('trap hits are failed runs, not reads', () => {
    const SOURCE = "def fail():\n    print('error: tests must be run from build/', file=sys.stderr)\n"
    const FAILED = '\n\n[stderr]\nerror: tests must be run from build/\n\n[exit 2]'
    const windowsOf = (...calls: { name: string; command?: string; text: string; isError?: boolean }[]) => {
      // One prompt per call, so each call's hit shows in its own window.
      const rows = calls.flatMap((c, i) => [
        row(
          10 * i + 1,
          'user/message',
          userText(`Add function ${['alpha', 'beta', 'gamma'][i]} and run the tests`),
        ),
        row(10 * i + 2, 'tool/call', {
          name: c.name,
          toolUseId: `u${i}`,
          args: c.command ? { command: c.command } : { path: 'Makefile' },
        }),
        row(
          10 * i + 3,
          'tool/result',
          { toolUseId: `u${i}`, ...toolText(c.text, c.isError ?? false) },
          { origin: `tool:${c.name}` },
        ),
      ])
      return parseAghSession(rows.join('\n'), task, 0).windows.map((w) => w.trapHit)
    }

    it('does not count the read tool printing the source', () => {
      expect(windowsOf({ name: 'read', text: `1\t${SOURCE}` })).toEqual([false, false, false])
    })

    it('does not count cat of the source in a shell', () => {
      expect(
        windowsOf({ name: 'shell', command: 'cat Makefile', text: `${SOURCE}\n\n[stderr]\n\n[exit 0]` }),
      ).toEqual([false, false, false])
    })

    it('does not count a reader command in a run that failed for another reason', () => {
      const text = `${SOURCE}\n[stderr]\ncat: nope: No such file or directory\n\n[exit 1]`
      expect(windowsOf({ name: 'shell', command: 'cat Makefile; cat nope', text, isError: true })).toEqual([
        false,
        false,
        false,
      ])
    })

    it('counts a real failing run: the signature on stderr, or a failed run that printed it', () => {
      expect(windowsOf({ name: 'shell', command: 'make test', text: `${FAILED}`, isError: true })).toEqual([
        true,
        false,
        false,
      ])
      // stderr merged into stdout, and the failure shows in the printed exit code
      expect(
        windowsOf({
          name: 'shell',
          command: 'make test 2>&1; echo "exit=$?"',
          text: 'error: tests must be run from build/\nexit=2\n\n[stderr]\n\n[exit 0]',
        }),
      ).toEqual([true, false, false])
    })

    it('counts the repeat of a failing run, and not the success after it', () => {
      expect(
        windowsOf(
          { name: 'shell', command: 'make test', text: FAILED, isError: true },
          { name: 'shell', command: 'make test', text: FAILED, isError: true },
          { name: 'shell', command: 'make -C build test', text: '3 passed\n\n[stderr]\n\n[exit 0]' },
        ),
      ).toEqual([true, true, false])
    })
  })

  it('counts reviews that reached planning by what started them, and edits of applied reviews only', () => {
    // r1 manual -> user, r2 repeated failure -> auto, r3 never planned, r4 a direct proposal -> self.
    // Edits: r1's two; the withdrawal and the rejected review add none.
    expect(parseAghSession(aghSession, task, 0).refine).toEqual({
      auto: 1,
      user: 1,
      self: 1,
      appliedEdits: 2,
    })
  })

  it('ignores review rows that the system did not write', () => {
    const forged = [
      row(
        1,
        'x/core/refinement-run',
        { version: 1, runId: 'f', state: 'queued', trigger: { kind: 'manual', seq: 1 } },
        { lane: 'refinement' },
      ),
      row(2, 'x/core/refinement-run', { version: 1, runId: 'f', state: 'planning' }, { lane: 'refinement' }),
    ].join('\n')
    expect(parseAghSession(forged, task, 0).refine).toEqual({ auto: 0, user: 0, self: 0, appliedEdits: 0 })
  })

  it('is used for an outcome the AGH runner wrote', () => {
    const outcome: RunOutcome = {
      runId: 'dir-demo.on.r1',
      system: 'agh',
      sessions: [{ exitCode: 0, timedOut: false, stdoutFile: 's.out', sessionFiles: ['s1.events.jsonl'] }],
      checks: [{ session: 0, prompt: 0, passed: true }],
    }
    const rec = toRunRecord(task, outcome, new Map(), { system: 'agh', readFile: () => aghSession })
    expect(rec).toMatchObject({
      system: 'agh',
      exit: 'ok',
      refine: { auto: 1, user: 1, self: 1, appliedEdits: 2 },
    })
    expect(rec.windows[0]).toEqual({ session: 0, prompt: 0, ran: true, trapHit: true, checksPassed: true })
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

  it('crossSessionAvoided needs a first-session failure, then a clean second session that ran', () => {
    const avoided = (windows: PromptWindow[], category: RunRecord['category'] = 'cross-session') =>
      runMetrics(record({ category, windows })).crossSessionAvoided
    const s1 = [win(0, 0, { trapHit: true }), win(0, 1), win(0, 2)]
    expect(avoided([...s1, win(1, 0), win(1, 1), win(1, 2)])).toBe(true)
    expect(avoided([...s1, win(1, 0), win(1, 1, { trapHit: true }), win(1, 2)])).toBe(false)
    expect(
      avoided([...s1, win(1, 0, { ran: false }), win(1, 1, { ran: false }), win(1, 2, { ran: false })]),
    ).toBe(false)
    expect(avoided(s1)).toBe(false)
    // no real failure in session 1: nothing to avoid, so the value is undefined, not true
    expect(avoided([win(0, 0), win(0, 1), win(0, 2), win(1, 0), win(1, 1), win(1, 2)])).toBeNull()
    expect(avoided([...s1, win(1, 0), win(1, 1), win(1, 2)], 'directory')).toBeNull()
    expect(avoided([...s1, win(1, 0), win(1, 1), win(1, 2)], 'cross-workspace')).toBeNull()
  })

  it('crossWorkspaceAvoided needs a first-session hit to learn from, then a clean second session', () => {
    const avoided = (windows: PromptWindow[], category: RunRecord['category'] = 'cross-workspace') =>
      runMetrics(record({ category, windows })).crossWorkspaceAvoided
    const s1 = [win(0, 0, { trapHit: true }), win(0, 1), win(0, 2)]
    const clean = [win(1, 0), win(1, 1), win(1, 2)]
    expect(avoided([...s1, ...clean])).toBe(true)
    expect(avoided([...s1, win(1, 0, { trapHit: true }), win(1, 1), win(1, 2)])).toBe(false)
    expect(avoided([...s1, win(1, 0, { ran: false }), win(1, 1, { ran: false })])).toBe(false)
    // Nothing was learned in the first workspace: the run says nothing about reuse.
    expect(avoided([win(0, 0), win(0, 1), win(0, 2), ...clean])).toBeNull()
    expect(avoided([...s1, ...clean], 'cross-session')).toBeNull()
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

  it('carries the alignment a runner wrote', () => {
    const read = { readFile: (p: string) => files[p] as string }
    expect(toRunRecord(crossTask, outcome({ alignment: 'auto-only' }), usage, read).alignment).toBe(
      'auto-only',
    )
    expect(toRunRecord(crossTask, outcome(), usage, read)).not.toHaveProperty('alignment')
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

  it('reports the three metrics with their directions and the old criterion (1) verdict next to the new one', () => {
    const { json, markdown } = buildReport(records, { resamples: 500 })
    const prime = primeOf(json)
    // off recurrence 1, on recurrence 0 (t1..t3) and 0.5 average for t4 -> mean difference 0.875
    expect(prime.repeatErrorDrop.difference.estimate).toBeCloseTo(0.875)
    expect(prime.repeatErrorDrop.difference.ci95[0]).toBeGreaterThan(0)
    expect(prime.previousCriterion1.pass).toBe(true)
    // These runs have no session after the first, so the capture rate the criterion is now judged on is absent.
    expect(prime.criterion1).toMatchObject({ pass: false, evaluable: false })
    expect(prime.costOverhead.tokens.relative.estimate).toBeCloseTo(0.5)
    expect(prime.costOverhead.costUsd.relative.estimate).toBeCloseTo(0.5)
    expect(prime.settings.on.refine).toEqual({ auto: 4, user: 8, self: 0, appliedEdits: 12 })
    expect(prime.settings.on.harnessLookups).toBe(8)
    expect(prime.settings.on.compactions).toBe(4)
    expect(prime.settings.off.exit).toEqual({ ok: 4, error: 0, timeout: 4 })
    expect(markdown).toContain('off minus on')
    expect(markdown).toContain('on minus off')
    expect(markdown).toContain('Verdict under it: PASS')
    expect(JSON.stringify(json)).not.toMatch(/\/Users|\/work|\/tmp/)
  })

  it('fails the old criterion (1) when the interval includes 0 and when nothing can be paired', () => {
    const noEffect = tasks.flatMap((id) => [run(id, 'on', 1, true), run(id, 'off', 1, true)])
    const flat = buildReport(noEffect, { resamples: 200 })
    expect(primeOf(flat.json).previousCriterion1.pass).toBe(false)
    expect(flat.markdown).toContain('Verdict under it: FAIL')

    // trap never fires anywhere: every recurrence is undefined, so nothing is paired
    const silent = tasks.flatMap((id) => [
      run(id, 'on', 1, false, { windows: [win(0, 0), win(0, 1)] }),
      run(id, 'off', 1, false, { windows: [win(0, 0), win(0, 1)] }),
    ])
    const none = buildReport(silent, { resamples: 200 })
    const prime = primeOf(none.json)
    expect(prime.repeatErrorDrop.difference.estimate).toBeNull()
    expect(prime.repeatErrorDrop.difference.excludedRuns).toBe(8)
    expect(prime.previousCriterion1).toMatchObject({ pass: false, evaluable: false })
    expect(none.markdown).toContain('Verdict under it: NOT EVALUABLE (no paired tasks)')
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

  it('report lists cross-workspace separately and marks auto-only alignment', () => {
    const reuse = (
      taskId: string,
      category: RunRecord['category'],
      setting: RunRecord['setting'],
      avoided: boolean,
      over: Partial<RunRecord> = {},
    ) =>
      record({
        taskId,
        category,
        setting,
        windows: [
          win(0, 0, { trapHit: true }),
          win(0, 1),
          win(1, 0, { trapHit: !avoided }),
          win(1, 1, { trapHit: !avoided }),
        ],
        ...over,
      })
    const records = [
      reuse('c1', 'cross-session', 'on', false),
      reuse('c1', 'cross-session', 'off', false),
      reuse('w1', 'cross-workspace', 'on', true),
      reuse('w1', 'cross-workspace', 'off', false),
      reuse('w2', 'cross-workspace', 'on', true),
      reuse('w2', 'cross-workspace', 'off', true),
    ]
    const prime = primeOf(buildReport(records, { resamples: 200 }).json)
    expect(prime.crossSessionReuse.difference).toMatchObject({ estimate: 0, tasks: 1 })
    expect(prime.crossWorkspaceReuse).toMatchObject({
      avoidedOn: 1,
      avoidedOff: 0.5,
      difference: { estimate: 0.5, tasks: 2 },
      autoOnlyRuns: 0,
    })
    const plain = buildReport(records, { resamples: 200 }).markdown
    expect(plain).toContain('Cross-workspace reuse')
    expect(plain).not.toContain('auto-only')

    const agh = records.map((r) =>
      r.category === 'cross-workspace' && r.setting === 'on'
        ? { ...r, system: 'agh' as const, alignment: 'auto-only' as const }
        : { ...r, system: 'agh' as const },
    )
    const { json, markdown } = buildReport(agh, { resamples: 200 })
    expect(JSON.parse(JSON.stringify(json)).systems.agh.crossWorkspaceReuse.autoOnlyRuns).toBe(2)
    expect(markdown).toMatch(/2 on runs are auto-only/)
  })
})
