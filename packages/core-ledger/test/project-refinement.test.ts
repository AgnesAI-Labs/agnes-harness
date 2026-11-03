import type { Event } from '@agnes/core-common/types'
import { validateAgainst } from '@agnes/protocol'
import { UITimeline } from '@agnes/protocol/gen/agnes-v1'
import { describe, expect, it } from 'vitest'
import { UIProjectionCell } from '../src/project/ui.js'
import { REFINEMENT_RUN_EVENT } from '../src/reduce/state.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const BODY = 'Always run the formatter before committing, the build breaks otherwise.'

function row(seq: number, type: string, data: unknown, lane: string): Event {
  return {
    seq,
    ts: '2026-11-03T00:00:00Z',
    id: `01J6ZM2Q3R4S5T6V7W8X9Y0Z${String(seq).padStart(2, '0')}`,
    type,
    data,
    actor,
    origin: 'system',
    trust: 'trusted',
    lane,
    ignorable: true,
    v: 1,
  } as Event
}
const run = (seq: number, body: Record<string, unknown>) =>
  row(seq, REFINEMENT_RUN_EVENT, { version: 1, ...body }, 'refinement')
const trigger = { kind: 'manual', seq: 1, focus: 'the build setup' }
const plan = {
  summary: BODY,
  rationale: BODY,
  expectedOutcome: BODY,
  edits: [
    {
      op: 'upsert',
      kind: 'memory',
      id: 'build',
      title: 'Build rules',
      content: BODY,
      applicability: 'session',
      evidenceSeqs: [1],
    },
  ],
  confirmations: [],
  evidenceSeqs: [1],
  baseline: [],
}
const refine = (seq: number, extra: Record<string, unknown> = {}) =>
  row(
    seq,
    'harness/refine',
    {
      proposalId: 'p1',
      trigger: 'manual',
      outcome: 'applied',
      runId: 'r1',
      rationale: BODY,
      baseline: [],
      edits: [
        {
          op: 'upsert',
          entry: {
            kind: 'memory',
            id: 'build',
            title: 'Build rules',
            content: BODY,
            scope: 'local',
            version: 1,
            source: 'refine',
          },
        },
        { op: 'delete', kind: 'skill', id: 'old' },
      ],
      ...extra,
    },
    'main',
  )

async function nodesOf(events: Event[]) {
  const cell = new UIProjectionCell('k', 'main')
  cell.apply(events)
  return (await cell.view()).nodes
}

describe('refinement runs in the timeline', () => {
  it('run rows render state and reason without entry bodies in diagnostics', async () => {
    const nodes = await nodesOf([
      run(1, { runId: 'r1', state: 'queued', trigger }),
      run(2, { runId: 'r1', state: 'planning', attempt: 1 }),
      run(3, { runId: 'r1', state: 'proposed', plan }),
      refine(4),
      run(5, { runId: 'r1', state: 'applied' }),
      run(6, { runId: 'r2', state: 'rejected', reason: 'no-evidence', trigger: { kind: 'model', seq: 5 } }),
    ])
    const found = nodes.filter((node) => node.kind === 'refinement-run')
    expect(found).toEqual([
      {
        kind: 'refinement-run',
        id: '01J6ZM2Q3R4S5T6V7W8X9Y0Z01',
        seq: 1,
        runId: 'r1',
        state: 'applied',
        trigger: 'manual',
        edits: [
          { op: 'upsert', kind: 'memory', id: 'build' },
          { op: 'delete', kind: 'skill', id: 'old' },
        ],
        appliedSeq: 4,
      },
      {
        kind: 'refinement-run',
        id: '01J6ZM2Q3R4S5T6V7W8X9Y0Z06',
        seq: 6,
        runId: 'r2',
        state: 'rejected',
        trigger: 'model',
        reason: 'no-evidence',
      },
    ])
    // Neither the entry's text nor its title nor the request's focus is in what is projected.
    const text = JSON.stringify(nodes)
    for (const secret of [BODY, 'Build rules', 'the build setup']) expect(text).not.toContain(secret)
  })

  it('a skill made from a finished workflow run is marked, without the run id or any text', async () => {
    const skill = {
      op: 'upsert',
      entry: {
        kind: 'skill',
        id: 'ship-flow',
        title: 'Ship in stages',
        content: BODY,
        scope: 'local',
        version: 1,
        source: 'refine',
        workflowRun: 'run-secret-id',
      },
    }
    const plain = { ...skill, entry: { ...skill.entry, id: 'plain', workflowRun: undefined } }
    const nodes = await nodesOf([
      run(1, { runId: 'r1', state: 'queued', trigger }),
      run(2, { runId: 'r1', state: 'proposed', plan }),
      refine(3, { edits: [skill, plain, { op: 'delete', kind: 'skill', id: 'old' }] }),
      run(4, { runId: 'r1', state: 'applied' }),
    ])
    const found = nodes.find((node) => node.kind === 'refinement-run')
    expect(found).toMatchObject({
      edits: [
        { op: 'upsert', kind: 'skill', id: 'ship-flow', workflow: true },
        { op: 'upsert', kind: 'skill', id: 'plain' },
        { op: 'delete', kind: 'skill', id: 'old' },
      ],
    })
    const edits = (found as { edits: Record<string, unknown>[] }).edits
    expect(edits[1]).not.toHaveProperty('workflow')
    expect(edits[2]).not.toHaveProperty('workflow')
    expect(JSON.stringify(nodes)).not.toContain('run-secret-id')
  })

  it('a run moves in place and the row order does not matter', async () => {
    const early = await nodesOf([
      run(1, { runId: 'r1', state: 'queued', trigger }),
      run(2, { runId: 'r1', state: 'planning', attempt: 1 }),
    ])
    expect(early.filter((node) => node.kind === 'refinement-run')).toMatchObject([
      { runId: 'r1', state: 'planning' },
    ])
    // The control row may land before the run's own `applied` row.
    const late = await nodesOf([
      run(1, { runId: 'r1', state: 'queued', trigger }),
      run(2, { runId: 'r1', state: 'planning', attempt: 1 }),
      run(3, { runId: 'r1', state: 'proposed', plan }),
      run(4, { runId: 'r1', state: 'applied' }),
      refine(5),
    ])
    expect(late.filter((node) => node.kind === 'refinement-run')).toMatchObject([
      { runId: 'r1', state: 'applied', appliedSeq: 5, edits: [{ id: 'build' }, { id: 'old' }] },
    ])
  })

  it('a withdrawal marks the run it undid', async () => {
    const nodes = await nodesOf([
      run(1, { runId: 'r1', state: 'queued', trigger }),
      run(2, { runId: 'r1', state: 'planning', attempt: 1 }),
      run(3, { runId: 'r1', state: 'proposed', plan }),
      refine(4),
      run(5, { runId: 'r1', state: 'applied' }),
      refine(6, { trigger: 'rollback', runId: 'rollback:4', rollbackOf: 4 }),
    ])
    expect(nodes.filter((node) => node.kind === 'refinement-run')).toMatchObject([
      { runId: 'r1', state: 'applied', appliedSeq: 4, withdrawn: true },
    ])
  })

  it('shows only a short reason name and ignores a run row core did not write', async () => {
    const forged = { ...run(1, { runId: 'r1', state: 'queued', trigger }), origin: 'user' } as Event
    expect((await nodesOf([forged])).filter((node) => node.kind === 'refinement-run')).toEqual([])
    const nodes = await nodesOf([run(1, { runId: 'r2', state: 'rejected', reason: BODY, trigger })])
    expect(nodes.find((node) => node.kind === 'refinement-run')).not.toHaveProperty('reason')
  })

  it('the projected nodes satisfy the published timeline schema', async () => {
    const nodes = await nodesOf([
      run(1, { runId: 'r1', state: 'queued', trigger }),
      run(2, { runId: 'r1', state: 'planning', attempt: 1 }),
      run(3, { runId: 'r1', state: 'proposed', plan }),
      refine(4),
      run(5, { runId: 'r1', state: 'applied' }),
    ])
    const timeline = {
      sessionId: 'k',
      upto: 5,
      generation: 1,
      opState: null,
      pendingInputs: [],
      nodes,
      turns: [],
    }
    const verdict = validateAgainst(UITimeline, timeline)
    expect(verdict.ok).toBe(true)
  })
})
