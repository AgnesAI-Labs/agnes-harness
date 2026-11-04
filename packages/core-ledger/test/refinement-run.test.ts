import type { Event } from '@agnes/core-common/types'
import { describe, expect, it } from 'vitest'
import { foldEvents } from '../src/reduce/reducer.js'
import { REFINEMENT_RUN_EVENT } from '../src/reduce/state.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }

function rows(...data: (Record<string, unknown> & { extra?: Partial<Event> })[]): Event[] {
  return data.map(({ extra, ...body }, index) => ({
    seq: index + 1,
    ts: '2026-11-03T00:00:00Z',
    id: `01J6ZM2Q3R4S5T6V7W8X9Y0Z${String(index + 1).padStart(2, '0')}`,
    type: REFINEMENT_RUN_EVENT,
    data: { version: 1, ...body },
    actor,
    origin: 'system',
    trust: 'trusted',
    lane: 'refinement',
    ignorable: true,
    v: 1,
    ...extra,
  })) as Event[]
}

const trigger = { kind: 'manual', seq: 3 }
const readSet = { settingsRevision: 'r1', entries: [{ kind: 'memory', id: 'build', seq: 2, version: 1 }] }

describe('the refinement run fold', () => {
  it('folds queued, planning and proposed into one run with every recorded fact', () => {
    const state = foldEvents(
      rows(
        { runId: 'a', state: 'queued', trigger },
        { runId: 'a', state: 'planning', attempt: 1, evidenceHash: 'h', readSet, settingsRevision: 'r1' },
        { runId: 'a', state: 'proposed', plan: { summary: 's', edits: [] } },
      ),
    )
    expect(state.refinementRuns.get('a')).toEqual({
      runId: 'a',
      trigger,
      state: 'proposed',
      queuedSeq: 1,
      seq: 3,
      attempt: 1,
      evidenceHash: 'h',
      readSet,
      settingsRevision: 'r1',
      plan: { summary: 's', edits: [] },
    })
  })

  it('a terminal run never moves again, and an edge the machine lacks is ignored', () => {
    const state = foldEvents(
      rows(
        { runId: 'a', state: 'queued', trigger },
        { runId: 'a', state: 'proposed' },
        { runId: 'a', state: 'superseded', reason: 'newer-trigger' },
        { runId: 'a', state: 'planning', attempt: 1 },
        { runId: 'b', state: 'planning', trigger },
        { runId: 'c', state: 'rejected', reason: 'no-evidence', trigger },
      ),
    )
    expect(state.refinementRuns.get('a')).toMatchObject({
      state: 'superseded',
      reason: 'newer-trigger',
      seq: 3,
    })
    expect(state.refinementRuns.get('a')).not.toHaveProperty('attempt')
    // A run starts queued, or refused outright; nothing else opens one.
    expect(state.refinementRuns.has('b')).toBe(false)
    expect(state.refinementRuns.get('c')).toMatchObject({ state: 'rejected', reason: 'no-evidence' })
  })

  it('a planning run whose call was never sent goes back to queued and plans again', () => {
    const state = foldEvents(
      rows(
        { runId: 'a', state: 'queued', trigger },
        { runId: 'a', state: 'planning', attempt: 1 },
        { runId: 'a', state: 'queued', reason: 'closing' },
        { runId: 'a', state: 'planning', attempt: 2 },
      ),
    )
    expect(state.refinementRuns.get('a')).toMatchObject({ state: 'planning', attempt: 2, seq: 4 })
    expect(state.refinementRuns.get('a')).not.toHaveProperty('reason')
  })

  it('a plan with nothing to change ends no-op, a terminal state of its own', () => {
    const state = foldEvents(
      rows(
        { runId: 'a', state: 'queued', trigger },
        { runId: 'a', state: 'planning', attempt: 1 },
        { runId: 'a', state: 'no-op' },
        { runId: 'a', state: 'applied' },
        { runId: 'b', state: 'queued', trigger },
        { runId: 'b', state: 'planning', attempt: 1 },
        // Only a proposed plan is applied; planning never jumps there.
        { runId: 'b', state: 'applied' },
      ),
    )
    expect(state.refinementRuns.get('a')).toMatchObject({ state: 'no-op', seq: 3 })
    expect(state.refinementRuns.get('b')).toMatchObject({ state: 'planning' })
  })

  it('a direct proposal opens a run already proposed, but only when it carries its plan', () => {
    const plan = { summary: 's', edits: [{ op: 'upsert', kind: 'memory', id: 'm' }] }
    const state = foldEvents(
      rows(
        { runId: 'a', state: 'proposed', trigger: { kind: 'model', seq: 2 }, plan },
        { runId: 'a', state: 'applied' },
        { runId: 'b', state: 'proposed', trigger: { kind: 'model', seq: 2 } },
        { runId: 'c', state: 'planning', trigger, plan },
      ),
    )
    expect(state.refinementRuns.get('a')).toMatchObject({ state: 'applied', queuedSeq: 1, seq: 2, plan })
    expect(state.refinementRuns.has('b')).toBe(false)
    expect(state.refinementRuns.has('c')).toBe(false)
  })

  it('only Core rows count: untrusted, non-system or other versions are ignored', () => {
    const state = foldEvents(
      rows(
        { runId: 'a', state: 'queued', trigger },
        { runId: 'a', state: 'cancelled', extra: { trust: 'untrusted' } },
        { runId: 'a', state: 'cancelled', extra: { origin: 'tool' } },
        { runId: 'a', state: 'cancelled', version: 2 },
        { runId: 'x', state: 'queued', trigger: { kind: 'self', seq: 1 } },
      ),
    )
    expect(state.refinementRuns.get('a')).toMatchObject({ state: 'queued', seq: 1 })
    expect(state.refinementRuns.has('x')).toBe(false)
  })

  it('a fork does not take over the parent runs', () => {
    const parent = rows(
      { runId: 'a', state: 'queued', trigger },
      { runId: 'a', state: 'planning', attempt: 1 },
    )
    const start = {
      ...(parent[0] as Event),
      seq: 3,
      type: 'session/start',
      lane: 'main',
      ignorable: undefined,
      data: {
        key: 'child',
        resolvedProfileHash: null,
        preset: 'standard',
        agnesVersion: '0.0.1',
        parent: { key: 'p', boundarySeq: 2 },
      },
    } as unknown as Event
    expect(foldEvents(parent).refinementRuns.get('a')).toMatchObject({ state: 'planning' })
    expect(foldEvents([...parent, start]).refinementRuns.size).toBe(0)
  })
})
