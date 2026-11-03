import type { Event } from '@agnes/core-common/types'
import { foldEvents } from '@agnes/core-ledger/reduce/reducer'
import { REFINEMENT_ENTRY_META_EVENT, type RefinementEntryMeta } from '@agnes/core-ledger/reduce/state'
import { describe, expect, it, vi } from 'vitest'
import { applyRefine, entryKey } from '../src/refine/apply.js'
import { counted, metaRow } from '../src/refinement/confirmations.js'
import { refinementFacade } from '../src/refinement/facade.js'
import { redactEvidence } from '../src/refinement/redact.js'
import { tryApply } from '../src/refinement/scheduler.js'
import { contentHash, entryValidity, targetOf } from '../src/refinement/validity.js'
import { textTurn, toolTurn } from './helpers/fake-provider.js'
import { actor } from './helpers/open-session.js'
import {
  type Answer,
  activeGoal,
  BODY,
  ids,
  open,
  output,
  QUOTE,
  REQUEST,
  type Seen,
  upsert,
} from './helpers/refinement-session.js'
import { data, ofType } from './helpers/side-call-session.js'

describe('validity levels', () => {
  it('no goal means no task-level grant, and a session-level edit is not downgraded for it', async () => {
    const plan: Answer = () =>
      output({
        edits: [upsert('asked-task', { applicability: 'task' }), upsert('asked-session')],
        evidenceIds: ['e1'],
      })
    const t = await open({ answers: [plan, plan] })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    const first = await t.refine()
    // The task-level edit has no goal to bind to and stays a record; the session-level one is granted.
    expect(first).toMatchObject({ state: 'applied' })
    expect(first?.plan?.edits).toEqual([
      expect.objectContaining({ id: 'asked-task', applicability: 'task', expired: true }),
      expect.objectContaining({ id: 'asked-session', applicability: 'session' }),
    ])
    expect(first?.plan?.edits[1]).not.toHaveProperty('downgraded')
    expect(t.entries()).toEqual(['asked-session'])

    // With a goal, the task-level edit binds to it; the session-level one still holds for the session.
    t.goal.current = activeGoal
    expect(await t.say('second task')).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    expect(t.meta('asked-task')).toMatchObject({
      applicability: 'task',
      taskScope: { id: 'goal-1', revision: 1 },
    })
    expect(t.meta('asked-session')).toMatchObject({ applicability: 'session' })
    await t.session.close()
  })

  it('a session without a task-scope reader never grants the task level', async () => {
    const t = await open({
      taskScope: false,
      answers: [
        () => output({ edits: [upsert('asked-task', { applicability: 'task' })], evidenceIds: ['e1'] }),
      ],
    })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'no-op', reason: 'expired' })
    expect(t.entries()).toEqual([])
    await t.session.close()
  })

  it('an edit asked at session level gets session level, whatever it quotes', async () => {
    const t = await open({
      answers: [
        () =>
          output({
            edits: [
              upsert('quoted', { quote: QUOTE }),
              upsert('unquoted'),
              // A short or altered quote used to cost the level; it no longer matters.
              upsert('short-quote', { quote: QUOTE.slice(0, 5) }),
              upsert('altered-quote', { quote: QUOTE.toUpperCase() }),
            ],
            evidenceIds: ['e1'],
          }),
      ],
    })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    const request = ofType(await t.rows(), 'user/message')[0] as Event
    const run = await t.refine()
    expect(run?.state).toBe('applied')
    expect(
      run?.plan?.edits.map((e) => [
        e.id,
        e.op === 'upsert' ? e.applicability : '',
        'expired' in e,
        'downgraded' in e,
      ]),
    ).toEqual([
      ['quoted', 'session', false, false],
      ['unquoted', 'session', false, false],
      ['short-quote', 'session', false, false],
      ['altered-quote', 'session', false, false],
    ])
    expect(t.entries()).toEqual(['quoted', 'unquoted', 'short-quote', 'altered-quote'])
    // The request it cites is spent: it can never confirm this content version.
    expect(t.meta('unquoted')).toMatchObject({
      applicability: 'session',
      confirmations: { count: 0, usedEvidence: [`user:${request.seq}`] },
    })
    expect(t.meta('unquoted')).not.toHaveProperty('taskScope')
    await t.session.close()
  })

  it('an edit citing tool results only gets session level too, and records no request of the user', async () => {
    const turn = [
      toolTurn('read', { path: 'docs/a.txt' }),
      toolTurn('read', { path: 'a.txt' }),
      textTurn('ok'),
    ]
    const t = await open({
      scripts: turn,
      reads: [false, true],
      answers: [
        (seen) =>
          output({ edits: [upsert('from-tools', { evidenceIds: ids(seen, (e) => e.kind === 'tool') })] }),
      ],
    })
    expect(await t.say('read the notes')).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    expect(t.meta('from-tools')).toMatchObject({
      applicability: 'session',
      confirmations: { count: 0, usedEvidence: [] },
    })
    expect(t.entries()).toEqual(['from-tools'])
    await t.session.close()
  })

  it('the target of a call is its program or its path', () => {
    expect(targetOf({ command: '/usr/bin/npm run build' })).toBe('command:npm')
    expect(targetOf({ command: 'npm test' })).toBe(targetOf({ command: '  npm   run lint' }))
    expect(targetOf({ path: 'src/a.ts/' })).toBe(targetOf({ path: 'src/a.ts' }))
    expect(targetOf({ pattern: 'x' })).toBeUndefined()
    expect(targetOf(null)).toBeUndefined()
  })
})

/** A session with one session-level entry granted by a quote, then a turn with a fail-success pair. */
async function confirmable(answers: Answer[]) {
  const pair = [toolTurn('read', { path: 'b' }), toolTurn('read', { path: 'b' }), textTurn('ok')]
  const t = await open({
    scripts: [textTurn('ok'), ...pair, ...pair],
    reads: [false, true, false, true],
    answers: [() => output({ edits: [upsert('read-b', { quote: QUOTE })], evidenceIds: ['e1'] }), ...answers],
  })
  expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
  expect(await t.refine()).toMatchObject({ state: 'applied' })
  expect(await t.say('read b again')).toMatchObject({ reason: 'completed' })
  return t
}
const confirm = (seen: Seen) =>
  output({
    confirmations: [{ entryId: 'memory/read-b', evidenceIds: ids(seen, (e) => e.kind === 'tool') }],
    evidenceIds: ids(seen, (e) => e.kind === 'tool'),
  })

describe('confirmations', () => {
  it('two runs citing the same failure-success pair count one confirmation', async () => {
    const t = await confirmable([confirm, confirm])
    const success = ofType(await t.rows(), 'tool/result').filter(
      (row) => data(row).isError !== true,
    )[0] as Event
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    expect(t.meta('read-b')?.confirmations).toEqual({
      count: 1,
      usedEvidence: [expect.stringMatching(/^user:/u), `tool:${success.seq}`],
    })
    expect(t.meta('read-b')?.lastConfirmedSeq).toBe(success.seq)
    // The second run cites the very same pair: it is the same evidence, so nothing more is counted
    // and no metadata row is written for it.
    const before = await t.rows()
    // With nothing new to count, the run applies nothing: no empty `harness/refine` row is written.
    expect(await t.refine()).toMatchObject({ state: 'no-op' })
    expect(t.meta('read-b')?.confirmations.count).toBe(1)
    const after = await t.rows()
    expect(ofType(after, REFINEMENT_ENTRY_META_EVENT)).toHaveLength(
      ofType(before, REFINEMENT_ENTRY_META_EVENT).length,
    )
    expect(ofType(after, 'harness/refine')).toHaveLength(ofType(before, 'harness/refine').length)
    await t.session.close()
  })

  it('the evidence that granted the level never confirms it; a user confirmation counts once', async () => {
    const t = await confirmable([
      // A quote of the newer request confirms the entry.
      () =>
        output({
          confirmations: [{ entryId: 'memory/read-b', evidenceIds: ['e1'], quote: 'read b again' }],
          evidenceIds: ['e1'],
        }),
    ])
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    // `read b again` is 12 characters of the newer request, so it counts once.
    expect(t.meta('read-b')?.confirmations.count).toBe(1)
    // The request that granted the level is spent: citing it again counts nothing.
    const meta = t.meta('read-b') as RefinementEntryMeta
    const granted = meta.confirmations.usedEvidence.find((u) => u.startsWith('user:')) as string
    const seq = Number(granted.slice('user:'.length))
    expect(counted(meta, { identity: granted, seq })).toBeUndefined()
    // A user's own confirmation counts once per content version.
    const byUser = counted(meta, { identity: 'user-action', seq: 999 })
    expect(byUser?.confirmations.count).toBe(2)
    expect(
      counted(byUser as NonNullable<typeof byUser>, { identity: 'user-action', seq: 1000 }),
    ).toBeUndefined()
    await t.session.close()
  })

  it('a content change resets the count', async () => {
    const t = await confirmable([
      confirm,
      // Only the title changes: the content version is the same, so the count stays.
      (seen) =>
        output({
          edits: [
            upsert('read-b', { title: 'renamed', content: seen.entries[0]?.content, quote: 'read b again' }),
          ],
          evidenceIds: ['e1'],
        }),
      // The content changes: a new version, counted from nothing.
      () =>
        output({
          edits: [upsert('read-b', { content: 'Read b first.', quote: 'read b again' })],
          evidenceIds: ['e1'],
        }),
      // The pair before the new version cannot confirm it.
      confirm,
    ])
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    expect(t.meta('read-b')?.confirmations.count).toBe(1)
    const firstHash = t.meta('read-b')?.contentHash
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    expect(t.meta('read-b')).toMatchObject({ contentHash: firstHash, confirmations: { count: 1 } })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    const reset = t.meta('read-b') as RefinementEntryMeta
    expect(reset.contentHash).not.toBe(firstHash)
    expect(reset.confirmations.count).toBe(0)
    expect(reset.confirmations.usedEvidence.every((u) => !u.startsWith('tool:'))).toBe(true)
    expect(reset).not.toHaveProperty('lastConfirmedSeq')
    // Nothing on that plan counts, so there is nothing to apply.
    expect(await t.refine()).toMatchObject({ state: 'no-op' })
    expect(t.meta('read-b')?.confirmations.count).toBe(0)
    await t.session.close()
  })
})

describe('expiry', () => {
  it('task entries expire when the goal completes and produce a control notice', async () => {
    const t = await open({
      answers: [
        () =>
          output({
            edits: [
              upsert('for-task', { applicability: 'task', content: 'TASK-ONLY: skip the slow suite.' }),
              upsert('for-session', { quote: QUOTE, content: 'SESSION-WIDE: read b, not a.' }),
            ],
            evidenceIds: ['e1'],
          }),
        (seen) => {
          // Once its goal is complete the planner is no longer offered the expired entry.
          expect(seen.entries.map((e) => e.id)).toEqual(['for-session'])
          expect(seen.activeGoal).toBe(false)
          return output({})
        },
      ],
    })
    t.goal.current = activeGoal
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    expect(await t.say('second task')).toMatchObject({ reason: 'completed' })
    expect(t.lastRequest()).toContain('TASK-ONLY')
    expect(t.lastRequest()).toContain('SESSION-WIDE')

    // A pause or a new revision of the same goal is the same task.
    t.goal.current = { ...activeGoal, revision: 2, phase: 'paused' }
    expect(entryValidity(t.session.state, t.goal.current).expired).toEqual([])

    t.goal.current = { ...activeGoal, revision: 3, phase: 'complete' }
    const before = t.requests.length
    expect(await t.say('third task')).toMatchObject({ reason: 'completed' })
    const notes = ofType(await t.rows(), 'user/message').filter((row) =>
      JSON.stringify(row.data).includes('Task experience control'),
    )
    expect(notes).toHaveLength(1)
    expect(JSON.stringify(notes[0]?.data)).toContain('[memory/for-task v1] expired')
    expect(JSON.stringify(notes[0]?.data)).not.toContain('for-session')
    expect(t.requests.length).toBeGreaterThan(before)
    // Expiry is derived: nothing was written to the entry or its metadata.
    expect(t.entries()).toEqual(['for-task', 'for-session'])
    const { valid, expired } = entryValidity(t.session.state, null)
    expect(valid.map((v) => v.entry.id)).toEqual(['for-session'])
    expect(expired.map((v) => v.entry.id)).toEqual(['for-task'])

    // Announced once: the next request finds the notice on the surface and sends nothing new.
    expect(await t.say('fourth task')).toMatchObject({ reason: 'completed' })
    expect(
      ofType(await t.rows(), 'user/message').filter((row) => JSON.stringify(row.data).includes('expired:')),
    ).toHaveLength(1)
    expect(await t.refine()).toMatchObject({ state: 'no-op' })
    await t.session.close()
  })

  it('a task edit whose goal ended before it was applied is not applied', async () => {
    const t = await open({
      answers: [() => output({ edits: [upsert('late', { applicability: 'task' })], evidenceIds: ['e1'] })],
    })
    t.goal.current = activeGoal
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    // Planned while the goal is active; held proposed by a pause, and applied after the goal was
    // replaced by another one.
    const pause = (paused: boolean) =>
      t.session.append([
        t.session.ev('x/core/pause-state', { paused }, { actor, origin: 'principal', ignorable: true }),
      ])
    await pause(true)
    const outcome = await refinementFacade(t.session).request({ kind: 'manual', seq: t.session.lastSeq })
    const runId = (outcome as { runId: string }).runId
    await vi.waitFor(() => expect(t.session.state.refinementRuns.get(runId)?.state).toBe('proposed'))
    expect(t.session.state.refinementRuns.get(runId)?.plan?.edits[0]).toMatchObject({
      applicability: 'task',
      taskScope: { id: 'goal-1', revision: 1 },
    })
    t.goal.current = { id: 'goal-2', revision: 1, phase: 'active' }
    await pause(false)
    expect(await tryApply(t.session, runId)).toBe('rejected')
    expect(t.session.state.refinementRuns.get(runId)).toMatchObject({ state: 'rejected', reason: 'expired' })
    expect(t.entries()).toEqual([])
    await t.session.close()
  })
})

describe('forks', () => {
  it('fork inherits valid session entries, counts and used evidence', async () => {
    const t = await confirmable([
      confirm,
      () => output({ edits: [upsert('for-task', { applicability: 'task' })], evidenceIds: ['e1'] }),
    ])
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    t.goal.current = activeGoal
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    const parent = await t.rows()
    const parentMeta = t.meta('read-b') as RefinementEntryMeta
    expect(parentMeta.confirmations.count).toBe(1)

    // A fork's ledger holds the parent's rows up to the cut, then its own start.
    const cut = parent.at(-1) as Event
    const start = {
      ...cut,
      seq: cut.seq + 1,
      type: 'session/start',
      lane: 'main',
      ignorable: undefined,
      data: {
        key: 'child',
        resolvedProfileHash: null,
        preset: 'standard',
        agnesVersion: '0.0.1',
        parent: { key: t.session.key, boundarySeq: cut.seq },
        delegation: { kind: 'fork', creationId: 'c1', rootTaskId: 'r1', generationDepth: 1 },
      },
    } as unknown as Event
    const child = foldEvents([...parent, start])
    const key = entryKey({ kind: 'memory', id: 'read-b' })
    expect(child.refinementEntryMeta.get(key)).toEqual(parentMeta)
    // In the child the session entry holds with its count and spent evidence; the task entry is not
    // active there, whatever goal the child may have.
    const { valid, expired } = entryValidity(child, null)
    expect(valid.map((v) => [v.entry.id, v.meta?.confirmations])).toEqual([
      ['read-b', parentMeta.confirmations],
    ])
    expect(expired.map((v) => v.entry.id)).toEqual(['for-task'])
    await t.session.close()
  })
})

describe('the metadata row', () => {
  it('is bound to the entry row it was written after, and ignored for an entry that does not exist', async () => {
    const t = await confirmable([])
    const all = await t.rows()
    const entry = ofType(all, 'harness/entry')[0] as Event
    const meta = ofType(all, REFINEMENT_ENTRY_META_EVENT)[0] as Event
    // Written in the same transaction, after the entry row.
    expect(meta.seq).toBeGreaterThan(entry.seq)
    expect(t.meta('read-b')).toMatchObject({ entrySeq: entry.seq, seq: meta.seq })
    const forged = { ...meta, seq: t.session.lastSeq + 1, data: { ...(meta.data as object), id: 'nothing' } }
    const untrusted = {
      ...meta,
      seq: t.session.lastSeq + 2,
      trust: 'untrusted',
      data: { ...(meta.data as object), applicability: 'task' },
    }
    const state = foldEvents([...all, forged, untrusted] as Event[])
    expect(state.refinementEntryMeta.has(entryKey({ kind: 'memory', id: 'nothing' }))).toBe(false)
    expect(state.refinementEntryMeta.get(entryKey({ kind: 'memory', id: 'read-b' }))?.applicability).toBe(
      'session',
    )
    await t.session.close()
  })
})

describe('reusing, overlapping and unreadable', () => {
  it('an expired task entry does not block its id: a plan and a direct proposal may reuse it', async () => {
    const task = (content: string) => () =>
      output({ edits: [upsert('run-tests', { applicability: 'task', content })], evidenceIds: ['e1'] })
    const t = await open({ answers: [task('Run the unit tests first.'), task('Run the slow tests last.')] })
    t.goal.current = activeGoal
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    // goal-1 is completed and goal-2 starts: the old entry has expired, and the planner is not shown it.
    t.goal.current = { id: 'goal-2', revision: 1, phase: 'active' }
    expect(await t.say('second task')).toMatchObject({ reason: 'completed' })
    const reused = await t.refine()
    expect(reused).toMatchObject({ state: 'applied' })
    // The new version is written against the expired one's version and token, as its baseline, and
    // the plan records that it relied on the entry being lapsed.
    expect(reused?.plan?.baseline).toEqual([
      { kind: 'memory', id: 'run-tests', version: 1, seq: expect.any(Number) },
    ])
    expect(reused?.plan?.lapsed).toEqual([{ kind: 'memory', id: 'run-tests' }])
    const cell = () =>
      t.session.state.registers.harnessEntries.get(entryKey({ kind: 'memory', id: 'run-tests' }))
    expect(cell()?.value).toMatchObject({ version: 2, content: 'Run the slow tests last.' })
    expect(t.meta('run-tests')).toMatchObject({ taskScope: { id: 'goal-2' }, confirmations: { count: 0 } })

    // Again for a direct proposal, once goal-2 has ended too.
    t.goal.current = { id: 'goal-3', revision: 1, phase: 'active' }
    const request = ofType(await t.rows(), 'user/message').at(-1) as Event
    const outcome = await refinementFacade(t.session).propose({
      rationale: 'The suite moved.',
      evidenceSeqs: [request.seq],
      edits: [{ op: 'upsert', kind: 'memory', id: 'run-tests', title: 'Tests', content: 'Run make test.' }],
    })
    expect(outcome).toHaveProperty('runId')
    expect(t.session.state.refinementRuns.get((outcome as { runId: string }).runId)?.state).toBe('applied')
    expect(cell()?.value).toMatchObject({ version: 3, content: 'Run make test.' })
    // An entry still in force keeps its id: a direct proposal must read it first.
    expect(
      await refinementFacade(t.session).propose({
        rationale: 'Again.',
        evidenceSeqs: [request.seq],
        edits: [{ op: 'upsert', kind: 'memory', id: 'run-tests', title: 'Tests', content: 'x' }],
      }),
    ).toMatchObject({ refused: 'read-first' })
    await t.session.close()
  })

  it('a lapsed id is reused without a read, an id in force still needs one, and inspect shows neither lapsed nor held', async () => {
    const t = await open({
      answers: [
        () =>
          output({
            edits: [
              upsert('run-tests', { applicability: 'task', content: 'TASK-ONLY: run the unit tests first.' }),
              upsert('read-b', { quote: QUOTE, content: 'SESSION-WIDE: read b, not a.' }),
            ],
            evidenceIds: ['e1'],
          }),
      ],
    })
    const facade = refinementFacade(t.session)
    const listed = async () => {
      const out = await facade.inspect({ op: 'list', kind: 'memory' })
      return 'entries' in out ? out.entries.map((e) => e.id) : out
    }
    const searched = async (query: string) => {
      const out = await facade.inspect({ op: 'search', query })
      return 'entries' in out ? out.entries.map((e) => e.id) : out
    }
    t.goal.current = activeGoal
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    expect(await listed()).toEqual(['read-b', 'run-tests'])

    // While the goal cannot be read, the task entry is held: inspect shows it in no form.
    t.goal.current = 'unreadable'
    expect(await listed()).toEqual(['read-b'])
    expect(await searched('unit tests first')).toEqual([])
    expect(await facade.inspect({ op: 'get', id: 'memory/run-tests' })).toEqual({
      refused: 'not-found',
      detail: 'memory/run-tests',
    })

    // goal-1 ends and goal-2 starts: the task entry has lapsed, and inspect does not return it either.
    t.goal.current = { id: 'goal-2', revision: 1, phase: 'active' }
    expect(await t.say('second task')).toMatchObject({ reason: 'completed' })
    expect(await listed()).toEqual(['read-b'])
    expect(await searched('unit tests first')).toEqual([])
    expect(await facade.inspect({ op: 'get', id: 'run-tests' })).toEqual({
      refused: 'not-found',
      detail: 'run-tests',
    })

    const request = ofType(await t.rows(), 'user/message').at(-1) as Event
    const direct = (id: string, content: string) =>
      facade.propose({
        rationale: 'The suite moved.',
        evidenceSeqs: [request.seq],
        edits: [{ op: 'upsert', kind: 'memory', id, title: id, content }],
      })
    const cell = (id: string) =>
      t.session.state.registers.harnessEntries.get(entryKey({ kind: 'memory', id }))
    // The lapsed id is reused without a read, against the lapsed version as its baseline.
    const reused = await direct('run-tests', 'Run make test.')
    expect(reused).toHaveProperty('runId')
    const run = t.session.state.refinementRuns.get((reused as { runId: string }).runId)
    expect(run).toMatchObject({ state: 'applied' })
    expect(run?.plan?.baseline).toEqual([
      { kind: 'memory', id: 'run-tests', version: 1, seq: expect.any(Number) },
    ])
    expect(run?.plan?.lapsed).toEqual([{ kind: 'memory', id: 'run-tests' }])
    expect(cell('run-tests')?.value).toMatchObject({ version: 2, content: 'Run make test.' })

    // The entry in force keeps its id: read-first until it is read in full at its current version.
    expect(await direct('read-b', 'Read c.')).toEqual({ refused: 'read-first', detail: 'memory/read-b' })
    expect(await facade.inspect({ op: 'get', id: 'memory/read-b' })).toMatchObject({
      op: 'get',
      entry: { id: 'read-b', version: 1, truncated: false },
    })
    expect(await direct('read-b', 'Read c.')).toHaveProperty('runId')
    expect(cell('read-b')?.value).toMatchObject({ version: 2, content: 'Read c.' })
    await t.session.close()
  })

  it('an unreadable task scope announces nothing and changes nothing until it reads again', async () => {
    const t = await open({
      answers: [
        () =>
          output({
            edits: [
              upsert('for-task', { applicability: 'task', content: 'TASK-ONLY: skip the slow suite.' }),
            ],
            evidenceIds: ['e1'],
          }),
      ],
    })
    t.goal.current = activeGoal
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    expect(await t.say('second task')).toMatchObject({ reason: 'completed' })
    expect(t.lastRequest()).toContain('TASK-ONLY')
    const controls = async () =>
      ofType(await t.rows(), 'user/message').filter((row) => JSON.stringify(row.data).includes('expired:'))

    // The goal plugin is being reloaded: its scope cannot be read. Nothing is announced or written.
    t.goal.current = 'unreadable'
    const before = (await t.rows()).filter((row) => row.type.startsWith('x/core/refinement')).length
    expect(await t.say('third task')).toMatchObject({ reason: 'completed' })
    expect(await controls()).toEqual([])
    expect((await t.rows()).filter((row) => row.type.startsWith('x/core/refinement'))).toHaveLength(before)
    expect(entryValidity(t.session.state, activeGoal).valid.map((v) => v.entry.id)).toEqual(['for-task'])

    // It reads again, the same goal: still in force, still nothing to announce.
    t.goal.current = activeGoal
    expect(await t.say('fourth task')).toMatchObject({ reason: 'completed' })
    expect(await controls()).toEqual([])
    await t.session.close()
  })

  it('an entry withdrawn and in force again is given to the model again', async () => {
    const t = await open({
      answers: [
        () =>
          output({
            edits: [
              upsert('for-task', { applicability: 'task', content: 'TASK-ONLY: skip the slow suite.' }),
            ],
            evidenceIds: ['e1'],
          }),
      ],
    })
    t.goal.current = activeGoal
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    expect(await t.say('second task')).toMatchObject({ reason: 'completed' })
    // The goal reads as complete for a moment: the model is told the entry expired.
    t.goal.current = { ...activeGoal, phase: 'complete' }
    expect(await t.say('third task')).toMatchObject({ reason: 'completed' })
    const notes = async () =>
      ofType(await t.rows(), 'user/message').filter((row) => JSON.stringify(row.data).includes('TASK-ONLY'))
    const delivered = (await notes()).length
    // Then it is active again: the entry is in force, so the model is given it again.
    t.goal.current = activeGoal
    expect(await t.say('fourth task')).toMatchObject({ reason: 'completed' })
    expect((await notes()).length).toBe(delivered + 1)
    expect(await t.say('fifth task')).toMatchObject({ reason: 'completed' })
    expect((await notes()).length).toBe(delivered + 1)
    await t.session.close()
  })

  it('a harness_inspect result echoing an entry cannot confirm it', async () => {
    // The inspect tool itself is not registered here; a tool of that name and argument shape stands in.
    const inspect = [
      toolTurn('harness_inspect', { op: 'get', id: 'memory/read-b' }),
      toolTurn('harness_inspect', { op: 'get', id: 'memory/read-b' }),
      textTurn('ok'),
    ]
    const t = await open({
      scripts: [textTurn('ok'), ...inspect],
      tools: { harness_inspect: [false, true] },
      answers: [
        () => output({ edits: [upsert('read-b', { quote: QUOTE })], evidenceIds: ['e1'] }),
        (seen) => {
          const echoed = seen.evidence.filter((e) => e.tool === 'harness_inspect')
          expect(echoed.map((e) => e.isError)).toEqual([true, false])
          expect(echoed[1]?.text).toContain(BODY)
          return output({
            confirmations: [
              {
                entryId: 'memory/read-b',
                evidenceIds: echoed.map((e) => e.id),
                // Its echo of the entry is tool output, never the user's own words.
                quote: BODY.slice(0, 20),
              },
            ],
            evidenceIds: echoed.map((e) => e.id),
          })
        },
      ],
    })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    expect(await t.say('look the entry up')).toMatchObject({ reason: 'completed' })
    const run = await t.refine()
    expect(run).toMatchObject({ state: 'no-op' })
    expect(run?.plan?.confirmations[0]).not.toHaveProperty('confirmedBy')
    expect(t.meta('read-b')?.confirmations.count).toBe(0)
    await t.session.close()
  })
})

describe('a reset on the update path', () => {
  it('re-sends every entry still in force, and what does not fit stays pending for the next request', async () => {
    const t = await open()
    t.goal.current = activeGoal
    let n = 0
    /** Writes entries as an apply would: the entry rows, then their metadata, in one transaction. */
    const write = (entries: { id: string; content: string; task?: boolean }[]) =>
      t.session.locked(() =>
        applyRefine(
          t.session,
          {
            proposalId: `seed-${++n}`,
            runId: `seed-${n}`,
            trigger: 'manual',
            edits: entries.map(({ id, content }) => ({
              op: 'upsert' as const,
              entry: {
                kind: 'memory' as const,
                id,
                title: id,
                content,
                scope: 'local' as const,
                version: 1,
                source: 'test',
              },
            })),
            baseline: [],
            rationale: 'fixture',
            evidenceSeqs: [1],
          },
          { maxEdits: 50, maxChars: 4000, safetyCap: 200 },
          {
            with: () =>
              entries.map(({ id, content, task }) =>
                metaRow(t.session, {
                  kind: 'memory',
                  id,
                  contentHash: contentHash(content),
                  applicability: task ? 'task' : 'session',
                  ...(task ? { taskScope: { id: activeGoal.id, revision: 1 } } : {}),
                  confirmations: { count: 0, usedEvidence: [] },
                }),
              ),
          },
        ),
      )
    const big = (i: number) => ({ id: `big-${i}`, content: `${`Fact ${i}: `.padEnd(1500, 'x')}.` })
    expect(await t.say('first task')).toMatchObject({ reason: 'completed' })
    // Delivered over three updates: two sets of large session entries, then many small task entries.
    await write([big(1), big(2), big(3)])
    expect(await t.say('second task')).toMatchObject({ reason: 'completed' })
    await write([big(4), big(5), big(6)])
    expect(await t.say('third task')).toMatchObject({ reason: 'completed' })
    await write(
      Array.from({ length: 12 }, (_, i) => ({
        id: `task-entry-number-${i}`,
        content: 'Skip it.',
        task: true,
      })),
    )
    expect(await t.say('fourth task')).toMatchObject({ reason: 'completed' })
    const notes = async () =>
      ofType(await t.rows(), 'user/message')
        .map((row) => JSON.stringify(row.data))
        .filter((text) => text.includes('[task-experience]'))
    const refs = (text: string) => [...text.matchAll(/\[memory\/(big-\d) v1\]/gu)].map((m) => m[1])
    for (let i = 1; i <= 6; i++) expect((await notes()).join('\n')).toContain(`[memory/big-${i} v1]`)

    // The goal ends: twelve expiry lines do not fit the control budget, so a reset goes out, which
    // voids every earlier note. The six large entries do not all fit one update.
    t.goal.current = { ...activeGoal, phase: 'complete' }
    const before = (await notes()).length
    expect(await t.say('fifth task')).toMatchObject({ reason: 'completed' })
    const sent = (await notes()).slice(before)
    expect(sent[0]).toContain('No task-experience note before this one applies any longer')
    const first = new Set(sent.slice(1).flatMap(refs))
    expect(first.size).toBeGreaterThan(0)
    expect(first.size).toBeLessThan(6)
    expect(sent.join('\n')).not.toContain('task-entry-number')

    // The rest are still pending: the next request gives them, and nothing is sent twice.
    const mid = (await notes()).length
    expect(await t.say('sixth task')).toMatchObject({ reason: 'completed' })
    const second = new Set((await notes()).slice(mid).flatMap(refs))
    expect([...first, ...second].sort()).toEqual(['big-1', 'big-2', 'big-3', 'big-4', 'big-5', 'big-6'])
    expect([...second].filter((id) => first.has(id))).toEqual([])
    await t.session.close()
  })
})
