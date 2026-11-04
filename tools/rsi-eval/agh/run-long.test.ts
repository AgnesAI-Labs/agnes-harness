import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGH_DIR } from '../../../packages/protocol/src/constants.js'
import type { EvalTask, RunOutcome } from '../types.js'
import { loadFrozenMemoryModule } from './frozen.js'
import {
  type AghRunOptions,
  type CheckRun,
  DEFAULT_MAX_REQUESTS,
  oracleApplies,
  parseAghArgs,
  runOne,
} from './run-agh.js'
import { type Call, cfg, prompt, type Script, stubLaunch } from './test-stub.js'

// The runner's handling of long tasks and of the frozen arm, with the launcher stub (no model, no host).
// The frozen arm's source is assembled from a real `on` run's saved memory and skill (fixtures/real).
const real = join(dirname(import.meta.dirname), 'fixtures', 'real', 'frozen-source')

const staged = (over: Partial<EvalTask> = {}): EvalTask => ({
  id: 't1',
  category: 'long',
  description: 'd',
  trap: { signatures: ['x'], reproduce: 'true', note: 'Run the tool from studio/, never from the root.' },
  sessions: [
    {
      prompts: [
        { ...prompt('a'), milestone: 'stage 1' },
        { ...prompt('b'), milestone: 'stage 2' },
        { ...prompt('c'), milestone: 'stage 3' },
      ],
    },
  ],
  ...over,
})

describe('long tasks and the frozen arm in the runner', () => {
  let dir: string
  let out: string
  let work: string
  let fixture: string
  let failing: Set<string>
  let calls: Call[]
  const runCheck: CheckRun = async (check) => {
    calls.push({ op: 'check', command: check.command })
    return !failing.has(check.command)
  }

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'rsi-agh-long-')))
    out = join(dir, 'out')
    work = join(dir, 'work-base')
    fixture = join(dir, 'fixture')
    mkdirSync(work)
    mkdirSync(fixture)
    writeFileSync(join(fixture, 'README.md'), 'hello')
    failing = new Set()
    calls = []
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

  const run = (
    t: EvalTask,
    setting: Parameters<typeof runOne>[1],
    script: Script = {},
    extra: Partial<AghRunOptions> = {},
  ) =>
    runOne(t, setting, 1, cfg, out, {
      launch: stubLaunch(calls, script),
      fixtureDir: fixture,
      workBase: work,
      runCheck,
      ...extra,
    })
  const ops = () =>
    calls.map((c) =>
      c.op === 'prompt' ? `prompt:${c.text}` : c.op === 'check' ? `check:${c.command}` : c.op,
    )

  describe('milestones', () => {
    it('checks a milestone right after its prompt, before the review, and records when each prompt ended', async () => {
      const outcome = await run(staged(), 'on')
      expect(
        ops().filter((op) => op.startsWith('prompt') || op.startsWith('check') || op === 'review'),
      ).toEqual([
        'prompt:a',
        'check:check a',
        'review',
        'prompt:b',
        'check:check b',
        'review',
        'prompt:c',
        'check:check c',
        'review',
      ])
      expect(outcome.checks).toEqual([
        { session: 0, prompt: 0, passed: true },
        { session: 0, prompt: 1, passed: true },
        { session: 0, prompt: 2, passed: true },
      ])
      expect(outcome.prompts?.map((p) => [p.session, p.prompt, p.reason])).toEqual([
        [0, 0, 'completed'],
        [0, 1, 'completed'],
        [0, 2, 'completed'],
      ])
      for (const p of outcome.prompts ?? []) expect(Number.isNaN(Date.parse(p.endedAt))).toBe(false)
    })

    it('stops the run at the first milestone that fails', async () => {
      failing.add('check b')
      const outcome = await run(staged(), 'off')
      expect(ops().filter((op) => op.startsWith('prompt'))).toEqual(['prompt:a', 'prompt:b'])
      expect(outcome.stopped).toEqual({ reason: 'milestone-failed', session: 0, prompt: 1 })
      expect(outcome.sessions[0]?.exitCode).toBe(1)
      expect(outcome.checks).toEqual([
        { session: 0, prompt: 0, passed: true },
        { session: 0, prompt: 1, passed: false },
      ])
    })

    it('still checks the prompts that are no milestone at the end, as before', async () => {
      const mixed = staged({
        sessions: [{ prompts: [{ ...prompt('a'), milestone: 'stage 1' }, prompt('b'), prompt('c')] }],
      })
      await run(mixed, 'off')
      expect(ops().filter((op) => op.startsWith('prompt') || op.startsWith('check'))).toEqual([
        'prompt:a',
        'check:check a',
        'prompt:b',
        'prompt:c',
        'check:check b',
        'check:check c',
      ])
    })
  })

  describe('the request cap', () => {
    const fakeCap = () => {
      const state: { limited: [string, number][]; unlimited: string[]; reached?: () => void } = {
        limited: [],
        unlimited: [],
      }
      return {
        state,
        cap: {
          limit: (id: string, max: number, reached: () => void) => {
            state.limited.push([id, max])
            state.reached = reached
          },
          unlimit: (id: string) => {
            state.unlimited.push(id)
          },
        },
      }
    }

    it('stops the run cleanly where the cap was reached and records it, not as an infrastructure failure', async () => {
      const { state, cap } = fakeCap()
      const quota = [
        {
          seq: 9,
          ts: '2026-11-03T00:00:01Z',
          type: 'turn/end',
          lane: 'main',
          origin: 'system',
          data: { reason: 'error', error: { code: 'QUOTA', message: 'status=402' } },
        },
      ]
      const outcome = await run(
        staged(),
        'off',
        { capAt: 'b', trip: () => state.reached?.(), ledgerRows: { s1: quota } },
        { cap, maxRequests: 50 },
      )
      expect(ops().filter((op) => op.startsWith('prompt'))).toEqual(['prompt:a', 'prompt:b'])
      expect(outcome.capped).toEqual({ maxRequests: 50, session: 0, prompt: 1 })
      expect(outcome.sessions[0]).toMatchObject({ exitCode: 1, capped: true, timedOut: false })
      // Whatever the ledger says, the runner stopped this run itself.
      expect(outcome.infraFailed).toBeUndefined()
      expect(state.limited).toEqual([['t1.off.r1', 50]])
      expect(state.unlimited).toEqual(['t1.off.r1'])
      expect(outcome.prompts?.at(-1)).toMatchObject({ prompt: 1, reason: 'capped' })
    })

    it("takes the task's own cap over the runner's, and the runner's default without either", async () => {
      const first = fakeCap()
      await run(staged({ maxRequests: 12 }), 'off', {}, { cap: first.cap, maxRequests: 50 })
      expect(first.state.limited).toEqual([['t1.off.r1', 12]])
      const second = fakeCap()
      rmSync(out, { recursive: true, force: true })
      await run(staged(), 'off', {}, { cap: second.cap })
      expect(second.state.limited).toEqual([['t1.off.r1', DEFAULT_MAX_REQUESTS]])
    })
  })

  describe('the oracle seeding point', () => {
    it('writes the lesson after the named prompt of a single-session task, before the next', async () => {
      const t = staged({ oracle: { afterPrompt: 0 } })
      expect(oracleApplies(t)).toBe(true)
      expect(oracleApplies(staged())).toBe(false)
      await run(t, 'oracle')
      expect(ops().filter((op) => op.startsWith('prompt') || op === 'seed' || op === 'open')).toEqual([
        'open',
        'prompt:a',
        'seed',
        'prompt:b',
        'prompt:c',
      ])
      expect(calls.find((c) => c.op === 'seed')).toMatchObject({ text: t.trap.note })
      // The off run of the same task gets no lesson.
      calls = []
      await run(t, 'off')
      expect(calls.some((c) => c.op === 'seed')).toBe(false)
    })

    it('runs a long task of several sessions in one workspace, each a new session, the lesson before the second', async () => {
      const m = (name: string) => ({ ...prompt(name), milestone: name })
      const t = staged({
        sessions: [{ prompts: [m('a'), m('b')] }, { prompts: [m('c')] }, { prompts: [m('d')] }],
      })
      expect(oracleApplies(t)).toBe(true)
      const outcome = await run(t, 'oracle')
      expect(ops().filter((op) => op.startsWith('prompt') || op === 'seed' || op === 'open')).toEqual([
        'open',
        'prompt:a',
        'prompt:b',
        'seed',
        'open',
        'prompt:c',
        'open',
        'prompt:d',
      ])
      const opened = calls.flatMap((c) => (c.op === 'open' ? [c] : []))
      expect(new Set(opened.map((c) => c.key)).size).toBe(3)
      expect(new Set(opened.map((c) => c.workspace)).size).toBe(1)
      expect(calls.find((c) => c.op === 'seed')).toMatchObject({ workspace: opened[0]?.workspace })
      expect(outcome.checks.map((c) => [c.session, c.prompt, c.passed])).toEqual([
        [0, 0, true],
        [0, 1, true],
        [1, 0, true],
        [2, 0, true],
      ])
      // A failed milestone ends the run: no later session opens.
      calls = []
      failing.add('check c')
      const stopped = await run(t, 'off')
      expect(stopped.stopped).toEqual({ reason: 'milestone-failed', session: 1, prompt: 0 })
      expect(calls.filter((c) => c.op === 'open')).toHaveLength(2)
      expect(calls.some((c) => c.op === 'seed')).toBe(false)
    })

    it('refuses the oracle arm for a single-session task without a seeding point', async () => {
      await expect(run(staged(), 'oracle')).rejects.toThrow(/no oracle arm/)
    })
  })

  describe('the on protocol', () => {
    it('sends no manual review with triggers only, and checks once per session that refinement is live', async () => {
      const outcome = await run(staged(), 'on', {}, { onProtocol: 'triggers' })
      expect(calls.filter((c) => c.op === 'review')).toHaveLength(0)
      expect(ops().slice(0, 3)).toEqual(['launch', 'open', 'liveness'])
      expect(outcome.onProtocol).toBe('triggers')
    })

    it('stops an on run with triggers only when refinement is not live', async () => {
      await expect(
        run(staged(), 'on', { liveness: { refused: 'refinement-off' } }, { onProtocol: 'triggers' }),
      ).rejects.toThrow(/not active in the run host \(refinement-off\)/)
      expect(calls.some((c) => c.op === 'prompt')).toBe(false)
    })

    it('keeps the default: a manual review after every prompt, no liveness read', async () => {
      const outcome = await run(staged(), 'on')
      expect(calls.filter((c) => c.op === 'review')).toHaveLength(3)
      expect(calls.some((c) => c.op === 'liveness')).toBe(false)
      expect(outcome.onProtocol).toBe('reviews')
      calls = []
      expect((await run(staged(), 'off', {}, { onProtocol: 'triggers' })).onProtocol).toBeUndefined()
    })
  })

  describe('the frozen arm', () => {
    const single = staged({
      category: 'cross-session',
      sessions: [{ prompts: [prompt('a'), prompt('b'), prompt('c')] }],
    })
    /** A finished `on` run's folder: the real saved memory and skill, a user memory section. */
    const source = async (from: string, outcome: Partial<RunOutcome> = {}) => {
      const memory = await loadFrozenMemoryModule()
      const runDir = join(from, 't1.on.r1')
      const workspace = join(work, 'rsi-agh-gone')
      const home = join(runDir, 'home')
      mkdirSync(home, { recursive: true })
      const { root, userRoot } = memory.fileMemoryRoots(home, workspace)
      mkdirSync(root, { recursive: true })
      cpSync(join(real, 'workspace.MEMORY.md'), join(root, 'MEMORY.md'))
      mkdirSync(userRoot, { recursive: true })
      // A saved user memory section, in the provider's marker format, under a hand-written line.
      writeFileSync(
        join(userRoot, 'MEMORY.md'),
        'Written by hand.\n\n<!-- refinement:r0123456789 -->\nUse ACME_PROFILE=dev with the shared bin/acme tool.\n<!-- /refinement:r0123456789 -->\n',
      )
      const skill = join(runDir, 'work', AGH_DIR, 'skills', 'add_part_and_build')
      mkdirSync(skill, { recursive: true })
      cpSync(join(real, 'add_part_and_build.SKILL.md'), join(skill, 'SKILL.md'))
      writeFileSync(
        join(runDir, 'outcome.json'),
        JSON.stringify({
          runId: 't1.on.r1',
          system: 'agh',
          sessions: [],
          checks: [],
          workspaces: { fixture: workspace },
          ...outcome,
        }),
      )
      return from
    }

    it('starts with exactly what the on run saved, before the first session, with refinement off', async () => {
      const from = await source(join(dir, 'from'))
      const outcome = await run(single, 'frozen', {}, { frozenFrom: from })
      const launch = calls.find((c) => c.op === 'launch')
      expect(launch && 'input' in launch ? launch.input.refinement : 'missing').toBeUndefined()
      expect(ops().slice(0, 4)).toEqual(['launch', 'seed', 'seed-user', 'open'])
      const seeded = calls.find((c) => c.op === 'seed') as { text: string }
      // The three paragraphs refinement saved, as text, and not what the agent wrote into memory itself.
      expect(seeded.text).toContain('Run tools first when asked; correct from error output')
      expect(seeded.text).toContain('Verify memory-file writes by re-reading')
      expect(seeded.text).toContain('Part/build convention: parts/<name>.txt')
      expect(seeded.text).not.toContain('## parts project build conventions')
      expect(seeded.text).not.toContain('<!--')
      expect(calls.find((c) => c.op === 'seed-user')).toEqual({
        op: 'seed-user',
        text: 'Use ACME_PROFILE=dev with the shared bin/acme tool.',
      })
      // The skill is in the workspace the run used (kept as its `work` copy).
      expect(
        readFileSync(
          join(out, 't1.frozen.r1', 'work', AGH_DIR, 'skills', 'add_part_and_build', 'SKILL.md'),
          'utf8',
        ),
      ).toBe(readFileSync(join(real, 'add_part_and_build.SKILL.md'), 'utf8'))
      expect(outcome.frozenFrom).toEqual({
        runId: 't1.on.r1',
        paragraphs: { fixture: 3 },
        skills: { fixture: ['add_part_and_build'] },
        userSections: 1,
      })
      expect(calls.some((c) => c.op === 'review' || c.op === 'liveness')).toBe(false)
    })

    it('refuses a missing source, a source that is not an on run, one the upstream ended, and one blocked', async () => {
      await expect(run(single, 'frozen', {}, { frozenFrom: join(dir, 'nowhere') })).rejects.toThrow(
        /is not there/,
      )
      await expect(run(single, 'frozen')).rejects.toThrow(/frozenFrom/)
      const wrong = await source(join(dir, 'wrong'), { runId: 't1.off.r1' })
      await expect(run(single, 'frozen', {}, { frozenFrom: wrong })).rejects.toThrow(/not an on run/)
      const ended = await source(join(dir, 'ended'), {
        infraFailed: { session: 0, reason: 'QUOTA (HTTP 402)', status: 402 },
      })
      await expect(run(single, 'frozen', {}, { frozenFrom: ended })).rejects.toThrow(/ended by the upstream/)
      // A run the host's verifier blocked saved only part of a run: a partial lesson is no source.
      const blocked = await source(join(dir, 'blocked'), {
        blocked: { session: 0, prompt: 1, reasons: ['tool_call_as_text'] },
      })
      await expect(run(single, 'frozen', {}, { frozenFrom: blocked })).rejects.toThrow(
        /blocked by the host's verifier/,
      )
      // Nothing was paid for: no host was launched.
      expect(calls.some((c) => c.op === 'launch')).toBe(false)
    })

    it('refuses an older source of two workspaces that did not record which memory is which', async () => {
      const from = await source(join(dir, 'old'))
      const runDir = join(from, 't1.on.r1')
      const outcome = JSON.parse(readFileSync(join(runDir, 'outcome.json'), 'utf8'))
      delete outcome.workspaces
      writeFileSync(join(runDir, 'outcome.json'), JSON.stringify(outcome))
      mkdirSync(join(fixture, '..', 'fixture-b'), { recursive: true })
      const two = staged({
        category: 'cross-workspace',
        sessions: [
          { prompts: [prompt('a'), prompt('b'), prompt('c')] },
          { prompts: [prompt('d'), prompt('e'), prompt('f')], fixture: 'fixture-b' },
        ],
      })
      await expect(run(two, 'frozen', {}, { frozenFrom: from })).rejects.toThrow(
        /predates recorded workspace paths/,
      )
      // With one workspace the single memory folder is the one.
      expect((await run(single, 'frozen', {}, { frozenFrom: from })).frozenFrom?.paragraphs).toEqual({
        fixture: 3,
      })
    })

    it('records the throwaway workspace of every fixture, so a later frozen run can find its memory', async () => {
      const outcome = await run(single, 'on')
      expect(Object.keys(outcome.workspaces ?? {})).toEqual(['fixture'])
      expect(existsSync(outcome.workspaces?.fixture ?? '')).toBe(false)
    })
  })

  it('reads the new options and keeps the old defaults', () => {
    const base = ['--config', 'c.json', '--out', 'o']
    expect(parseAghArgs(base)).toMatchObject({
      onProtocol: 'reviews',
      maxRequests: DEFAULT_MAX_REQUESTS,
      settings: ['on', 'off'],
    })
    expect(parseAghArgs([...base, '--arms', 'off,frozen', '--frozen-from', 'runs'])).toMatchObject({
      settings: ['off', 'frozen'],
      frozenFrom: 'runs',
    })
    expect(() => parseAghArgs([...base, '--arms', 'frozen'])).toThrow(/--frozen-from/)
    expect(() => parseAghArgs([...base, '--frozen-from', 'runs'])).toThrow(/only for the frozen arm/)
    expect(parseAghArgs([...base, '--on-protocol', 'triggers']).onProtocol).toBe('triggers')
    expect(() => parseAghArgs([...base, '--on-protocol', 'never'])).toThrow(/on-protocol/)
    expect(parseAghArgs([...base, '--max-requests', '90']).maxRequests).toBe(90)
    expect(() => parseAghArgs([...base, '--max-requests', '0'])).toThrow(/max-requests/)
  })
})
