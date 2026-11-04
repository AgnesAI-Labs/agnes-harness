import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { AGH_DIR } from '../../packages/protocol/src/constants.js'
import {
  firstSessionCheck,
  offWritesNoSkill,
  oracleMemoryChecks,
  skillChecks,
  workflowCheck,
} from './smoke-check.js'
import { defaultTasksDir, loadSuite } from './suite.js'

// The ledgers are trimmed rows of the first evaluation's runs (see fixtures/real). The checks read a run
// folder the way the runner leaves it; here the folders are assembled from those rows, with nothing a
// real run would add, so these tests show that each check can say both PASS and FAIL.
const real = (name: string): string =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'real', name), 'utf8')
const tasks = loadSuite(defaultTasksDir)
const byId = (id: string) => tasks.find((t) => t.id === id) as (typeof tasks)[number]
const cross = byId('cross-01-build-subdir')
const wf = byId('wf-01-release-channel')

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const runDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'rsi-smoke-check-'))
  dirs.push(dir)
  return dir
}
const put = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const outcome = (run: string, system = 'agh') =>
  JSON.stringify({
    runId: run,
    system,
    sessions: [1, 2].map((n) => ({
      exitCode: 0,
      timedOut: false,
      stdoutFile: 'x',
      sessionFiles: [`sessions/s${n}.events.jsonl`],
    })),
    checks: [],
  })

describe('the workflow check', () => {
  it('passes when the first session finished a workflow run, though every call said unknown outcome', () => {
    const dir = runDir()
    const run = 'wf-01-release-channel.on.r1'
    put(join(dir, run, 'outcome.json'), outcome(run))
    put(join(dir, run, 'sessions', 's1.events.jsonl'), real('wf-unknown-outcome.off-s1.jsonl'))
    put(join(dir, run, 'sessions', 's2.events.jsonl'), '')
    expect(workflowCheck(dir, [wf], run)).toMatchObject({ status: 'PASS' })
  })
  it('fails when it did not', () => {
    const dir = runDir()
    const run = 'wf-01-release-channel.on.r1'
    put(join(dir, run, 'outcome.json'), outcome(run))
    put(join(dir, run, 'sessions', 's1.events.jsonl'), '')
    put(join(dir, run, 'sessions', 's2.events.jsonl'), '')
    expect(workflowCheck(dir, [wf], run)).toMatchObject({ status: 'FAIL' })
  })
})

describe('the first session check', () => {
  const head = real('session1-head.cross-01.off.jsonl')
  it('passes for two runs that started alike, whatever their run ids', () => {
    const dir = runDir()
    put(join(dir, 'x.off.r1', 'sessions', 's1.events.jsonl'), head)
    put(join(dir, 'x.oracle.r1', 'sessions', 's1.events.jsonl'), head.replaceAll('.off.', '.oracle.'))
    expect(firstSessionCheck(dir, 'x.oracle.r1', 'x.off.r1')).toMatchObject({ status: 'PASS' })
  })
  it('fails when a prompt, the tool schema or the first request differs', () => {
    const dir = runDir()
    put(join(dir, 'x.off.r1', 'sessions', 's1.events.jsonl'), head)
    const prompt = JSON.parse(head.split('\n')[1] as string).data.content[0].text as string
    for (const [from, to] of [
      [prompt.slice(0, 12), 'A different prompt'],
      ['"tool_schema_hash": "', '"tool_schema_hash": "0'],
      ['"total": ', '"total": 1'],
    ] as const) {
      expect(head).toContain(from)
      put(join(dir, 'x.oracle.r1', 'sessions', 's1.events.jsonl'), head.replace(from, to))
      expect(firstSessionCheck(dir, 'x.oracle.r1', 'x.off.r1')).toMatchObject({ status: 'FAIL' })
    }
  })
})

describe('the oracle memory checks', () => {
  const stamp = (iso: string) =>
    JSON.stringify({ seq: 1, ts: iso, type: 'session/start', lane: 'main', origin: 'system', data: {} })
  const setup = (writtenAt: string, withLesson = true) => {
    const dir = runDir()
    const oracle = 'cross-01-build-subdir.oracle.r1'
    const off = 'cross-01-build-subdir.off.r1'
    put(join(dir, oracle, 'sessions', 's1.events.jsonl'), `${stamp('2026-11-05T10:00:00.000Z')}\n`)
    put(join(dir, oracle, 'sessions', 's2.events.jsonl'), `${stamp('2026-11-05T10:05:00.000Z')}\n`)
    const index = join(dir, oracle, 'home', 'memory', 'workspaces', 'abc', 'MEMORY.md')
    put(index, withLesson ? `${cross.trap.note}\n` : 'nothing\n')
    put(join(dir, off, 'home', 'memory', 'workspaces', 'abc', 'MEMORY.md'), 'nothing\n')
    utimesSync(index, new Date(writtenAt), new Date(writtenAt))
    return { dir, oracle, off }
  }
  it('passes for a lesson written between the sessions, and the off run without it', () => {
    const { dir, oracle, off } = setup('2026-11-05T10:02:00.000Z')
    expect(oracleMemoryChecks(dir, cross, oracle, off).map((c) => c.status)).toEqual(['PASS', 'PASS'])
  })
  it('fails for a lesson written before the first session ended, or not at all', () => {
    const early = setup('2026-11-05T09:00:00.000Z')
    expect(oracleMemoryChecks(early.dir, cross, early.oracle, early.off).map((c) => c.status)).toEqual([
      'PASS',
      'FAIL',
    ])
    const none = setup('2026-11-05T10:02:00.000Z', false)
    expect(oracleMemoryChecks(none.dir, cross, none.oracle, none.off)[0]).toMatchObject({ status: 'FAIL' })
  })
})

describe('the skill checks', () => {
  const receipt = (outcome: string, reason?: string) =>
    JSON.stringify({
      seq: 1,
      ts: 't',
      type: 'x/core/refinement-save',
      lane: 'refinement',
      origin: 'system',
      data: { source: { kind: 'skill' }, outcome, ...(reason ? { reason } : {}) },
    })
  it('fails on a skill save refused unavailable, as in the first evaluation', () => {
    const dir = runDir()
    const run = 'cross-01-build-subdir.on.r1'
    put(join(dir, run, 'sessions', 's1.events.jsonl'), `${receipt('refused', 'unavailable')}\n`)
    const checks = skillChecks(dir, [{ id: run, task: cross }])
    expect(checks.map((c) => c.status)).toEqual(['FAIL', 'WARN'])
  })
  it('passes for an installed skill that is in the workspace', () => {
    const dir = runDir()
    const run = 'cross-01-build-subdir.on.r1'
    put(join(dir, run, 'sessions', 's1.events.jsonl'), `${receipt('installed')}\n`)
    put(join(dir, run, 'work', AGH_DIR, 'skills', 'build-in-studio', 'SKILL.md'), '---\nname: x\n---\n')
    expect(skillChecks(dir, [{ id: run, task: cross }]).map((c) => c.status)).toEqual(['PASS', 'PASS'])
  })
  it('fails when an off or oracle run left a skill', () => {
    const dir = runDir()
    const run = 'cross-01-build-subdir.off.r1'
    expect(offWritesNoSkill(dir, [{ id: run, task: cross }]).status).toBe('PASS')
    put(join(dir, run, 'work', AGH_DIR, 'skills', 'x', 'SKILL.md'), 'x')
    expect(offWritesNoSkill(dir, [{ id: run, task: cross }]).status).toBe('FAIL')
  })
})
