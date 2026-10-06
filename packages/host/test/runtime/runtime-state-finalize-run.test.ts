import type { PreparedAction } from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { actionRecordId, providerStateRecordId, stableId } from '../../src/runtime/state/records.js'
import { fixtureRef } from './fixtures/assembly-maintenance-wire.js'
import { cleanup, reopened, setup } from './fixtures/state-composite-fixture.js'

afterEach(cleanup)

type Fixture = Awaited<ReturnType<typeof setup>>

const ERROR = {
  code: 'internal' as const,
  detailCode: 'loop_failed',
  message: 'the loop failed',
  retryAdvice: { kind: 'never' as const },
  diagnosticId: 'diagnostic-1',
}
const OWNER = { kind: 'reconciliation' as const, id: 'reconciliation-1' }
const JOB = { kind: 'job' as const, id: 'job-1' }

const runId = (f: Fixture) => f.admission.runId
const runHead = (f: Fixture) => f.head(`run:${runId(f)}`)
const runRevision = (f: Fixture) => Number(runHead(f)?.value.revision)

function control(f: Fixture, invocation: string, commitId: string, command: unknown) {
  return f.joint.state.commitControl({
    commitId,
    guard: f.guardFor(invocation, runRevision(f)),
    command,
  } as never)
}

const finalize = (f: Fixture, invocation: string, commitId: string, patch: Record<string, unknown> = {}) =>
  control(f, invocation, commitId, {
    kind: 'finalize_run',
    runId: runId(f),
    expectedRunRevision: runRevision(f),
    outcome: 'failed',
    unknownActionIds: [],
    ownerRefs: [],
    ...patch,
  })

const drain = (f: Fixture, invocation: string, commitId: string) =>
  control(f, invocation, commitId, {
    kind: 'begin_drain',
    target: { runId: runId(f), actionId: null },
    reason: ERROR,
  })

const cancel = (f: Fixture, invocation: string, commitId: string) =>
  control(f, invocation, commitId, {
    kind: 'cancel_run',
    runId: runId(f),
    reason: 'operator',
    requestedBy: 'operator-1',
  })

/** The Loop gives up: the run moves to failing and records the failure it chose. */
async function failRun(f: Fixture, commitId = 'fail-run') {
  await f.joint.state.advanceRun({
    commitId,
    guard: f.guardFor(await f.prepared(null, runRevision(f)), runRevision(f)),
    transition: {
      expectedRevision: runRevision(f),
      continuation: f.continuation(commitId),
      consumeSignals: [],
      actions: [],
      next: { kind: 'fail', error: ERROR },
    },
  })
}

/** Settles the four prepared actions the fixture's Loop step created, except the ones kept open. */
async function settleRunActions(f: Fixture, keep: string[] = []) {
  const invocation = await f.prepared(null, runRevision(f))
  for (const actionId of [f.parentId, f.leafParentId, f.queryParentId, f.duplicateParentId]) {
    if (keep.includes(actionId)) continue
    await control(f, invocation, `settle-${actionId}`, {
      kind: 'settle_undispatched',
      actionId,
      expectedActionRevision: Number(f.head(actionRecordId(actionId))?.revision),
      outcome: 'failed',
      error: ERROR,
    })
  }
}

/** Dispatches the run-level tool action and marks its attempt unknown with a real command. */
async function unknownLeaf(f: Fixture) {
  const invocation = await f.prepared(null, runRevision(f))
  const admitted = await f.dispatch(f.leafParentId, f.leafParentIntent, invocation, 'leaf')
  if (admitted.state !== 'admitted') throw Error('leaf dispatch was refused')
  await control(f, invocation, 'unknown-leaf', {
    kind: 'mark_unknown',
    attemptId: 'attempt-leaf',
    expectedAttemptRevision: 1,
    evidence: [fixtureRef({ lookup: 'first' })],
    reconciliationOwnerRef: OWNER,
    reason: 'the answer was lost',
  })
}

/** Rewrites the stored body of the current version. Used only to reach states no command produces. */
function forge(f: Fixture, recordId: string, patch: Record<string, unknown>) {
  const head = f.head(recordId)
  if (!head) throw Error(`no record ${recordId}`)
  f.joint.db
    .prepare('UPDATE runtime_version_bodies SET value_json=? WHERE record_id=? AND record_revision=?')
    .run(JSON.stringify({ ...head.value, ...patch }), recordId, head.revision)
}

describe('finalize_run', () => {
  it('ends a failed run whose work all settled, keeps the failure it chose and survives a cold reopen', async () => {
    const f = await setup()
    await failRun(f)
    await drain(f, await f.prepared(null, runRevision(f)), 'drain-1')
    await settleRunActions(f)
    const invocation = await f.prepared(null, runRevision(f))
    const events = f.events()
    const revision = runRevision(f)
    const receipt = await finalize(f, invocation, 'finalize-1')
    expect(f.events()).toBe(events + 1)
    expect(receipt.runRevision).toBe(revision)
    expect(runHead(f)?.value).toMatchObject({
      state: 'failed',
      waitId: null,
      revision,
      terminal: {
        outcome: 'failed',
        output: null,
        references: [],
        error: { detailCode: 'loop_failed' },
        unknownActionIds: [],
        detachedOwnerRefs: [],
      },
    })
    const writes = f.writes()
    expect(await finalize(f, invocation, 'finalize-1', { expectedRunRevision: revision })).toEqual(receipt)
    expect(f.writes()).toBe(writes)
    await reopened(f)
  })
  it('ends a cancelled run, and a second finish of the same run is refused', async () => {
    const f = await setup()
    await cancel(f, await f.prepared(null, 1), 'cancel-1')
    await drain(f, await f.prepared(null, runRevision(f)), 'drain-1')
    await settleRunActions(f)
    const invocation = await f.prepared(null, runRevision(f))
    await finalize(f, invocation, 'finalize-1', { outcome: 'cancelled' })
    expect(runHead(f)?.value).toMatchObject({
      state: 'cancelled',
      cancellation: { reason: 'operator' },
      terminal: { outcome: 'cancelled', error: null },
    })
    const writes = f.writes()
    await expect(finalize(f, invocation, 'finalize-2', { outcome: 'cancelled' })).rejects.toMatchObject({
      failure: { detailCode: 'run_state' },
    })
    expect(f.writes()).toBe(writes)
    await reopened(f)
  })
  it('hands a real unknown effect over with its owner, never settles it, and still takes late resolution', async () => {
    const f = await setup()
    await unknownLeaf(f)
    await failRun(f)
    await drain(f, await f.prepared(null, runRevision(f)), 'drain-1')
    await settleRunActions(f, [f.leafParentId])
    const invocation = await f.prepared(null, runRevision(f))
    const open = { unknownActionIds: [f.leafParentId], ownerRefs: [OWNER] }
    await finalize(f, invocation, 'finalize-1', open)
    expect(runHead(f)?.value).toMatchObject({
      state: 'failed',
      terminal: { outcome: 'failed', unknownActionIds: open.unknownActionIds, detachedOwnerRefs: [] },
    })
    expect(f.head(actionRecordId(f.leafParentId))?.value).toMatchObject({ state: 'unknown', ownerRef: OWNER })
    expect(f.head('attempt:attempt-leaf')?.value.state).toBe('unknown')
    await control(f, invocation, 'resolve-late', {
      kind: 'resolve_action',
      actionId: f.leafParentId,
      expectedActionRevision: Number(f.head(actionRecordId(f.leafParentId))?.revision),
      selectedReceiptId: null,
      evidence: [fixtureRef({ lookup: 'late' })],
      state: 'conflicting',
      ownerRef: OWNER,
      nextCheckAt: null,
    })
    expect(f.head(`resolution:${stableId('res', f.leafParentId)}`)?.value.state).toBe('conflicting')
    expect(runHead(f)?.value.state).toBe('failed')
    await reopened(f)
  })
  it('lists a detached action with its owning job and refuses one that has none', async () => {
    const f = await setup()
    await failRun(f)
    await drain(f, await f.prepared(null, runRevision(f)), 'drain-1')
    await settleRunActions(f, [f.queryParentId])
    const detached = (ownerRef: unknown) => {
      const head = f.head(actionRecordId(f.queryParentId))
      forge(f, actionRecordId(f.queryParentId), {
        ownerRef,
        intent: { ...head?.value.intent, obligation: 'detached' },
      })
    }
    const invocation = await f.prepared(null, runRevision(f))
    detached({ kind: 'run', id: runId(f) })
    const writes = f.writes()
    await expect(finalize(f, invocation, 'finalize-1')).rejects.toMatchObject({
      failure: { detailCode: 'detached_owner_missing' },
    })
    expect(f.writes()).toBe(writes)
    detached(JOB)
    await finalize(f, invocation, 'finalize-2')
    expect(runHead(f)?.value.terminal).toMatchObject({ detachedOwnerRefs: [JOB], unknownActionIds: [] })
  })
  it('refuses a run that did not drain, another run, a stale revision and a termination it did not choose', async () => {
    const f = await setup()
    await settleRunActions(f)
    const invocation = await f.prepared(null, 1)
    const writes = f.writes()
    const refused = (commitId: string, patch: Record<string, unknown>, detail: string) =>
      expect(finalize(f, invocation, commitId, patch)).rejects.toMatchObject({
        failure: { detailCode: detail },
      })
    await refused('f-1', {}, 'run_state')
    await refused('f-2', { runId: 'another-run' }, 'run_target')
    await refused('f-3', { expectedRunRevision: 9 }, 'revision')
    expect(f.writes()).toBe(writes)
    await failRun(f)
    await refused('f-4', {}, 'run_state')
    await drain(f, await f.prepared(null, runRevision(f)), 'drain-1')
    const afterDrain = f.writes()
    await refused('f-5', { outcome: 'cancelled' }, 'termination')
    expect(f.writes()).toBe(afterDrain)
    const g = await setup()
    await settleRunActions(g)
    await drain(g, await g.prepared(null, 1), 'drain-1')
    await expect(
      finalize(g, await g.prepared(null, 1), 'f-6', { outcome: 'cancelled' }),
    ).rejects.toMatchObject({
      failure: { detailCode: 'termination' },
    })
  })
  it('refuses while work is open or an unresolved action is not listed with its owner, writing nothing', async () => {
    const f = await setup()
    await unknownLeaf(f)
    await failRun(f)
    await drain(f, await f.prepared(null, runRevision(f)), 'drain-1')
    const invocation = await f.prepared(null, runRevision(f))
    const snapshot = () => [
      runHead(f),
      f.head(actionRecordId(f.leafParentId)),
      f.head('attempt:attempt-leaf'),
    ]
    const before = snapshot()
    const writes = f.writes()
    const refused = (commitId: string, patch: Record<string, unknown>, detail: string) =>
      expect(finalize(f, invocation, commitId, patch)).rejects.toMatchObject({
        failure: { detailCode: detail },
      })
    await refused('f-1', {}, 'finalize_open')
    await settleRunActions(f, [f.leafParentId])
    const settled = f.writes()
    await refused('f-2', {}, 'unknown_actions')
    await refused('f-3', { unknownActionIds: [f.leafParentId] }, 'owner_ref')
    await refused(
      'f-4',
      { unknownActionIds: [f.leafParentId], ownerRefs: [{ ...OWNER, id: 'other' }] },
      'owner_ref',
    )
    await refused(
      'f-5',
      { unknownActionIds: ['other', f.leafParentId], ownerRefs: [OWNER] },
      'unknown_actions',
    )
    await refused('f-6', { unknownActionIds: [f.parentId], ownerRefs: [OWNER] }, 'unknown_actions')
    expect(f.writes()).toBe(settled)
    expect(writes).toBeLessThan(settled)
    expect(snapshot()).toEqual(before)
    forge(f, actionRecordId(f.leafParentId), { ownerRef: { kind: 'run', id: runId(f) } })
    await refused(
      'f-7',
      { unknownActionIds: [f.leafParentId], ownerRefs: [{ kind: 'run', id: runId(f) }] },
      'finalize_open',
    )
    forge(f, actionRecordId(f.leafParentId), { ownerRef: OWNER, state: 'running' })
    await refused('f-8', { unknownActionIds: [f.leafParentId], ownerRefs: [OWNER] }, 'finalize_open')
  })
  it('waits for a composite parent to be finished first, then accepts its unknown child', async () => {
    const f = await setup()
    await f.start(await f.prepared(f.parentId, 1), f.parentId, 'start-1', 'attempt-1')
    const child = f.child('child-a')
    const childId = stableId('act', `${runId(f)}\0${f.parentId}\0child-a`)
    const stepping = await f.prepared(f.parentId, 1)
    await f.advance(stepping, 'step-1', { children: [child] })
    const admitted = await f.dispatch(childId, child as PreparedAction, stepping, 'child-a')
    if (admitted.state !== 'admitted') throw Error('child dispatch was refused')
    await control(f, await f.prepared(null, 1), 'unknown-child', {
      kind: 'mark_unknown',
      attemptId: 'attempt-child-a',
      expectedAttemptRevision: 1,
      evidence: [],
      reconciliationOwnerRef: OWNER,
      reason: 'the answer was lost',
    })
    await f.advance(await f.prepared(f.parentId, 1), 'fail-parent', {
      revision: Number(f.head(providerStateRecordId(f.parentId))?.value.providerRevision),
      next: { kind: 'fail', error: ERROR },
    })
    await failRun(f)
    await drain(f, await f.prepared(null, runRevision(f)), 'drain-1')
    await settleRunActions(f, [f.parentId])
    const open = { unknownActionIds: [childId], ownerRefs: [OWNER] }
    const invocation = await f.prepared(null, runRevision(f))
    await expect(finalize(f, invocation, 'finalize-1', open)).rejects.toMatchObject({
      failure: { detailCode: 'finalize_open' },
    })
    await control(f, await f.prepared(f.parentId, runRevision(f)), 'finalize-parent', {
      kind: 'finalize_composite',
      actionId: f.parentId,
      expectedProviderRevision: Number(f.head(providerStateRecordId(f.parentId))?.value.providerRevision),
      outcome: 'failed',
      error: ERROR,
      ownerRefs: [OWNER],
    })
    await finalize(f, await f.prepared(null, runRevision(f)), 'finalize-2', open)
    expect(runHead(f)?.value).toMatchObject({ state: 'failed', terminal: { unknownActionIds: [childId] } })
    await reopened(f)
  })
})
