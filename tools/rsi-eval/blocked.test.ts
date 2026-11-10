import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { blockedExcluded, blockedReasons, blockedRun } from './blocked.js'
import { buildReport } from './report.js'
import type { RunRecord } from './types.js'

// The ledger rows are a real run's (fixtures/real): the first turn of long-01's on run in the long-task
// probe, which the host's verifier first asked to repair and then ended blocked (tool_call_as_text), and
// a turn of cross-01's off run that completed.
const rows = (name: string) =>
  readFileSync(join(import.meta.dirname, 'fixtures', 'real', name), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { seq: number; type: string; data: unknown })

describe('a turn the host verifier blocked', () => {
  const blocked = rows('blocked.long-01.on-s1.jsonl')

  it('is read from the ledger with the reasons of the recovery that blocked it', () => {
    expect(blockedReasons(blocked)).toEqual(['tool_call_as_text'])
  })

  it('is not a turn the verifier only asked to repair, nor one that completed', () => {
    // Up to the first repair and the passing checks after it: the turn went on.
    expect(blockedReasons(blocked.filter((r) => r.seq <= 1925))).toBeUndefined()
    expect(blockedReasons(rows('turns-completed.cross-01.off-s1.jsonl'))).toBeUndefined()
  })

  it('names the prompt the runner saw end blocked, as the real outcome recorded it', () => {
    const outcome = JSON.parse(
      readFileSync(join(import.meta.dirname, 'fixtures', 'real', 'blocked.long-01.on.outcome.json'), 'utf8'),
    ) as { prompts: { session: number; prompt: number; reason: string }[] }
    expect(blockedRun(outcome.prompts, () => blocked)).toEqual({
      session: 0,
      prompt: 0,
      reasons: ['tool_call_as_text'],
    })
    expect(blockedRun([{ session: 0, prompt: 0, reason: 'completed' }], () => blocked)).toBeUndefined()
  })
})

describe('blocked runs in the report', () => {
  const record = (setting: RunRecord['setting'], rep: number, over: Partial<RunRecord> = {}): RunRecord => ({
    system: 'agh',
    taskId: 'long-01-release-train',
    category: 'long',
    setting,
    rep,
    exit: 'ok',
    windows: [{ session: 0, prompt: 0, ran: true, trapHit: true, checksPassed: true }],
    refine: { auto: 0, user: 0, self: 0, appliedEdits: 0 },
    harnessLookups: 0,
    compactions: 0,
    usage: { requests: 10, unknown: 0, tokens: 100, costUsd: 0.01 },
    ...over,
  })
  const stop = { blocked: { session: 0, prompt: 0, reasons: ['tool_call_as_text'] }, exit: 'error' as const }
  const records = [
    record('on', 1, stop),
    record('on', 2),
    record('off', 1),
    record('off', 2),
    record('frozen', 1, stop),
  ]

  it('are left out of every metric and listed per arm with their reasons', () => {
    const { json, markdown } = buildReport(records, { resamples: 50 })
    const agh = (json as { systems: { agh: { runs: { on: number; off: number } } } }).systems.agh
    expect(agh.runs).toMatchObject({ on: 1, off: 2 })
    expect((json as { blockedExcluded?: unknown }).blockedExcluded).toEqual({
      agh: { byArm: { on: 1, off: 0, oracle: 0, frozen: 1 }, reasons: { tool_call_as_text: 2 } },
    })
    expect(markdown).toContain("Runs the host's own turn verifier blocked")
    expect(markdown).toContain('on 1, off 0, oracle 0, frozen 1')
    expect(blockedExcluded(records.filter((r) => !r.blocked))).toBeUndefined()
  })
})
