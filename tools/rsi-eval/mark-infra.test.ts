import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { markInfraFailures } from './mark-infra.js'
import type { RunOutcome } from './types.js'

// Folders assembled from the first evaluation's own outcome files and ledger rows (fixtures/real): the two
// runs HTTP 402 ended (as that evaluation recorded them, without any mark) and one that ended cleanly.
const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'real')
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const folder = (): string => {
  const out = mkdtempSync(join(tmpdir(), 'rsi-mark-infra-'))
  dirs.push(out)
  const put = (run: string, outcome: string, ledgers: Record<string, string>) => {
    mkdirSync(join(out, run, 'sessions'), { recursive: true })
    cpSync(join(fixtures, outcome), join(out, run, 'outcome.json'))
    for (const [s, name] of Object.entries(ledgers))
      cpSync(join(fixtures, name), join(out, run, 'sessions', `${s}.events.jsonl`))
  }
  put('xws-05-internal-registry.off.r2', 'infra-402.xws-05.off.outcome.json', {
    s1: 'infra-402.xws-05.off-s1.jsonl',
  })
  // Its first session completed, the second was ended by 402.
  put('xws-03-day-first-dates.off.r2', 'infra-402.xws-03.off.outcome.json', {
    s1: 'turns-completed.cross-01.off-s1.jsonl',
    s2: 'infra-402.xws-03.off-s2.jsonl',
  })
  // A run that ended cleanly: every session exit 0.
  mkdirSync(join(out, 'clean.off.r1'), { recursive: true })
  const clean: RunOutcome = {
    runId: 'clean.off.r1',
    system: 'agh',
    sessions: [{ exitCode: 0, timedOut: false, stdoutFile: 'x', sessionFiles: [] }],
    checks: [],
  }
  writeFileSync(join(out, 'clean.off.r1', 'outcome.json'), JSON.stringify(clean))
  return out
}
const outcomeOf = (out: string, run: string): RunOutcome =>
  JSON.parse(readFileSync(join(out, run, 'outcome.json'), 'utf8')) as RunOutcome

describe('marking the runs the upstream ended', () => {
  it('recognises the first evaluation runs that HTTP 402 ended, in the session it hit', () => {
    const out = folder()
    const result = markInfraFailures(out)
    expect(result.marked.map((m) => m.runId).sort()).toEqual([
      'xws-03-day-first-dates.off.r2',
      'xws-05-internal-registry.off.r2',
    ])
    expect(outcomeOf(out, 'xws-05-internal-registry.off.r2').infraFailed).toEqual({
      session: 0,
      reason: 'QUOTA (HTTP 402)',
      status: 402,
    })
    expect(outcomeOf(out, 'xws-03-day-first-dates.off.r2').infraFailed).toMatchObject({
      session: 1,
      status: 402,
    })
  })

  it('leaves a clean run alone and does nothing the second time', () => {
    const out = folder()
    markInfraFailures(out)
    expect(outcomeOf(out, 'clean.off.r1').infraFailed).toBeUndefined()
    const again = markInfraFailures(out)
    expect(again.marked).toEqual([])
    expect(again.already).toHaveLength(2)
  })

  it('changes nothing in a dry run', () => {
    const out = folder()
    expect(markInfraFailures(out, { dryRun: true }).marked).toHaveLength(2)
    expect(outcomeOf(out, 'xws-05-internal-registry.off.r2').infraFailed).toBeUndefined()
  })

  it('does not mark a run that failed without an infrastructure error in its ledger', () => {
    const out = folder()
    rmSync(join(out, 'xws-05-internal-registry.off.r2', 'sessions'), { recursive: true })
    expect(markInfraFailures(out).marked.map((m) => m.runId)).toEqual(['xws-03-day-first-dates.off.r2'])
  })
})
