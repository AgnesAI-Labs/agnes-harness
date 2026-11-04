import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { toRunRecord } from './metrics.js'
import { buildReport, latestAttempts } from './report.js'
import type { EvalTask, PromptWindow, RunOutcome, RunRecord } from './types.js'

// The outcome and ledger rows are the first evaluation's `xws-03` run of which the provider ended the
// second session with HTTP 402 after a clean first one (fixtures/real). Its outcome as the runner now writes
// it carries `infraFailed`; the first evaluation recorded it as a plain failed run (exit 1, no checks).
const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'real')
const outcome402 = JSON.parse(
  readFileSync(join(fixtures, 'infra-402.xws-03.off.outcome.json'), 'utf8'),
) as RunOutcome

const task: EvalTask = {
  id: 'xws-03-day-first-dates',
  category: 'cross-workspace',
  description: 'd',
  trap: { signatures: ['x'], reproduce: 'true', note: 'n' },
  sessions: [1, 2].map(() => ({
    prompts: ['a', 'b', 'c'].map((text) => ({ text, checks: [], solution: [] })),
  })),
}

const win = (session: number, prompt: number, trapHit = false): PromptWindow => ({
  session,
  prompt,
  ran: true,
  trapHit,
  checksPassed: true,
})
const record = (
  taskId: string,
  setting: RunRecord['setting'],
  rep: number,
  over: Partial<RunRecord> = {},
): RunRecord => ({
  system: 'agh',
  taskId,
  category: 'cross-session',
  setting,
  rep,
  exit: 'ok',
  windows: [win(0, 0, true), win(0, 1), win(0, 2), win(1, 0), win(1, 1), win(1, 2)],
  refine: { auto: 0, user: 0, self: 0, appliedEdits: 0 },
  harnessLookups: 0,
  compactions: 0,
  usage: { requests: 10, unknown: 0, tokens: 1000, costUsd: 0.01 },
  ...over,
})

type Json = {
  infraExcluded?: Record<string, { on: number; off: number; oracle: number; reasons: Record<string, number> }>
  run?: { upstream: string; pricesAssumed?: boolean }
  systems: {
    agh: {
      runs: { on: number; off: number }
      firstSessionTrap: {
        byArm: Record<string, { runs: number; hit: number }>
        noHit: string[]
        tasks: { taskId: string; on: { runs: number; hit: number }; off: { runs: number; hit: number } }[]
      }
    }
  }
}
const report = (records: RunRecord[], run?: Parameters<typeof buildReport>[1]) => {
  const built = buildReport(records, { resamples: 100, ...run })
  return { json: built.json as Json, markdown: built.markdown }
}

describe('a run the upstream ended', () => {
  const ended: RunOutcome = {
    ...outcome402,
    infraFailed: { session: 1, reason: 'QUOTA (HTTP 402)', status: 402 },
  }
  const failed = toRunRecord(task, ended, new Map(), { system: 'agh', readFile: () => '' })
  const good = [
    ...[1, 2].map((rep) => record('cross-a', 'off', rep)),
    ...[1, 2].map((rep) => record('cross-a', 'on', rep)),
  ]

  it('is carried from the outcome into the record', () => {
    expect(failed.infraFailed).toEqual({ session: 1, reason: 'QUOTA (HTTP 402)', status: 402 })
    expect(
      toRunRecord(task, outcome402, new Map(), { system: 'agh', readFile: () => '' }).infraFailed,
    ).toBeUndefined()
  })

  it('is left out of every metric: the report is the same with and without it', () => {
    const withIt = report([...good, failed])
    const without = report(good)
    expect(withIt.json.systems).toEqual(without.json.systems)
    expect(withIt.json.systems.agh.runs).toEqual({ on: 2, off: 2 })
  })

  it('is counted per arm, with its reason, in the report', () => {
    const { json, markdown } = report([...good, failed, { ...failed, rep: 2 }, { ...failed, setting: 'on' }])
    expect(json.infraExcluded?.agh).toEqual({ on: 1, off: 2, oracle: 0, reasons: { 'QUOTA (HTTP 402)': 3 } })
    expect(markdown).toContain('left out of every metric below: on 1, off 2, oracle 0')
    expect(markdown).toContain('QUOTA (HTTP 402) x3')
  })

  it('leaves the report as it was when no run was ended that way', () => {
    const { json, markdown } = report(good)
    expect(json.infraExcluded).toBeUndefined()
    expect(markdown).not.toContain('upstream ended')
  })
})

describe('the usage of a redone run', () => {
  it('is that of its latest attempt', () => {
    const usage = (requests: number) => ({
      requests,
      unknown: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0,
    })
    const map = latestAttempts(
      new Map([
        ['t.off.r1', usage(5)],
        ['t.off.r1~a1', usage(7)],
        ['t.off.r1~a2', usage(9)],
        ['u.on.r1', usage(3)],
      ]),
    )
    expect(map.get('t.off.r1')?.requests).toBe(9)
    expect(map.get('u.on.r1')?.requests).toBe(3)
  })
})

describe('first-session trap hits', () => {
  const noTrap = (setting: RunRecord['setting'], rep: number) =>
    record('cross-quiet', setting, rep, { windows: [win(0, 0), win(0, 1), win(0, 2), win(1, 0)] })
  const records = [
    record('cross-a', 'off', 1),
    record('cross-a', 'off', 2),
    record('cross-a', 'on', 1),
    noTrap('off', 1),
    noTrap('on', 1),
    record('wf-a', 'on', 1, { category: 'workflow' }),
  ]

  it('is given per arm and per task, and names the tasks that never hit the trap', () => {
    const { json, markdown } = report(records)
    const t = json.systems.agh.firstSessionTrap
    expect(t.byArm.off).toEqual({ runs: 3, hit: 2 })
    expect(t.byArm.on).toEqual({ runs: 2, hit: 1 })
    expect(t.noHit).toEqual(['cross-quiet'])
    expect(t.tasks.find((x) => x.taskId === 'cross-a')).toMatchObject({
      off: { runs: 2, hit: 2 },
      on: { runs: 1, hit: 1 },
    })
    // The workflow task has no defined trap hit and is not in the table.
    expect(t.tasks.map((x) => x.taskId)).toEqual(['cross-a', 'cross-quiet'])
    expect(markdown).toContain('never hit the trap in any run: 1 (cross-quiet)')
    expect(markdown).toContain('| cross-a | 1/1 | 2/2 |')
  })
})

describe('the report header', () => {
  const run = {
    provider: 'deepseek',
    api: 'anthropic-messages',
    upstream: 'https://user:pw@api.example.test/anthropic/?key=secret',
    model: 'deepseek-chat',
    prices: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 },
  }
  const records = [record('cross-a', 'off', 1)]

  it('names the model, route, upstream and prices, without credentials from the upstream address', () => {
    const { json, markdown } = report(records, { run })
    expect(markdown).toContain(
      'Run: model deepseek-chat through route deepseek (anthropic-messages) at https://api.example.test/anthropic.',
    )
    expect(markdown).toContain('input 0.27, output 1.1, cache read 0.07, cache write 0.27')
    expect(markdown).not.toContain('ASSUMED')
    expect(JSON.stringify(json)).not.toContain('secret')
    expect(JSON.stringify(json)).not.toContain('pw@')
  })

  it('flags prices the config says are assumed', () => {
    const { json, markdown } = report(records, { run: { ...run, pricesAssumed: true } })
    expect(markdown).toContain('ASSUMED')
    expect(json.run?.pricesAssumed).toBe(true)
  })

  it('adds nothing without a configuration', () => {
    expect(report(records).markdown).not.toContain('Run: model')
  })
})
