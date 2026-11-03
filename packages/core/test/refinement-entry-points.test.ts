import { REFINEMENT_SAVE_EVENT, type SaveReceipt } from '@agnes/core-ledger/reduce/refinement-save'
import type { RefinementRunRecord } from '@agnes/core-ledger/reduce/state'
import { describe, expect, it, vi } from 'vitest'
import { refinementFacade } from '../src/refinement/facade.js'
import type { RefinementWorkspacePort, WorkspaceSaveRequest } from '../src/refinement/workspace.js'
import { textTurn, toolTurn } from './helpers/fake-provider.js'
import {
  type Answer,
  activeGoal,
  ids,
  open,
  output,
  QUOTE,
  REQUEST,
  type Seen,
  upsert,
} from './helpers/refinement-session.js'
import { ofType } from './helpers/side-call-session.js'

/** A host save path that records every request and answers `saved` unless told otherwise. */
function host(answer: (request: WorkspaceSaveRequest) => Partial<SaveReceipt> = () => ({})) {
  const asked: WorkspaceSaveRequest[] = []
  const workspace: RefinementWorkspacePort = {
    save: async (request) => {
      asked.push(request)
      return {
        receiptId: `rc-${request.commandId}`,
        commandId: request.commandId,
        initiator: request.initiator,
        source: {
          sessionKey: request.session.key,
          kind: request.entry.kind,
          entryId: request.entry.id,
          contentHash: 'c'.repeat(64),
          initiator: request.initiator,
        },
        outcome: 'saved',
        steps: [{ step: 'switch', verdict: 'pass' }],
        at: 1,
        ...answer(request),
      }
    },
  }
  return { asked, workspace }
}

const sw = (over: Partial<{ enabled: boolean; mode: 'manual' | 'auto' }> = {}) => ({
  enabled: true,
  mode: 'auto' as 'manual' | 'auto',
  revision: 'r1',
  ...over,
})

/** Waits for the run to end, then lets a hand-off that follows the apply finish. */
async function ended(t: Awaited<ReturnType<typeof open>>, runId: string) {
  await vi.waitFor(() =>
    expect(['applied', 'no-op', 'rejected', 'cancelled']).toContain(
      t.session.state.refinementRuns.get(runId)?.state,
    ),
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  return t.session.state.refinementRuns.get(runId) as RefinementRunRecord
}

const pair = () => [toolTurn('read', { path: 'b' }), toolTurn('read', { path: 'b' }), textTurn('ok')]
const grant = () => output({ edits: [upsert('read-b', { quote: QUOTE })], evidenceIds: ['e1'] })
/** Confirms `read-b` with every failed-then-successful read the planner was shown. */
const byTools = (seen: Seen) =>
  output({
    confirmations: [{ entryId: 'memory/read-b', evidenceIds: ids(seen, (e) => e.kind === 'tool') }],
    evidenceIds: ids(seen, (e) => e.kind === 'tool'),
  })
/** Confirms `read-b` with a quote of the later request. */
const byQuote = () =>
  output({
    confirmations: [{ entryId: 'memory/read-b', evidenceIds: ['e1'], quote: 'read b again' }],
    evidenceIds: ['e1'],
  })

/** A session-level entry `read-b`, granted by a quote, then a turn with a failed-then-successful read. */
async function confirmable(o: {
  answers: Answer[]
  workspace: RefinementWorkspacePort
  mode?: 'manual' | 'auto'
}) {
  const t = await open({
    scripts: [textTurn('ok'), ...pair(), ...pair()],
    reads: [false, true, false, true],
    answers: [grant, ...o.answers],
    workspace: o.workspace,
    sw: sw({ mode: o.mode ?? 'auto' }),
  })
  expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
  expect(await t.refine()).toMatchObject({ state: 'applied' })
  expect(await t.say('read b again')).toMatchObject({ reason: 'completed' })
  return t
}

const saveRows = async (t: Awaited<ReturnType<typeof open>>) => ofType(await t.rows(), REFINEMENT_SAVE_EVENT)

describe('automatic saves of confirmed entries', () => {
  it('a session entry a review wrote is offered once as an automatic save, at its first apply', async () => {
    const h = host()
    const t = await confirmable({ answers: [byTools, byQuote, byTools], workspace: h.workspace })
    await vi.waitFor(() => expect(h.asked).toHaveLength(1))
    expect(t.meta('read-b')?.confirmations.count).toBe(0)
    // A short, fixed-length id, scoped to this session and the content version; never the entry key.
    expect(h.asked[0]?.commandId).toMatch(/^auto:[0-9a-f]{48}$/u)
    // The review that wrote it is the first time it was seen to hold.
    expect(h.asked[0]).toMatchObject({
      initiator: 'auto',
      confirmations: 1,
      entry: { kind: 'memory', id: 'read-b', applicability: 'session' },
    })
    expect(await saveRows(t)).toHaveLength(1)
    // Later confirmations of the same content version offer nothing more.
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    expect(t.meta('read-b')?.confirmations.count).toBe(1)
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    expect(t.meta('read-b')?.confirmations.count).toBe(2)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.asked).toHaveLength(1)
    await t.session.close()
  })

  it('a refused offer is not repeated for the same content version', async () => {
    const h = host(() => ({ outcome: 'refused', reason: 'memory-off', steps: [] }))
    const t = await confirmable({ answers: [byTools, byQuote, byTools], workspace: h.workspace })
    await vi.waitFor(() => expect(h.asked).toHaveLength(1))
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    expect(await t.say('read b once more')).toMatchObject({ reason: 'completed' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.asked).toHaveLength(1)
    await t.session.close()
  })

  it('a direct proposal has no review behind it and is offered only once a review confirms it', async () => {
    const h = host()
    const t = await open({ workspace: h.workspace, answers: [] })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    const outcome = await refinementFacade(t.session).propose({
      rationale: 'The user said which file to read.',
      evidenceSeqs: [1],
      edits: [{ op: 'upsert', kind: 'memory', id: 'read-b', title: 'Read b', content: 'Read b.' }],
    })
    await ended(t, (outcome as { runId: string }).runId)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(t.entries()).toEqual(['read-b'])
    expect(h.asked).toHaveLength(0)
    await t.session.close()
  })

  it('manual mode never offers auto saves', async () => {
    const h = host()
    const t = await confirmable({ answers: [byTools, byQuote], workspace: h.workspace, mode: 'manual' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    expect(t.meta('read-b')?.confirmations.count).toBe(2)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(h.asked).toHaveLength(0)
    expect(await saveRows(t)).toHaveLength(0)
    await t.session.close()
  })
})

describe('saving the result of a run to the workspace', () => {
  it('/refine with saveTo saves each applied session entry as user', async () => {
    const h = host()
    let guidance: Seen['guidance']
    const t = await open({
      workspace: h.workspace,
      answers: [
        (seen) => {
          guidance = seen.guidance
          return output({
            edits: [upsert('kept', { quote: QUOTE }), upsert('for-task', { applicability: 'task' })],
            evidenceIds: ['e1'],
          })
        },
      ],
    })
    t.goal.current = activeGoal
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    const outcome = await refinementFacade(t.session).request({
      kind: 'manual',
      seq: t.session.lastSeq,
      saveTo: 'workspace',
    })
    const run = await ended(t, (outcome as { runId: string }).runId)
    expect(run).toMatchObject({ state: 'applied', trigger: { kind: 'manual', saveTo: 'workspace' } })
    // The planner is told its result is saved to the workspace.
    expect(guidance?.saveTo).toBe('workspace')
    await vi.waitFor(() => expect(h.asked).toHaveLength(2))
    // Every written upsert goes to the host as the user's: the task-level one too, for the host to refuse.
    expect(h.asked.map((r) => [r.initiator, r.entry.id, r.entry.applicability, r.runId])).toEqual([
      ['user', 'kept', 'session', run.runId],
      ['user', 'for-task', 'task', run.runId],
    ])
    expect(await saveRows(t)).toHaveLength(2)
    await t.session.close()
  })

  it('/refine saveTo user offers each applied entry to user memory as the user, in either mode', async () => {
    for (const mode of ['manual', 'auto'] as const) {
      const h = host()
      let guidance: Seen['guidance']
      const t = await open({
        workspace: h.workspace,
        sw: sw({ mode }),
        answers: [
          (seen) => {
            guidance = seen.guidance
            return output({
              edits: [upsert('kept', { quote: QUOTE }), upsert('for-task', { applicability: 'task' })],
              evidenceIds: ['e1'],
            })
          },
        ],
      })
      t.goal.current = activeGoal
      expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
      const outcome = await refinementFacade(t.session).request({
        kind: 'manual',
        seq: t.session.lastSeq,
        saveTo: 'user',
      })
      const run = await ended(t, (outcome as { runId: string }).runId)
      expect(run).toMatchObject({ state: 'applied', trigger: { kind: 'manual', saveTo: 'user' } })
      expect(guidance?.saveTo).toBe('user')
      await vi.waitFor(() => expect(h.asked).toHaveLength(2))
      // The user's own request: no confirmation count, and the host judges every entry.
      expect(h.asked.map((r) => [r.initiator, r.target, r.entry.id, r.runId])).toEqual([
        ['user', 'user', 'kept', run.runId],
        ['user', 'user', 'for-task', run.runId],
      ])
      await t.session.close()
    }
  })

  it('the model asking for user memory is saved as the model, in auto mode only', async () => {
    const h = host()
    let guidance: Seen['guidance']
    const t = await open({
      workspace: h.workspace,
      answers: [
        (seen) => {
          guidance = seen.guidance
          return grant()
        },
      ],
    })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    const outcome = await refinementFacade(t.session).request({
      kind: 'model',
      seq: t.session.lastSeq,
      saveTo: 'user',
    })
    const run = await ended(t, (outcome as { runId: string }).runId)
    expect(run).toMatchObject({ state: 'applied', trigger: { kind: 'model', saveTo: 'user' } })
    expect(guidance).toMatchObject({ trigger: 'model', saveTo: 'user' })
    await vi.waitFor(() => expect(h.asked).toHaveLength(1))
    expect(h.asked[0]).toMatchObject({ initiator: 'model', target: 'user', entry: { id: 'read-b' } })
    // A direct proposal is the same: applied to the session, then saved to user memory as the model's.
    const proposal = {
      rationale: 'The user said which file to read.',
      evidenceSeqs: [1],
      edits: [
        { op: 'upsert' as const, kind: 'memory' as const, id: 'read-c', title: 'Read c', content: 'Read c.' },
      ],
    }
    const proposed = await refinementFacade(t.session).propose(proposal, { saveTo: 'user' })
    await ended(t, (proposed as { runId: string }).runId)
    await vi.waitFor(() => expect(h.asked).toHaveLength(2))
    expect(h.asked[1]).toMatchObject({ initiator: 'model', target: 'user', entry: { id: 'read-c' } })
    await t.session.close()

    // In manual mode the model is refused, as for the workspace, and nothing is written.
    const m = await open({ workspace: h.workspace, sw: sw({ mode: 'manual' }), answers: [grant] })
    expect(await m.say(REQUEST)).toMatchObject({ reason: 'completed' })
    const before = m.session.lastSeq
    expect(await refinementFacade(m.session).request({ kind: 'model', seq: before, saveTo: 'user' })).toEqual(
      { refused: 'manual-mode' },
    )
    expect(await refinementFacade(m.session).propose(proposal, { saveTo: 'user' })).toEqual({
      refused: 'manual-mode',
    })
    expect(m.session.lastSeq).toBe(before)
    await m.session.close()
  })

  it('a trigger with no one behind it can never ask for user memory', async () => {
    const h = host()
    const t = await open({ workspace: h.workspace, answers: [grant] })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    const before = t.session.lastSeq
    for (const kind of ['compaction', 'repeated-failure'] as const)
      expect(await refinementFacade(t.session).request({ kind, seq: before, saveTo: 'user' })).toEqual({
        refused: 'invalid',
        detail: 'saveTo',
      })
    expect(t.session.lastSeq).toBe(before)
    expect(h.asked).toHaveLength(0)
    await t.session.close()
  })

  it('a request for user memory without a host save path is refused before anything is queued', async () => {
    const u = await open()
    expect(await u.say(REQUEST)).toMatchObject({ reason: 'completed' })
    const at = u.session.lastSeq
    expect(await refinementFacade(u.session).request({ kind: 'manual', seq: at, saveTo: 'user' })).toEqual({
      refused: 'unavailable',
      detail: 'user',
    })
    expect(u.session.lastSeq).toBe(at)
    await u.session.close()
  })

  it('with refinement off a request for user memory is refused and writes nothing', async () => {
    const switchState = sw()
    const h = host()
    const off = await open({ workspace: h.workspace, sw: switchState, answers: [grant] })
    expect(await off.say(REQUEST)).toMatchObject({ reason: 'completed' })
    switchState.enabled = false
    const before = off.session.lastSeq
    expect(
      await refinementFacade(off.session).request({ kind: 'manual', seq: before, saveTo: 'user' }),
    ).toEqual({ refused: 'refinement-off' })
    expect(off.session.lastSeq).toBe(before)
    expect(h.asked).toHaveLength(0)
    await off.session.close()
  })

  it('in manual mode a run without saveTo saves nothing and tells the planner nothing about the workspace', async () => {
    const h = host()
    let guidance: Seen['guidance']
    const t = await open({
      workspace: h.workspace,
      sw: sw({ mode: 'manual' }),
      answers: [
        (seen) => {
          guidance = seen.guidance
          return grant()
        },
      ],
    })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(guidance).not.toHaveProperty('saveTo')
    expect(h.asked).toHaveLength(0)
    await t.session.close()
  })

  it('harness_refine with target workspace runs the same flow as /refine --workspace', async () => {
    const h = host()
    let guidance: Seen['guidance']
    const t = await open({
      workspace: h.workspace,
      answers: [
        (seen) => {
          guidance = seen.guidance
          return grant()
        },
      ],
    })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    const outcome = await refinementFacade(t.session).request({
      kind: 'model',
      seq: t.session.lastSeq,
      saveTo: 'workspace',
    })
    const run = await ended(t, (outcome as { runId: string }).runId)
    expect(run).toMatchObject({ state: 'applied' })
    expect(guidance).toMatchObject({ trigger: 'model', saveTo: 'workspace' })
    await vi.waitFor(() => expect(h.asked).toHaveLength(1))
    // The model's request is the model's, whatever it asked for.
    expect(h.asked[0]).toMatchObject({ initiator: 'model', entry: { id: 'read-b' }, runId: run.runId })
    await t.session.close()
  })

  it('harness_propose with target workspace applies to the session then saves as model', async () => {
    const h = host()
    const t = await open({ workspace: h.workspace })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    const proposal = {
      rationale: 'The user said which file to read.',
      evidenceSeqs: [1],
      edits: [
        { op: 'upsert' as const, kind: 'memory' as const, id: 'read-b', title: 'Read b', content: 'Read b.' },
      ],
    }
    const outcome = await refinementFacade(t.session).propose(proposal, { saveTo: 'workspace' })
    const run = await ended(t, (outcome as { runId: string }).runId)
    expect(run).toMatchObject({ state: 'applied', trigger: { kind: 'model', saveTo: 'workspace' } })
    // Applied to the session first: the entry is in force here whatever the save comes to.
    expect(t.entries()).toEqual(['read-b'])
    await vi.waitFor(() => expect(h.asked).toHaveLength(1))
    expect(h.asked[0]).toMatchObject({
      initiator: 'model',
      evidenceSeqs: [1],
      entry: { id: 'read-b', applicability: 'session', content: 'Read b.' },
    })
    await t.session.close()
  })

  it('the model saves to the workspace only in auto mode, and only where the host offers saving', async () => {
    const switchState = sw({ mode: 'manual' })
    const h = host()
    const t = await open({ workspace: h.workspace, sw: switchState })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    const before = t.session.lastSeq
    const proposal = {
      rationale: 'r',
      evidenceSeqs: [1],
      edits: [{ op: 'upsert' as const, kind: 'memory' as const, id: 'm', title: 'M', content: 'Fact.' }],
    }
    expect(await refinementFacade(t.session).propose(proposal, { saveTo: 'workspace' })).toEqual({
      refused: 'manual-mode',
    })
    expect(
      await refinementFacade(t.session).request({
        kind: 'model',
        seq: t.session.lastSeq,
        saveTo: 'workspace',
      }),
    ).toEqual({ refused: 'manual-mode' })
    expect(t.session.lastSeq).toBe(before)
    // Without a host save path, a saving request is refused before anything is queued or planned.
    const u = await open()
    expect(await u.say(REQUEST)).toMatchObject({ reason: 'completed' })
    const at = u.session.lastSeq
    expect(await refinementFacade(u.session).propose(proposal, { saveTo: 'workspace' })).toEqual({
      refused: 'unavailable',
      detail: 'workspace',
    })
    for (const kind of ['manual', 'model'] as const)
      expect(
        await refinementFacade(u.session).request({ kind, seq: u.session.lastSeq, saveTo: 'workspace' }),
      ).toEqual({
        refused: 'unavailable',
        detail: 'workspace',
      })
    expect(u.session.lastSeq).toBe(at)
    expect(h.asked).toHaveLength(0)
    await t.session.close()
    await u.session.close()
  })

  it('child sessions and forks are refused', async () => {
    const h = host()
    for (const make of [
      (d: Record<string, unknown>) => {
        d.roleDelegation = {}
      },
      (d: Record<string, unknown>) => {
        Object.defineProperty(d.log as object, 'parent', { value: 'parent-session', configurable: true })
      },
    ]) {
      const t = await open({ workspace: h.workspace })
      expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
      make(t.session.d as unknown as Record<string, unknown>)
      const before = t.session.lastSeq
      const facade = refinementFacade(t.session)
      for (const kind of ['manual', 'model'] as const)
        expect(await facade.request({ kind, seq: before, saveTo: 'workspace' })).toEqual({
          refused: 'child-session',
        })
      expect(
        await facade.propose(
          {
            rationale: 'r',
            evidenceSeqs: [1],
            edits: [{ op: 'upsert', kind: 'memory', id: 'm', title: 'M', content: 'Fact.' }],
          },
          { saveTo: 'workspace' },
        ),
      ).toEqual({ refused: 'child-session' })
      expect(t.session.lastSeq).toBe(before)
      await t.session.close()
    }
    expect(h.asked).toHaveLength(0)
  })

  it('with refinement off every entry point refuses and writes nothing', async () => {
    const switchState = sw()
    const h = host()
    const off = await open({ workspace: h.workspace, sw: switchState, answers: [grant] })
    expect(await off.say(REQUEST)).toMatchObject({ reason: 'completed' })
    switchState.enabled = false
    const before = off.session.lastSeq
    const facade = refinementFacade(off.session)
    for (const kind of ['manual', 'model'] as const)
      expect(await facade.request({ kind, seq: before, saveTo: 'workspace' })).toEqual({
        refused: 'refinement-off',
      })
    expect(
      await facade.propose(
        {
          rationale: 'r',
          evidenceSeqs: [1],
          edits: [{ op: 'upsert', kind: 'memory', id: 'm', title: 'M', content: 'Fact.' }],
        },
        { saveTo: 'workspace' },
      ),
    ).toEqual({ refused: 'refinement-off' })
    // Nothing applies while off, so nothing is offered automatically either.
    await facade.afterTurn()
    expect(off.session.lastSeq).toBe(before)
    expect(h.asked).toHaveLength(0)
    await off.session.close()
  })
})

describe('a hand-off cut short', () => {
  it('a reopened session offers the saves an applied run still owes, once', async () => {
    const h = host()
    const t = await open({ workspace: h.workspace, answers: [grant] })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    // The host is unreachable while the run applies: the save is not recorded.
    const save = h.workspace.save
    h.workspace.save = async () => {
      throw new Error('host gone')
    }
    const outcome = await refinementFacade(t.session).request({
      kind: 'manual',
      seq: t.session.lastSeq,
      saveTo: 'workspace',
    })
    expect(await ended(t, (outcome as { runId: string }).runId)).toMatchObject({ state: 'applied' })
    expect(await saveRows(t)).toHaveLength(0)
    h.workspace.save = save
    const { recoverRefinement } = await import('../src/refinement/facade.js')
    await recoverRefinement(t.session)
    await vi.waitFor(() => expect(h.asked).toHaveLength(1))
    expect(h.asked[0]).toMatchObject({ initiator: 'user', entry: { id: 'read-b' } })
    // Once recorded, a later recovery offers nothing more.
    await recoverRefinement(t.session)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.asked).toHaveLength(1)
    expect(await saveRows(t)).toHaveLength(1)
    await t.session.close()
  })

  it('owed saves are offered in the background, at most twenty per reopen', async () => {
    const h = host()
    // Five runs of five entries each (for the task at hand: every one is written, and each is still
    // handed over for the host to judge), applied while the host cannot be reached: 25 saves owed.
    const five = (n: number) => () =>
      output({
        edits: [0, 1, 2, 3, 4].map((i) => upsert(`m${n}-${i}`, { applicability: 'task' })),
        evidenceIds: ['e1'],
      })
    const t = await open({ workspace: h.workspace, answers: [0, 1, 2, 3, 4].map(five) })
    t.goal.current = activeGoal
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    const save = h.workspace.save
    h.workspace.save = async () => {
      throw new Error('host gone')
    }
    for (let n = 0; n < 5; n++) {
      if (n > 0) expect(await t.say(`task ${n}: ${QUOTE}`)).toMatchObject({ reason: 'completed' })
      const outcome = await refinementFacade(t.session).request({
        kind: 'manual',
        seq: t.session.lastSeq,
        saveTo: 'workspace',
      })
      expect(await ended(t, (outcome as { runId: string }).runId)).toMatchObject({ state: 'applied' })
    }
    // A host that never answers does not hold up the reopen.
    let release: () => void = () => undefined
    h.workspace.save = (request) =>
      new Promise((resolve) => {
        release = () => resolve(save(request) as never)
      })
    const { recoverRefinement } = await import('../src/refinement/facade.js')
    const opened = await Promise.race([
      recoverRefinement(t.session).then(() => 'opened'),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 200)),
    ])
    expect(opened).toBe('opened')
    release()
    h.workspace.save = save
    await vi.waitFor(() => expect(h.asked).toHaveLength(20))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(h.asked).toHaveLength(20)
    // Run saves carry the run id and a fixed-length hash of the entry, never the entry key.
    for (const request of h.asked) {
      expect(request.commandId).toMatch(/^[0-9A-Z]{26}:[0-9a-f]{32}$/u)
      expect(request.commandId).not.toContain(String.fromCharCode(0))
    }
    // The next reopen offers the rest.
    await recoverRefinement(t.session)
    await vi.waitFor(() => expect(h.asked).toHaveLength(25))
    await t.session.close()
  })
})
