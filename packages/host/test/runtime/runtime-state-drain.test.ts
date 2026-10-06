import { afterEach, describe, expect, it } from 'vitest'
import { runAcceptsNewWork } from '../../src/runtime/state/control.js'
import {
  actionRecordId,
  providerStateRecordId,
  stableId,
  waitRecordId,
} from '../../src/runtime/state/records.js'
import { cleanup, type Owner, reopened, setup } from './fixtures/state-composite-fixture.js'

afterEach(cleanup)

type Fixture = Awaited<ReturnType<typeof setup>>

const SIGNALS = { anyOf: [{ kind: 'signals', typeIds: ['agh.runtime/action-completed@1'], afterSeq: 0 }] }
const REASON = {
  code: 'cancelled' as const,
  detailCode: 'drain_test',
  message: 'drain for a test',
  retryAdvice: { kind: 'never' as const },
  diagnosticId: 'diagnostic-1',
}

function runId(f: Fixture): string {
  return f.admission.runId
}

function control(
  f: Fixture,
  invocation: string,
  commitId: string,
  command: unknown,
  revision = Number(f.head(`run:${f.admission.runId}`)?.value.revision),
) {
  return f.joint.state.commitControl({ commitId, guard: f.guardFor(invocation, revision), command } as never)
}

const drainRun = (f: Fixture, invocation: string, commitId: string) =>
  control(f, invocation, commitId, {
    kind: 'begin_drain',
    target: { runId: runId(f), actionId: null },
    reason: REASON,
  })

const drainParent = (f: Fixture, invocation: string, commitId: string, actionId = f.parentId) =>
  control(f, invocation, commitId, {
    kind: 'begin_drain',
    target: { runId: runId(f), actionId },
    reason: REASON,
  })

const cancel = (f: Fixture, invocation: string, commitId: string, reason = 'operator') =>
  control(f, invocation, commitId, { kind: 'cancel_run', runId: runId(f), reason, requestedBy: 'operator-1' })

/** A run that has parked on a signal wait, so its wait record is open. Run revision 1 -> 2. */
async function parkedRun(f: Fixture) {
  const parked = await f.joint.state.advanceRun({
    commitId: 'park',
    guard: f.guardFor(await f.prepared(null, 1), 1),
    transition: {
      expectedRevision: 1,
      continuation: f.continuation('park'),
      consumeSignals: [],
      actions: [],
      next: { kind: 'wait', condition: SIGNALS },
    },
  } as never)
  return stableId('wait', parked.commitId)
}

async function startedParent(f: Fixture) {
  await f.start(await f.prepared(f.parentId, 1), f.parentId, 'start-1', 'attempt-1')
}

describe('the run-state gate', () => {
  it('admits the states that take new work and no other', () => {
    for (const state of ['admitted', 'runnable', 'waiting']) expect(runAcceptsNewWork(state)).toBe(true)
    for (const state of ['failing', 'cancelling', 'draining', 'succeeded', 'failed', 'cancelled', 'frozen'])
      expect(runAcceptsNewWork(state)).toBe(false)
  })
})

describe('begin_drain on a run', () => {
  it('closes admission in one commit without moving the run revision, and replays by commit id', async () => {
    const f = await setup()
    const invocation = await f.prepared(null, 1)
    const events = f.events()
    const receipt = await drainRun(f, invocation, 'drain-1')
    expect(f.events()).toBe(events + 1)
    expect(receipt.runRevision).toBe(1)
    expect(f.head(`run:${runId(f)}`)).toMatchObject({
      value: { state: 'draining', waitId: null, revision: 1 },
    })
    const writes = f.writes()
    expect(await drainRun(f, invocation, 'drain-1')).toEqual(receipt)
    expect(f.writes()).toBe(writes)
  })
  it('closes the open wait of a waiting run, and survives a cold reopen with the integrity scan', async () => {
    const f = await setup()
    const waitId = await parkedRun(f)
    expect(f.head(`run:${runId(f)}`)?.value.state).toBe('waiting')
    await drainRun(f, await f.prepared(null, 2), 'drain-1')
    expect(f.head(waitRecordId(waitId))).toMatchObject({ revision: 2, value: { state: 'cancelled' } })
    expect(f.head(`run:${runId(f)}`)?.value).toMatchObject({ state: 'draining', waitId: null })
    const again = await reopened(f)
    expect((again.state as unknown as Owner).requireSession).toBeDefined()
  })
  it('refuses a run that is already draining, a foreign run and a stale revision, and writes nothing', async () => {
    const f = await setup()
    await drainRun(f, await f.prepared(null, 1), 'drain-1')
    const again = await f.prepared(null, 1)
    const writes = f.writes()
    await expect(drainRun(f, again, 'drain-2')).rejects.toMatchObject({
      failure: { detailCode: 'run_state' },
    })
    expect(f.writes()).toBe(writes)
    const g = await setup()
    const open = await g.prepared(null, 1)
    const before = g.writes()
    await expect(
      control(g, open, 'drain-3', {
        kind: 'begin_drain',
        target: { runId: 'another-run', actionId: null },
        reason: REASON,
      }),
    ).rejects.toMatchObject({ failure: { detailCode: 'run_target' } })
    await expect(
      drainRun(g, open, 'drain-4').then(() =>
        control(
          g,
          open,
          'drain-5',
          { kind: 'begin_drain', target: { runId: runId(g), actionId: null }, reason: REASON },
          9,
        ),
      ),
    ).rejects.toMatchObject({
      failure: { detailCode: 'revision' },
    })
    expect(g.head(`run:${runId(g)}`)?.value.state).toBe('draining')
    expect(g.writes()).toBeGreaterThan(before)
  })
})

describe('begin_drain on a closing run', () => {
  it('takes a cancelling run to draining and keeps its cancellation', async () => {
    const f = await setup()
    await cancel(f, await f.prepared(null, 1), 'cancel-1')
    await drainRun(f, await f.prepared(null, 1), 'drain-1')
    expect(f.head(`run:${runId(f)}`)?.value).toMatchObject({
      state: 'draining',
      cancellation: { reason: 'operator' },
    })
  })
  it('takes a failing run to draining and keeps its terminal error', async () => {
    const f = await setup()
    await f.joint.state.advanceRun({
      commitId: 'fail',
      guard: f.guardFor(await f.prepared(null, 1), 1),
      transition: {
        expectedRevision: 1,
        continuation: f.continuation('fail'),
        consumeSignals: [],
        actions: [],
        next: { kind: 'fail', error: { ...REASON, code: 'internal' } },
      },
    } as never)
    await drainRun(f, await f.prepared(null, 2), 'drain-1')
    expect(f.head(`run:${runId(f)}`)?.value).toMatchObject({
      state: 'draining',
      terminal: { outcome: 'failed' },
    })
    await reopened(f)
  })
})

describe('the drain gate on the paths that create work', () => {
  it('refuses new actions from advanceRun and takes back a key that already exists, with no write', async () => {
    const f = await setup()
    await drainRun(f, await f.prepared(null, 1), 'drain-1')
    const invocation = await f.prepared(null, 1)
    const writes = f.writes()
    const request = (actions: unknown[]) =>
      ({
        commitId: 'loop-2',
        guard: f.guardFor(invocation, 1),
        transition: {
          expectedRevision: 1,
          continuation: f.continuation('loop-2'),
          consumeSignals: [],
          actions,
          next: { kind: 'continue' },
        },
      }) as never
    await expect(f.joint.state.advanceRun(request([f.child('new-child')]))).rejects.toMatchObject({
      failure: { detailCode: 'run_state' },
    })
    expect(f.writes()).toBe(writes)
    expect(f.head(actionRecordId(stableId('act', `${runId(f)}\0new-child`)))).toBeUndefined()
    // A transition that creates nothing is not new work.
    const receipt = await f.joint.state.advanceRun(request([f.leafParentIntent]))
    expect(receipt.runRevision).toBe(2)
    expect(f.head(`run:${runId(f)}`)?.value.state).toBe('draining')
  })
  it('refuses new children from advanceProvider and starting a parent, and still lets a parent step without children', async () => {
    const f = await setup()
    await startedParent(f)
    await drainRun(f, await f.prepared(f.parentId, 1), 'drain-1')
    const writes = f.writes()
    await expect(
      f.advance(await f.prepared(f.parentId, 1), 'step-1', { children: [f.child('child-a')] }),
    ).rejects.toMatchObject({ failure: { detailCode: 'run_state' } })
    await expect(
      f.start(await f.prepared(f.leafParentId, 1), f.leafParentId, 'start-2', 'attempt-2'),
    ).rejects.toMatchObject({ failure: { detailCode: 'run_state' } })
    expect(f.head(actionRecordId(stableId('act', `${runId(f)}\0${f.parentId}\0child-a`)))).toBeUndefined()
    expect(f.head(providerStateRecordId(f.leafParentId))).toBeUndefined()
    expect(f.writes()).toBeGreaterThanOrEqual(writes)
    const stepped = await f.advance(await f.prepared(f.parentId, 1), 'step-2', { children: [] })
    expect(stepped.runRevision).toBe(1)
    expect(f.head(providerStateRecordId(f.parentId))?.value.providerRevision).toBe(1)
  })
  it('turns a dispatch in a draining run into a zero-effect cancelled rejection that settles the action', async () => {
    const f = await setup()
    await drainRun(f, await f.prepared(null, 1), 'drain-1')
    const invocation = await f.prepared(null, 1)
    const decided = await f.dispatch(f.leafParentId, f.leafParentIntent, invocation, 'late')
    expect(decided).toMatchObject({ state: 'rejected', reason: 'cancelled' })
    expect(f.head(actionRecordId(f.leafParentId))?.value).toMatchObject({ state: 'settled' })
    expect(f.head('attempt:' + stableId('ctl', 'admit-late'))?.value).toMatchObject({
      kind: 'control',
      number: 0,
      state: 'settled',
    })
    await reopened(f)
  })
  it('refuses a dispatch in a suspended run instead of settling the action', async () => {
    const f = await setup()
    const invocation = await f.prepared(null, 1)
    const row = f.joint.db
      .prepare('SELECT record_revision FROM runtime_record_heads WHERE record_id=?')
      .get(`run:${runId(f)}`)
    const value = { ...f.head(`run:${runId(f)}`)?.value, state: 'frozen' }
    f.joint.db
      .prepare('UPDATE runtime_version_bodies SET value_json=? WHERE record_id=? AND record_revision=?')
      .run(JSON.stringify(value), `run:${runId(f)}`, Number(row?.record_revision))
    const writes = f.writes()
    await expect(f.dispatch(f.leafParentId, f.leafParentIntent, invocation, 'frozen')).rejects.toMatchObject({
      failure: { detailCode: 'run_state' },
    })
    expect(f.writes()).toBe(writes)
    expect(f.head(actionRecordId(f.leafParentId))?.value.state).toBe('prepared')
  })
})

describe('begin_drain on a composite parent', () => {
  it('parks the provider as draining, closes its wait and keeps the run open for other work', async () => {
    const f = await setup()
    await startedParent(f)
    const parked = await f.advance(await f.prepared(f.parentId, 1), 'step-1', {
      children: [f.child('child-a')],
      next: { kind: 'wait', condition: SIGNALS },
    })
    const waitId = stableId('wait', parked.commitId)
    const invocation = await f.prepared(f.parentId, 1)
    const events = f.events()
    const receipt = await drainParent(f, invocation, 'drain-1')
    expect(f.events()).toBe(events + 1)
    expect(receipt.runRevision).toBe(1)
    expect(f.head(providerStateRecordId(f.parentId))?.value).toMatchObject({
      state: 'draining',
      waitId: null,
      providerRevision: 1,
      termination: null,
    })
    expect(f.head(waitRecordId(waitId))?.value.state).toBe('cancelled')
    expect(f.head(`run:${runId(f)}`)?.value.state).not.toBe('draining')
    expect(f.head(actionRecordId(f.parentId))?.value.state).toBe('running')
    const writes = f.writes()
    await expect(f.advance(await f.prepared(f.parentId, 1), 'step-2', { revision: 1 })).rejects.toMatchObject(
      { failure: { detailCode: 'provider_state' } },
    )
    await expect(drainParent(f, await f.prepared(f.parentId, 1), 'drain-2')).rejects.toMatchObject({
      failure: { detailCode: 'provider_state' },
    })
    expect(f.writes()).toBeGreaterThanOrEqual(writes)
    await reopened(f)
  })
  it('drains a runnable parent and refuses an action that is not a running composite parent', async () => {
    const f = await setup()
    await startedParent(f)
    await expect(
      drainParent(f, await f.prepared(f.leafParentId, 1), 'drain-leaf', f.leafParentId),
    ).rejects.toMatchObject({ failure: { detailCode: 'action_state' } })
    await expect(
      drainParent(f, await f.prepared(null, 1), 'drain-none', 'no-such-action'),
    ).rejects.toMatchObject({
      failure: { detailCode: 'action_state' },
    })
    await drainParent(f, await f.prepared(f.parentId, 1), 'drain-1')
    expect(f.head(providerStateRecordId(f.parentId))?.value.state).toBe('draining')
  })
})

describe('cancel_run', () => {
  it('records the cancellation, closes admission and replays by commit id', async () => {
    const f = await setup()
    const invocation = await f.prepared(null, 1)
    const events = f.events()
    const receipt = await cancel(f, invocation, 'cancel-1')
    expect(f.events()).toBe(events + 1)
    expect(receipt.runRevision).toBe(1)
    expect(f.head(`run:${runId(f)}`)?.value).toMatchObject({
      state: 'cancelling',
      revision: 1,
      cancellation: { reason: 'operator', by: 'operator-1' },
    })
    const writes = f.writes()
    expect(await cancel(f, invocation, 'cancel-1')).toEqual(receipt)
    expect(f.writes()).toBe(writes)
    await reopened(f)
  })
  it('keeps the first cancellation when it is asked again, and gives the second ask its own receipt', async () => {
    const f = await setup()
    const first = await cancel(f, await f.prepared(null, 1), 'cancel-1', 'first')
    const before = f.head(`run:${runId(f)}`)?.value
    const second = await cancel(f, await f.prepared(null, 1), 'cancel-2', 'second')
    expect(second.commitId).not.toBe(first.commitId)
    expect(f.head(`run:${runId(f)}`)?.value).toEqual(before)
    await reopened(f)
  })
  it('closes the open wait of a waiting run', async () => {
    const f = await setup()
    const waitId = await parkedRun(f)
    await cancel(f, await f.prepared(null, 2), 'cancel-1')
    expect(f.head(waitRecordId(waitId))?.value.state).toBe('cancelled')
    expect(f.head(`run:${runId(f)}`)?.value).toMatchObject({ state: 'cancelling', waitId: null })
  })
  it('refuses new work afterwards and turns a dispatch into a cancelled rejection', async () => {
    const f = await setup()
    await cancel(f, await f.prepared(null, 1), 'cancel-1')
    const decided = await f.dispatch(f.leafParentId, f.leafParentIntent, await f.prepared(null, 1), 'late')
    expect(decided).toMatchObject({ state: 'rejected', reason: 'cancelled' })
    await expect(
      f.advance(await f.prepared(f.parentId, 1), 'step-1', { children: [f.child('child-a')] }),
    ).rejects.toMatchObject({ failure: { detailCode: 'run_cancelled' } })
  })
  it('refuses a draining run and a failing run, and writes nothing', async () => {
    const f = await setup()
    await drainRun(f, await f.prepared(null, 1), 'drain-1')
    await expect(cancel(f, await f.prepared(null, 1), 'cancel-1')).rejects.toMatchObject({
      failure: { detailCode: 'run_state' },
    })
    const g = await setup()
    await g.joint.state.advanceRun({
      commitId: 'fail',
      guard: g.guardFor(await g.prepared(null, 1), 1),
      transition: {
        expectedRevision: 1,
        continuation: g.continuation('fail'),
        consumeSignals: [],
        actions: [],
        next: { kind: 'fail', error: { ...REASON, code: 'internal' } },
      },
    } as never)
    expect(g.head(`run:${runId(g)}`)?.value.state).toBe('failing')
    await expect(cancel(g, await g.prepared(null, 2), 'cancel-2')).rejects.toMatchObject({
      failure: { detailCode: 'run_state' },
    })
    await expect(
      control(
        g,
        await g.prepared(null, 2),
        'cancel-3',
        { kind: 'cancel_run', runId: 'other', reason: 'x', requestedBy: 'y' },
        2,
      ),
    ).rejects.toMatchObject({
      failure: { detailCode: 'run_target' },
    })
  })
})
