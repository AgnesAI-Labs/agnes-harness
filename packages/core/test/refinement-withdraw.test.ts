import type { Event } from '@agnes/core-common/types'
import { describe, expect, it, vi } from 'vitest'
import { applyRefine, entryKey } from '../src/refine/apply.js'
import { metaRow } from '../src/refinement/confirmations.js'
import { refinementFacade } from '../src/refinement/facade.js'
import { applyProposed, tryApply } from '../src/refinement/scheduler.js'
import { contentHash } from '../src/refinement/validity.js'
import { CONTROL_FORMAT_LINE, EXPERIENCE_PREFIX } from '../src/request/experience.js'
import { actor } from './helpers/open-session.js'
import { activeGoal, open, output, REQUEST, upsert } from './helpers/refinement-session.js'
import { ofType } from './helpers/side-call-session.js'

type Opened = Awaited<ReturnType<typeof open>>

/** Every task-experience note committed so far, oldest first, as its row's JSON. */
const notes = async (t: Opened) =>
  ofType(await t.rows(), 'user/message')
    .map((row) => JSON.stringify(row.data))
    .filter((text) => text.includes('[task-experience]'))
const pause = (t: Opened, paused: boolean) =>
  t.session.append([
    t.session.ev('x/core/pause-state', { paused }, { actor, origin: 'principal', ignorable: true }),
  ])
const lastRequestSeq = async (t: Opened) => (ofType(await t.rows(), 'user/message').at(-1) as Event).seq
const direct = (t: Opened, seq: number, id: string, content: string) =>
  refinementFacade(t.session).propose({
    rationale: 'The suite moved.',
    evidenceSeqs: [seq],
    edits: [{ op: 'upsert', kind: 'memory', id, title: id, content }],
  })
const runId = (outcome: unknown) => (outcome as { runId: string }).runId

describe('deleting entries', () => {
  it('a planned delete of an entry the model was given is withdrawn in the very next request', async () => {
    const t = await open({
      answers: [
        () => output({ edits: [upsert('read-b', { applicability: 'task' })], evidenceIds: ['e1'] }),
        () =>
          output({
            edits: [{ op: 'delete', kind: 'memory', id: 'read-b', evidenceIds: ['e1'] }],
            evidenceIds: ['e1'],
          }),
      ],
    })
    t.goal.current = activeGoal
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    expect(await t.say('second task')).toMatchObject({ reason: 'completed' })
    expect((await notes(t)).join('\n')).toContain('[memory/read-b v1]')
    // The plan deletes the entry it was shown in full: applied atomically, with what it leaves behind.
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    expect(t.entries()).toEqual([])
    expect(
      t.session.state.refinementTombstones.get(entryKey({ kind: 'memory', id: 'read-b' })),
    ).toMatchObject({
      version: 1,
    })
    const before = (await notes(t)).length
    expect(await t.say('third task')).toMatchObject({ reason: 'completed' })
    const sent = (await notes(t)).slice(before)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain(
      JSON.stringify(`${EXPERIENCE_PREFIX}${CONTROL_FORMAT_LINE}\n- [memory/read-b v1] withdrawn:`).slice(
        1,
        -1,
      ),
    )
    // Delivered once.
    expect(await t.say('fourth task')).toMatchObject({ reason: 'completed' })
    expect((await notes(t)).length).toBe(before + 1)
    await t.session.close()
  })
})

describe('hardening', () => {
  it('a plan that relied on its target being lapsed is refused once the target is in force again', async () => {
    const task = () =>
      output({
        edits: [upsert('run-tests', { applicability: 'task', content: 'Run the unit tests first.' })],
        evidenceIds: ['e1'],
      })
    const t = await open({ answers: [task] })
    t.goal.current = activeGoal
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    // The goal is replaced: the entry lapses, so a direct proposal may reuse its id unread.
    t.goal.current = { id: 'goal-2', revision: 1, phase: 'active' }
    await pause(t, true)
    const id = runId(await direct(t, await lastRequestSeq(t), 'run-tests', 'Run make test.'))
    expect(t.session.state.refinementRuns.get(id)).toMatchObject({
      state: 'proposed',
      plan: { lapsed: [{ kind: 'memory', id: 'run-tests' }] },
    })
    await pause(t, false)
    // While the task cannot be read, whether the target still lapsed cannot be told: the run waits.
    t.goal.current = 'unreadable'
    expect(await tryApply(t.session, id)).toBe('task-unreadable')
    // The first goal is current again, so the entry is in force again: the plan no longer holds.
    t.goal.current = activeGoal
    expect(await tryApply(t.session, id)).toBe('rejected')
    expect(t.session.state.refinementRuns.get(id)).toMatchObject({
      state: 'rejected',
      reason: 'read-set-changed',
    })
    expect(
      t.session.state.registers.harnessEntries.get(entryKey({ kind: 'memory', id: 'run-tests' }))?.value,
    ).toMatchObject({ version: 1, content: 'Run the unit tests first.' })
    await t.session.close()
  })

  it('a task entry held while its task could not be read is delivered once it can be', async () => {
    const t = await open({
      answers: [
        () => output({ edits: [upsert('held-one', { applicability: 'task' })], evidenceIds: ['e1'] }),
      ],
    })
    t.goal.current = activeGoal
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    // The goal cannot be read: the task entry is held, while another entry goes out in an update
    // written after it.
    t.goal.current = 'unreadable'
    const seq = await lastRequestSeq(t)
    expect(await direct(t, seq, 'other', 'Use the staging database.')).toHaveProperty('runId')
    expect(await t.say('second task')).toMatchObject({ reason: 'completed' })
    const held = (await notes(t)).join('\n')
    expect(held).toContain('[memory/other v1]')
    expect(held).not.toContain('[memory/held-one')
    // The update names what it held back, in its trusted header, so the debt survives a restart.
    expect(held).toContain('Held until their task can be read: memory/held-one')
    // Readable and in force again: given now, not only at the next cold boundary; and only once.
    t.goal.current = activeGoal
    expect(await t.say('third task')).toMatchObject({ reason: 'completed' })
    const after = (await notes(t)).join('\n')
    expect(after).toContain('[memory/held-one v1]')
    const count = (await notes(t)).length
    expect(await t.say('fourth task')).toMatchObject({ reason: 'completed' })
    expect((await notes(t)).length).toBe(count)
    await t.session.close()
  })

  it('a task entry held when the snapshot was built is delivered once its task can be read', async () => {
    const t = await open()
    t.goal.current = activeGoal
    // Written before any request, bound to the goal, as an apply writes it: entry row, then metadata.
    const content = 'Retry the flaky upload once.'
    await t.session.locked(() =>
      applyRefine(
        t.session,
        {
          proposalId: 'seed',
          runId: 'seed',
          trigger: 'manual',
          edits: [
            {
              op: 'upsert',
              entry: {
                kind: 'memory',
                id: 'held-two',
                title: 'Upload',
                content,
                scope: 'local',
                version: 1,
                source: 'test',
              },
            },
          ],
          baseline: [],
          rationale: 'fixture',
          evidenceSeqs: [1],
        },
        { maxEdits: 5, maxChars: 2000, safetyCap: 200 },
        {
          with: () => [
            metaRow(t.session, {
              kind: 'memory',
              id: 'held-two',
              contentHash: contentHash(content),
              applicability: 'task',
              taskScope: { id: activeGoal.id, revision: 1 },
              confirmations: { count: 0, usedEvidence: [] },
            }),
          ],
        },
      ),
    )
    // The first snapshot is built while the goal cannot be read: the entry is held out of it.
    t.goal.current = 'unreadable'
    expect(await t.say('first task')).toMatchObject({ reason: 'completed' })
    expect((await notes(t)).join('\n')).not.toContain('[memory/held-two')
    t.goal.current = activeGoal
    expect(await t.say('second task')).toMatchObject({ reason: 'completed' })
    expect((await notes(t)).join('\n')).toContain('[memory/held-two v1]')
    const count = (await notes(t)).length
    expect(await t.say('third task')).toMatchObject({ reason: 'completed' })
    expect((await notes(t)).length).toBe(count)
    await t.session.close()
  })

  it('applying proposed runs goes past one that waits for its task to be readable', async () => {
    const task = () =>
      output({
        edits: [upsert('run-tests', { applicability: 'task', content: 'Run the unit tests first.' })],
        evidenceIds: ['e1'],
      })
    const t = await open({ answers: [task] })
    t.goal.current = activeGoal
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    // The goal is replaced: the entry lapses. Two proposals wait behind a pause: one reuses the
    // lapsed id, the other adds an entry of its own.
    t.goal.current = { id: 'goal-2', revision: 1, phase: 'active' }
    await pause(t, true)
    const seq = await lastRequestSeq(t)
    const reuse = runId(await direct(t, seq, 'run-tests', 'Run make test.'))
    const fresh = runId(await direct(t, seq, 'staging', 'Use the staging database.'))
    await pause(t, false)
    t.goal.current = 'unreadable'
    await applyProposed(t.session)
    // The older run waits for its task to be readable; the newer one does not depend on it.
    expect(t.session.state.refinementRuns.get(reuse)?.state).toBe('proposed')
    expect(t.session.state.refinementRuns.get(fresh)?.state).toBe('applied')
    t.goal.current = { id: 'goal-2', revision: 1, phase: 'active' }
    await applyProposed(t.session)
    expect(t.session.state.refinementRuns.get(reuse)?.state).toBe('applied')
    await t.session.close()
  })
})

describe('entries a snapshot leaves out on purpose', () => {
  it('task-level entries past the top three or over the budget are not pushed by the next request', async () => {
    const t = await open()
    t.goal.current = activeGoal
    const skill = (i: number) => ({
      kind: 'skill' as const,
      id: `s${i}`,
      content: `Skill ${i}: deploy the service step ${i}.`,
    })
    const big = { kind: 'memory' as const, id: 'big', content: `${'cache facts '.repeat(800)}end` }
    const seeds = [...[1, 2, 3, 4, 5].map(skill), big]
    await t.session.locked(() =>
      applyRefine(
        t.session,
        {
          proposalId: 'seed',
          runId: 'seed',
          trigger: 'manual',
          edits: seeds.map(({ kind, id, content }) => ({
            op: 'upsert' as const,
            entry: { kind, id, title: id, content, scope: 'local' as const, version: 1, source: 'test' },
          })),
          baseline: [],
          rationale: 'fixture',
          evidenceSeqs: [1],
        },
        { maxEdits: 50, maxChars: 20_000, safetyCap: 200 },
        {
          with: () =>
            seeds.map(({ kind, id, content }) =>
              metaRow(t.session, {
                kind,
                id,
                contentHash: contentHash(content),
                applicability: 'task',
                taskScope: { id: activeGoal.id, revision: 1 },
                confirmations: { count: 0, usedEvidence: [] },
              }),
            ),
        },
      ),
    )
    expect(await t.say('first task')).toMatchObject({ reason: 'completed' })
    const first = await notes(t)
    expect(first).toHaveLength(1)
    expect(first[0]).toContain('2 more skill entries are saved')
    expect(first[0]).toContain('1 entry was left out to fit the context budget')
    // Nothing changed on the ledger: the next request adds no note, and the counts stay true.
    expect(await t.say('second task')).toMatchObject({ reason: 'completed' })
    expect(await notes(t)).toEqual(first)
    await t.session.close()
  })
})

describe('a plan that both writes and deletes', () => {
  it('applies in one transaction, or not at all when a deleted entry moved', async () => {
    const task = { applicability: 'task' }
    const t = await open({
      answers: [
        () => output({ edits: [upsert('read-a', task), upsert('keep-b', task)], evidenceIds: ['e1'] }),
        () =>
          output({
            edits: [
              upsert('fresh', task),
              { op: 'delete', kind: 'memory', id: 'read-a', evidenceIds: ['e1'] },
            ],
            evidenceIds: ['e1'],
          }),
      ],
    })
    t.goal.current = activeGoal
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    const run = await t.refine()
    expect(run).toMatchObject({ state: 'applied' })
    const all = await t.rows()
    const control = all.findLast((row) => row.type === 'harness/refine') as Event
    // One transaction: the control row, the upsert, the tombstone and the removal it leaves, the run's
    // end, then the metadata of the new entry.
    const tx = all.filter((row) => row.seq >= control.seq && row.seq <= control.seq + 5)
    expect(tx.map((row) => row.type)).toEqual([
      'harness/refine',
      'harness/entry',
      'harness/entry',
      'x/core/refinement-entry-meta',
      'x/core/refinement-run',
      'x/core/refinement-entry-meta',
    ])
    expect(tx[1]?.data).toMatchObject({ id: 'fresh', version: 1 })
    expect(tx[2]?.data).toMatchObject({ id: 'read-a', tombstone: true })
    expect(tx[3]?.data).toMatchObject({ id: 'read-a', removed: true, entryVersion: 1 })
    const fresh = t.session.state.registers.harnessEntries.get(entryKey({ kind: 'memory', id: 'fresh' }))
    expect(t.meta('fresh')).toMatchObject({ applicability: 'task', entrySeq: fresh?.seq })
    expect(t.session.state.refinementTombstones.get(entryKey({ kind: 'memory', id: 'read-a' }))?.seq).toBe(
      tx[3]?.seq,
    )

    // A direct proposal writing one entry and deleting another, held behind a pause while the entry
    // it deletes is rewritten: rejected whole, nothing of it written.
    const seq = await lastRequestSeq(t)
    await refinementFacade(t.session).inspect({ op: 'get', id: 'memory/keep-b' })
    await pause(t, true)
    const mixed = runId(
      await refinementFacade(t.session).propose({
        rationale: 'Replace keep-b with fresh-2.',
        evidenceSeqs: [seq],
        edits: [
          {
            op: 'upsert',
            kind: 'memory',
            id: 'fresh-2',
            title: 'fresh-2',
            content: 'Use the staging database.',
          },
          { op: 'delete', kind: 'memory', id: 'keep-b' },
        ],
      }),
    )
    expect(t.session.state.refinementRuns.get(mixed)?.state).toBe('proposed')
    const keep = entryKey({ kind: 'memory', id: 'keep-b' })
    await t.session.locked(() =>
      applyRefine(
        t.session,
        {
          proposalId: 'later',
          runId: 'later',
          trigger: 'manual',
          edits: [
            {
              op: 'upsert',
              entry: {
                kind: 'memory',
                id: 'keep-b',
                title: 'k',
                content: 'changed',
                scope: 'local',
                version: 1,
                source: 'test',
              },
            },
          ],
          baseline: [{ key: keep, version: 1 }],
          rationale: 'later change',
          evidenceSeqs: [1],
        },
        { maxEdits: 5, maxChars: 2000, safetyCap: 200 },
      ),
    )
    const before = (await t.rows()).filter((row) => row.type === 'harness/entry').length
    await pause(t, false)
    expect(await tryApply(t.session, mixed)).toBe('rejected')
    expect(t.session.state.refinementRuns.get(mixed)).toMatchObject({
      state: 'rejected',
      detail: 'rejected:conflict',
    })
    expect((await t.rows()).filter((row) => row.type === 'harness/entry').length).toBe(before)
    expect(t.entries()).not.toContain('fresh-2')
    expect(t.session.state.registers.harnessEntries.get(keep)?.value).toMatchObject({ content: 'changed' })
    await t.session.close()
  })
})

describe('the held line', () => {
  it('names at most 32 entries, counts the rest, and every held entry is still delivered', async () => {
    const t = await open()
    t.goal.current = activeGoal
    const ids = Array.from({ length: 40 }, (_, i) => `t-${String(i).padStart(2, '0')}`)
    await t.session.locked(() =>
      applyRefine(
        t.session,
        {
          proposalId: 'seed',
          runId: 'seed',
          trigger: 'manual',
          edits: ids.map((id) => ({
            op: 'upsert' as const,
            entry: {
              kind: 'memory' as const,
              id,
              title: id,
              content: `Fact ${id}.`,
              scope: 'local' as const,
              version: 1,
              source: 'test',
            },
          })),
          baseline: [],
          rationale: 'fixture',
          evidenceSeqs: [1],
        },
        { maxEdits: 50, maxChars: 2000, safetyCap: 200 },
        {
          with: () =>
            ids.map((id) =>
              metaRow(t.session, {
                kind: 'memory',
                id,
                contentHash: contentHash(`Fact ${id}.`),
                applicability: 'task',
                taskScope: { id: activeGoal.id, revision: 1 },
                confirmations: { count: 0, usedEvidence: [] },
              }),
            ),
        },
      ),
    )
    t.goal.current = 'unreadable'
    expect(await t.say('first task')).toMatchObject({ reason: 'completed' })
    const [snapshot] = await notes(t)
    const line = (JSON.parse(snapshot as string).content[0].text as string)
      .split('\n')
      .find((l) => l.startsWith('Held until their task can be read:')) as string
    expect(line).toBe(
      `Held until their task can be read: ${ids
        .slice(0, 32)
        .map((id) => `memory/${id}`)
        .join(', ')} and 8 more`,
    )
    t.goal.current = activeGoal
    expect(await t.say('second task')).toMatchObject({ reason: 'completed' })
    const all = (await notes(t)).join('\n')
    for (const id of ids) expect(all).toContain(`[memory/${id} v1]`)
    const count = (await notes(t)).length
    expect(await t.say('third task')).toMatchObject({ reason: 'completed' })
    expect((await notes(t)).length).toBe(count)
    await t.session.close()
  })
})
