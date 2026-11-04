import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { toRunRecord, workflowReuseMetric } from './metrics.js'
import { buildReport, readRunRecords } from './report.js'
import type { EvalTask, RunOutcome, RunRecord } from './types.js'
import {
  normalizeDefinition,
  parseAghWorkflowCalls,
  readSkillTexts,
  savedDefinitions,
} from './workflow-reuse.js'

const definition = (task = 'Read api/CHANGES.txt and note what the request needs.') => ({
  name: 'process-request',
  stages: [
    {
      name: 'investigate',
      members: [
        { name: 'api', task },
        { name: 'web', task: 'Read web/CHANGES.txt and note what the request needs.' },
      ],
    },
    { name: 'summarise', members: [{ name: 'writer', task: 'Write SUMMARY.md from the notes.' }] },
    { name: 'apply', members: [{ name: 'applier', task: 'Apply SUMMARY.md with bin/relnote apply.' }] },
  ],
})

let seq = 0
const row = (type: string, data: object, lane: string | null = 'main'): string =>
  JSON.stringify({ seq: ++seq, ts: '2026-11-05T00:00:00Z', type, lane, origin: null, data })
const sent = new Map<string, Record<string, unknown>>()
const call = (id: string, args: Record<string, unknown>, lane: string | null = 'main'): string => {
  sent.set(id, args)
  return row('tool/call', { toolUseId: id, name: 'workflow', args }, lane)
}
// The tool answers an executed call with the run: its stages, runId and status.
const result = (id: string, status = 'completed'): string =>
  row('tool/result', {
    toolUseId: id,
    content: [{ type: 'text', text: JSON.stringify({ ...sent.get(id), runId: `run-${id}`, status }) }],
    isError: status !== 'completed',
  })
// A call the tool never ran: refused, denied or invalid.
const refused = (id: string, text = 'A new workflow needs name and stages'): string =>
  row('tool/result', { toolUseId: id, content: [{ type: 'text', text }], isError: true })
const lines = (...rows: string[]): string => `${rows.join('\n')}\n`

const skill = (body: object | null): string =>
  [
    '---',
    'name: process-request',
    'description: Process the oldest queued request in stages.',
    '---',
    'Use the `workflow` tool with this definition:',
    ...(body ? ['```json', JSON.stringify(body, null, 2), '```'] : []),
    '',
  ].join('\n')

describe('normalizeDefinition', () => {
  it('ignores the workflow name, whitespace and the order of parallel members, not stage order', () => {
    const same = definition()
    const noisy = {
      name: 'another name',
      stages: [
        {
          name: ' investigate ',
          members: [
            ...(same.stages[0]?.members ?? [])
              .slice()
              .reverse()
              .map((m) => ({ ...m, task: `${m.task}  \n` })),
          ],
        },
        ...same.stages.slice(1),
      ],
    }
    expect(normalizeDefinition(noisy)).toBe(normalizeDefinition(same))
    expect(normalizeDefinition({ stages: [...same.stages].reverse() })).not.toBe(normalizeDefinition(same))
  })

  it('rejects what is not a definition', () => {
    expect(normalizeDefinition(undefined)).toBeUndefined()
    expect(normalizeDefinition({ runId: 'abc' })).toBeUndefined()
    expect(normalizeDefinition({ stages: [] })).toBeUndefined()
    expect(normalizeDefinition({ stages: [{ name: 's', members: [] }] })).toBeUndefined()
    expect(normalizeDefinition({ stages: [{ name: 's', members: [{ name: 'm' }] }] })).toBeUndefined()
  })
})

describe('savedDefinitions', () => {
  it('reads the fenced json block of a skill and skips skills and blocks without a definition', () => {
    expect(savedDefinitions([skill(definition())])).toEqual([normalizeDefinition(definition())])
    expect(savedDefinitions([skill(null)])).toEqual([])
    expect(savedDefinitions(['```json\nnot json\n```', '```json\n{"a":1}\n```'])).toEqual([])
  })
})

describe('parseAghWorkflowCalls', () => {
  it('lists main-lane calls that start a run and which of them completed', () => {
    const parsed = parseAghWorkflowCalls(
      lines(
        call('t1', definition()),
        result('t1'),
        call('t2', definition('other task')),
        result('t2', 'failed'),
        call('t3', { runId: 'run-t2' }),
        result('t3'),
        call('t4', definition('child'), 'child-1'),
        call('t5', definition('denied')),
        refused('t5', 'Permission denied'),
      ),
    )
    expect(parsed.calls).toEqual([
      normalizeDefinition(definition()),
      normalizeDefinition(definition('other task')),
    ])
    // The failed run was finished by the resume, which carries no definition of its own; the child
    // lane's call and the denied call are not counted.
    expect(parsed.completed).toEqual([
      normalizeDefinition(definition()),
      normalizeDefinition(definition('other task')),
    ])
  })

  it('counts a resume of an unknown run only when its answer carries the stages, and never a bare error', () => {
    const parsed = parseAghWorkflowCalls(
      lines(
        call('r1', { runId: 'gone' }),
        refused('r1', 'Unknown workflow run'),
        call('r2', { runId: 'run-x' }),
      ),
    )
    expect(parsed).toEqual({ calls: [], completed: [] })
  })
})

describe('workflow reuse of a run', () => {
  const task: EvalTask = {
    id: 'wf-demo',
    category: 'workflow',
    description: 'd',
    trap: { signatures: ['x'], reproduce: 'true', note: 'n' },
    sessions: [{ prompts: [] }, { prompts: [] }],
  }
  const first = lines(call('a', definition()), result('a'))
  const files = (second: string, firstSession = first): Record<string, string> => ({
    's1.jsonl': firstSession,
    's2.jsonl': second,
  })
  const outcome = (setting: 'on' | 'off' = 'on'): RunOutcome => ({
    runId: `wf-demo.${setting}.r1`,
    system: 'agh',
    sessions: [
      { exitCode: 0, timedOut: false, stdoutFile: 'o1', sessionFiles: ['s1.jsonl'] },
      { exitCode: 0, timedOut: false, stdoutFile: 'o2', sessionFiles: ['s2.jsonl'] },
    ],
    checks: [],
  })
  const record = (
    texts: Record<string, string>,
    skills: string[] = [skill(definition())],
    setting: 'on' | 'off' = 'on',
  ): RunRecord =>
    toRunRecord(task, outcome(setting), new Map(), {
      system: 'agh',
      readFile: (path) => texts[path] as string,
      readSavedSkills: () => skills,
    })

  it('counts a second-session call with the saved definition', () => {
    const rec = record(files(lines(call('b', definition()), result('b'))))
    expect(rec.workflowReuse).toEqual({ firstCompleted: true, saved: true, calls: 1, matching: 1 })
    expect(workflowReuseMetric(rec)).toMatchObject({ excluded: false, reused: true, matching: 1, calls: 1 })
  })

  it('does not count a different definition', () => {
    const rec = record(files(lines(call('b', definition('Read everything.')), result('b'))))
    expect(rec.workflowReuse).toEqual({ firstCompleted: true, saved: true, calls: 1, matching: 0 })
    expect(workflowReuseMetric(rec)).toMatchObject({ excluded: false, reused: false })
  })

  it('does not count a second-session call the tool refused', () => {
    const rec = record(files(lines(call('b', definition()), refused('b', 'Permission denied'))))
    expect(rec.workflowReuse).toMatchObject({ calls: 0, matching: 0 })
  })

  it('does not count a second session without a workflow call', () => {
    const rec = record(files(lines(row('user/message', { content: 'hello' }))))
    expect(rec.workflowReuse).toEqual({ firstCompleted: true, saved: true, calls: 0, matching: 0 })
    expect(workflowReuseMetric(rec)).toMatchObject({ excluded: false, reused: false, calls: 0 })
  })

  it('excludes a run whose first session never completed a workflow run', () => {
    const never = record(files(lines(call('b', definition()), result('b')), lines(row('user/message', {}))))
    expect(workflowReuseMetric(never)).toEqual({ excluded: true })
    const failed = record(
      files(
        lines(call('b', definition()), result('b')),
        lines(call('a', definition()), result('a', 'failed')),
      ),
    )
    expect(workflowReuseMetric(failed)).toEqual({ excluded: true })
    const denied = record(
      files(lines(call('b', definition()), result('b')), lines(call('a', definition()), refused('a'))),
    )
    expect(workflowReuseMetric(denied)).toEqual({ excluded: true })
    // A first run that failed a stage and was finished by a resume counts as completed.
    const resumed = record(
      files(
        lines(call('b', definition()), result('b')),
        lines(call('a', definition()), result('a', 'failed'), call('a2', { runId: 'run-a' }), result('a2')),
      ),
    )
    expect(workflowReuseMetric(resumed)).toMatchObject({ excluded: false })
  })

  it('counts nothing saved when no skill carries a definition', () => {
    const second = files(lines(call('b', definition()), result('b')))
    for (const skills of [[], [skill(null)]]) {
      const rec = record(second, skills)
      expect(rec.workflowReuse).toMatchObject({ saved: false, matching: 0 })
      expect(workflowReuseMetric(rec)).toMatchObject({ excluded: false, nothingSaved: true, reused: false })
    }
  })

  it('tells a save the host refused from nothing saved', () => {
    const second = files(lines(call('b', definition()), result('b')))
    const rec = toRunRecord(task, { ...outcome(), saveRefused: 'unpriced' }, new Map(), {
      system: 'agh',
      readFile: (path) => second[path] as string,
      readSavedSkills: () => [],
    })
    expect(rec.workflowReuse).toMatchObject({ saved: false, saveRefused: 'unpriced' })
    expect(workflowReuseMetric(rec)).toMatchObject({
      excluded: false,
      nothingSaved: false,
      saveRefused: 'unpriced',
      reused: false,
    })
    // A skill that carries the definition wins over the refusal.
    const saved = toRunRecord(task, { ...outcome(), saveRefused: 'busy' }, new Map(), {
      system: 'agh',
      readFile: (path) => second[path] as string,
      readSavedSkills: () => [skill(definition())],
    })
    expect(workflowReuseMetric(saved)).toMatchObject({ nothingSaved: false, reused: true })
    expect((workflowReuseMetric(saved) as { saveRefused?: string }).saveRefused).toBeUndefined()
  })

  it('leaves other tasks and Prime runs without the field', () => {
    const other = toRunRecord({ ...task, category: 'cross-workspace' }, outcome(), new Map(), {
      system: 'agh',
      readFile: (path) => files('')[path] as string,
    })
    expect(other.workflowReuse).toBeUndefined()
    expect(workflowReuseMetric(other)).toBeNull()
    const prime = toRunRecord(task, outcome(), new Map(), { readFile: () => '' })
    expect(prime.workflowReuse).toBeUndefined()
  })

  describe('in the report', () => {
    const agh = (taskId: string, setting: 'on' | 'off', rep: number, w: RunRecord['workflowReuse']) =>
      ({
        ...record(files('')),
        taskId,
        setting,
        rep,
        workflowReuse: w,
      }) as RunRecord
    const records = [
      agh('wf-a', 'on', 1, { firstCompleted: true, saved: true, calls: 2, matching: 1 }),
      agh('wf-a', 'on', 2, { firstCompleted: true, saved: true, calls: 1, matching: 0 }),
      agh('wf-a', 'on', 3, { firstCompleted: false, saved: false, calls: 3, matching: 0 }),
      agh('wf-b', 'on', 1, {
        firstCompleted: true,
        saved: false,
        saveRefused: 'unpriced',
        calls: 0,
        matching: 0,
      }),
      agh('wf-b', 'on', 2, { firstCompleted: false, saved: false, calls: 0, matching: 0 }),
      agh('wf-a', 'off', 1, { firstCompleted: true, saved: false, calls: 2, matching: 0 }),
      agh('wf-b', 'off', 1, { firstCompleted: false, saved: false, calls: 1, matching: 0 }),
    ]

    it('reports the rate per setting with the exclusions counted', () => {
      const { json, markdown } = buildReport(records, { resamples: 50 })
      const reuse = JSON.parse(JSON.stringify(json)).systems.agh.workflowReuse
      expect(reuse.on).toMatchObject({
        runs: 5,
        excluded: { runs: 2, tasks: 0, of: 5 },
        nothingSaved: 0,
        saveRefused: 1,
        withoutCall: 1,
        calls: 3,
        matchingCalls: 1,
        reuseRate: 1 / 3,
        reusedRuns: 1,
        runRate: 1 / 3,
      })
      expect(reuse.off).toMatchObject({
        runs: 2,
        excluded: { runs: 1, tasks: 1, of: 2 },
        nothingSaved: 1,
        calls: 2,
        matchingCalls: 0,
        reuseRate: 0,
      })
      expect(markdown).toContain('### 2c. Workflow reuse')
      expect(markdown).toContain('On: reuse rate 0.333 (1 of 3')
      expect(markdown).toContain('save refused by the host in 1 runs')
      expect(markdown).toContain('never completed a workflow run: 2 of 5 runs')
    })

    it('leaves workflow runs out of the repeat-error metric and says so', () => {
      const trap = (taskId: string, setting: 'on' | 'off', category: RunRecord['category']): RunRecord => ({
        ...agh(taskId, setting, 1, undefined),
        category,
        windows: [
          { session: 0, prompt: 0, ran: true, trapHit: true, checksPassed: true },
          { session: 0, prompt: 1, ran: true, trapHit: setting === 'off', checksPassed: true },
        ],
        ...(category === 'workflow'
          ? { workflowReuse: { firstCompleted: true, saved: false, calls: 0, matching: 0 } }
          : {}),
      })
      const { json, markdown } = buildReport(
        [
          trap('d1', 'on', 'directory'),
          trap('d1', 'off', 'directory'),
          trap('wf-a', 'on', 'workflow'),
          trap('wf-a', 'off', 'workflow'),
        ],
        { resamples: 50 },
      )
      const drop = JSON.parse(JSON.stringify(json)).systems.agh.repeatErrorDrop
      expect(drop.difference.tasks).toBe(1)
      expect(drop.workflowRunsLeftOut).toEqual({ on: 1, off: 1 })
      expect(markdown).toContain('Workflow runs left out of this metric: on 1, off 1')
      const plain = buildReport([trap('d1', 'on', 'directory'), trap('d1', 'off', 'directory')], {
        resamples: 50,
      })
      expect(
        JSON.parse(JSON.stringify(plain.json)).systems.agh.repeatErrorDrop.workflowRunsLeftOut,
      ).toBeUndefined()
    })

    it('adds nothing to a report without workflow runs', () => {
      const plain = records.map(({ workflowReuse: _unused, ...rest }) => rest as RunRecord)
      const { json, markdown } = buildReport(plain, { resamples: 50 })
      expect(JSON.parse(JSON.stringify(json)).systems.agh.workflowReuse).toBeUndefined()
      expect(markdown).not.toContain('Workflow reuse')
    })
  })
})

describe('reading a run folder', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('reads the skills the first workspace kept, and the second session from the run folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'rsi-workflow-reuse-'))
    roots.push(root)
    const run = join(root, 'wf-demo.on.r1')
    mkdirSync(join(run, 'sessions'), { recursive: true })
    mkdirSync(join(run, 'work', '.agh', 'skills', 'process-request'), { recursive: true })
    mkdirSync(join(run, 'work', '.agh', 'skills', 'empty'), { recursive: true })
    writeFileSync(join(run, 'work', '.agh', 'skills', 'process-request', 'SKILL.md'), skill(definition()))
    writeFileSync(join(run, 'sessions', 's1.events.jsonl'), lines(call('a', definition()), result('a')))
    writeFileSync(join(run, 'sessions', 's2.events.jsonl'), lines(call('b', definition()), result('b')))
    const outcome: RunOutcome = {
      runId: 'wf-demo.on.r1',
      system: 'agh',
      sessions: [
        { exitCode: 0, timedOut: false, stdoutFile: 'o1', sessionFiles: ['sessions/s1.events.jsonl'] },
        { exitCode: 0, timedOut: false, stdoutFile: 'o2', sessionFiles: ['sessions/s2.events.jsonl'] },
      ],
      checks: [],
    }
    writeFileSync(join(run, 'outcome.json'), JSON.stringify(outcome))
    const task: EvalTask = {
      id: 'wf-demo',
      category: 'workflow',
      description: 'd',
      trap: { signatures: ['x'], reproduce: 'true', note: 'n' },
      sessions: [{ prompts: [] }, { prompts: [] }],
    }
    expect(readSkillTexts(join(run, 'work', '.agh', 'skills'))).toHaveLength(1)
    expect(readSkillTexts(join(run, 'nowhere'))).toEqual([])
    const [rec] = readRunRecords(root, new Map([[task.id, task]]))
    expect(rec?.workflowReuse).toEqual({ firstCompleted: true, saved: true, calls: 1, matching: 1 })
  })
})
