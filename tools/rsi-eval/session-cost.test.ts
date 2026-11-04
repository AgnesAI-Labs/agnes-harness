import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sessionCost, sessionCostOfLedger, toRunRecord } from './metrics.js'
import type { EvalTask, RunOutcome } from './types.js'

// The ledgers below are the cost rows of real sessions of the first evaluation (the other rows and the
// bulky response details are cut). The expected figures were summed from the rows outside this code:
// one request per `cost/ledger` row of any lane, tokens as input + output + cacheRead + cacheWrite,
// cost as the rows' `billing.usdMicros`.
const fixture = (name: string): string =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'real', name), 'utf8')

describe('the cost of one session, from its ledger', () => {
  it('sums every cost row of the session, in every lane', () => {
    expect(sessionCostOfLedger(fixture('session-cost.cross-01.on-s2.jsonl'))).toEqual({
      requests: 21,
      tokens: 125_056,
      cost: 0.012566,
      lowerBound: false,
      // Three of the 21 requests are review calls in the refinement lane.
      refinement: { requests: 3, tokens: 6839, cost: 0.002118 },
    })
    expect(sessionCostOfLedger(fixture('session-cost.cross-01.off-s2.jsonl'))).toEqual({
      requests: 17,
      tokens: 124_155,
      cost: 0.010802,
      lowerBound: false,
      refinement: { requests: 0, tokens: 0, cost: 0 },
    })
  })

  it('is a lower bound when the session had children whose cost is not in its ledger', () => {
    // `subagent/cost` rows name the child session and say its cost is incomplete; they carry no amount.
    expect(sessionCostOfLedger(fixture('session-cost.wf-01.on-s1.jsonl'))).toEqual({
      requests: 37,
      tokens: 596_996,
      cost: 0.068015,
      lowerBound: true,
      refinement: { requests: 3, tokens: 43_804, cost: 0.013657 },
    })
  })

  it('is empty for a ledger with no cost rows', () => {
    expect(sessionCostOfLedger('')).toEqual({
      requests: 0,
      tokens: 0,
      cost: 0,
      lowerBound: false,
      refinement: { requests: 0, tokens: 0, cost: 0 },
    })
  })

  it('ignores a row that is not JSON, and a cost row without a price counts as a lower bound', () => {
    const row = JSON.stringify({
      seq: 1,
      type: 'cost/ledger',
      lane: 'main',
      data: { purpose: 'inference', tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } },
    })
    expect(sessionCostOfLedger(`not json\n${row}\n`)).toEqual({
      requests: 1,
      tokens: 15,
      cost: 0,
      lowerBound: true,
      refinement: { requests: 0, tokens: 0, cost: 0 },
    })
  })
})

describe('sessionCost(run, session)', () => {
  const task: EvalTask = {
    id: 'cross-01-build-subdir',
    category: 'cross-session',
    description: 'd',
    trap: { signatures: ['x'], reproduce: 'true', note: 'n' },
    sessions: [1, 2].map(() => ({
      prompts: [1, 2, 3].map((n) => ({ text: `p${n}`, checks: [], solution: [] })),
    })),
  }
  const outcome: RunOutcome = {
    runId: 'cross-01-build-subdir.on.r1',
    system: 'agh',
    sessions: [
      { exitCode: 0, timedOut: false, stdoutFile: 'a', sessionFiles: ['s1.jsonl'] },
      { exitCode: 0, timedOut: false, stdoutFile: 'b', sessionFiles: ['s2.jsonl'] },
    ],
    checks: [],
  }
  const files: Record<string, string> = {
    's1.jsonl': fixture('session-cost.cross-01.off-s2.jsonl'),
    's2.jsonl': fixture('session-cost.cross-01.on-s2.jsonl'),
  }
  const record = toRunRecord(task, outcome, new Map(), {
    system: 'agh',
    readFile: (path) => files[path] ?? '',
  })

  it('reads each session of an AGH run from its own ledger', () => {
    expect(sessionCost(record, 0)).toMatchObject({ requests: 17, tokens: 124_155 })
    expect(sessionCost(record, 1)).toMatchObject({ requests: 21, tokens: 125_056 })
  })

  it('has no cost for a session the task does not have, nor for a Prime run', () => {
    expect(sessionCost(record, 2)).toBeUndefined()
    const { system: _agh, ...unmarked } = outcome
    const prime = toRunRecord(task, unmarked, new Map(), { readFile: () => '' })
    expect(sessionCost(prime, 1)).toBeUndefined()
  })
})
