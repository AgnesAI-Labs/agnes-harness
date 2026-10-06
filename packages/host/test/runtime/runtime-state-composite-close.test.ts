import type { PreparedAction } from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import {
  actionRecordId,
  providerStateRecordId,
  stableId,
  waitRecordId,
} from '../../src/runtime/state/records.js'
import { fixtureRef } from './fixtures/assembly-maintenance-wire.js'
import { cleanup, reopened, setup } from './fixtures/state-composite-fixture.js'

afterEach(cleanup)

type Fixture = Awaited<ReturnType<typeof setup>>

const SIGNALS = { anyOf: [{ kind: 'signals', typeIds: ['agh.runtime/action-completed@1'], afterSeq: 0 }] }
const ERROR = {
  code: 'internal' as const,
  detailCode: 'composite_failed',
  message: 'the composite failed',
  retryAdvice: { kind: 'never' as const },
  diagnosticId: 'diagnostic-1',
}
const OWNER = { kind: 'reconciliation' as const, id: 'reconciliation-1' }

const runId = (f: Fixture) => f.admission.runId
const childId = (f: Fixture, key: string) => stableId('act', `${runId(f)}\0${f.parentId}\0${key}`)
const closeReceiptId = (actionId: string) => stableId('rcpt', `${actionId}\0close`)

function control(f: Fixture, invocation: string, commitId: string, command: unknown) {
  const revision = Number(f.head(`run:${runId(f)}`)?.value.revision)
  return f.joint.state.commitControl({ commitId, guard: f.guardFor(invocation, revision), command } as never)
}

const complete = (
  f: Fixture,
  invocation: string,
  commitId: string,
  transition: Record<string, unknown> = {},
) =>
  f.advance(invocation, commitId, {
    revision: Number(f.head(providerStateRecordId(f.parentId))?.value.providerRevision),
    next: { kind: 'complete', output: fixtureRef({ done: commitId }), references: [] },
    ...transition,
  })

const fail = (f: Fixture, invocation: string, commitId: string, transition: Record<string, unknown> = {}) =>
  f.advance(invocation, commitId, {
    revision: Number(f.head(providerStateRecordId(f.parentId))?.value.providerRevision),
    next: { kind: 'fail', error: ERROR },
    ...transition,
  })

const finalize = (f: Fixture, invocation: string, commitId: string, patch: Record<string, unknown> = {}) =>
  control(f, invocation, commitId, {
    kind: 'finalize_composite',
    actionId: f.parentId,
    expectedProviderRevision: Number(f.head(providerStateRecordId(f.parentId))?.value.providerRevision),
    outcome: 'failed',
    error: ERROR,
    ownerRefs: [],
    ...patch,
  })

const settleUndispatched = (f: Fixture, invocation: string, commitId: string, actionId: string, patch = {}) =>
  control(f, invocation, commitId, {
    kind: 'settle_undispatched',
    actionId,
    expectedActionRevision: Number(f.head(actionRecordId(actionId))?.revision),
    outcome: 'failed',
    error: ERROR,
    ...patch,
  })

/** Rewrites the stored body of the current version. Used only to reach states no command produces yet. */
function forge(f: Fixture, recordId: string, patch: Record<string, unknown>) {
  const head = f.head(recordId)
  if (!head) throw Error(`no record ${recordId}`)
  f.joint.db
    .prepare('UPDATE runtime_version_bodies SET value_json=? WHERE record_id=? AND record_revision=?')
    .run(JSON.stringify({ ...head.value, ...patch }), recordId, head.revision)
}

/** A started parent with the given children, every child dispatched and settled. */
async function settledParent(f: Fixture, keys: string[]) {
  await f.start(await f.prepared(f.parentId, 1), f.parentId, 'start-1', 'attempt-1')
  const children = keys.map((key) => f.child(key))
  const invocation = await f.prepared(f.parentId, 1)
  await f.advance(invocation, 'step-1', { children })
  for (const [index, key] of keys.entries())
    await f.complete(childId(f, key), children[index] as PreparedAction, invocation, key)
  return { children, invocation }
}

async function startedParent(f: Fixture, keys: string[]) {
  await f.start(await f.prepared(f.parentId, 1), f.parentId, 'start-1', 'attempt-1')
  const children = keys.map((key) => f.child(key))
  if (keys.length > 0) await f.advance(await f.prepared(f.parentId, 1), 'step-1', { children })
  return children
}

describe('advanceProvider complete', () => {
  it('settles the parent, its composite attempt and its result in one commit, without moving the run', async () => {
    const f = await setup()
    await settledParent(f, ['child-a'])
    const invocation = await f.prepared(f.parentId, 1)
    const events = f.events()
    const receipt = await complete(f, invocation, 'complete-1')
    expect(f.events()).toBe(events + 1)
    expect(receipt.runRevision).toBe(1)
    const receiptId = closeReceiptId(f.parentId)
    expect(f.head(`receipt:${receiptId}`)?.value.receipt).toMatchObject({
      actionId: f.parentId,
      attemptId: 'attempt-1',
      outcome: 'succeeded',
      externalRequests: [],
      usageRefs: [],
      references: [],
    })
    expect(f.head(`receipt:${receiptId}`)?.value.receipt.result.value).toEqual({ done: 'complete-1' })
    expect(f.head(actionRecordId(f.parentId))?.value).toMatchObject({
      state: 'settled',
      firstReceiptId: receiptId,
      resolvedReceiptId: receiptId,
    })
    expect(f.head('attempt:attempt-1')?.value).toMatchObject({ state: 'settled', receiptIds: [receiptId] })
    expect(f.head(providerStateRecordId(f.parentId))?.value).toMatchObject({
      state: 'completed',
      providerRevision: 2,
      waitId: null,
      termination: null,
    })
    expect(f.head(`visibility:${receiptId}`)?.value).toMatchObject({ state: 'ready', actionId: f.parentId })
    expect(f.signalsFor(null)).toHaveLength(1)
    expect(f.head(`run:${runId(f)}`)?.value.revision).toBe(1)
    expect(f.head(`invocation:${invocation}`)?.value.state).toBe('committed')
    const writes = f.writes()
    expect(await complete(f, invocation, 'complete-1', { revision: 1 })).toEqual(receipt)
    expect(f.writes()).toBe(writes)
    await reopened(f)
  })
  it('completes a parent that has no children, and resumes a waiting parent on its signal first', async () => {
    const f = await setup()
    await f.start(await f.prepared(f.parentId, 1), f.parentId, 'start-1', 'attempt-1')
    const child = f.child('child-a')
    const parked = await f.advance(await f.prepared(f.parentId, 1), 'step-1', {
      children: [child],
      next: { kind: 'wait', condition: SIGNALS },
    })
    const waitId = stableId('wait', parked.commitId)
    const invocation = await f.prepared(f.parentId, 1)
    await f.complete(childId(f, 'child-a'), child, invocation, 'child')
    await expect(complete(f, await f.prepared(f.parentId, 1), 'complete-none')).rejects.toMatchObject({
      failure: { detailCode: 'wait_not_satisfied' },
    })
    const [signal] = f.signalsFor(f.parentId)
    await complete(f, await f.prepared(f.parentId, 1), 'complete-1', { consume: [signal] })
    expect(f.head(waitRecordId(waitId))?.value.state).toBe('ready')
    expect(f.head(providerStateRecordId(f.parentId))?.value.state).toBe('completed')
    const g = await setup()
    await startedParent(g, [])
    await complete(g, await g.prepared(g.parentId, 1), 'complete-empty')
    expect(g.head(actionRecordId(g.parentId))?.value.state).toBe('settled')
  })
  it('refuses while a child is open, new children, an unresolved child and references, and writes nothing', async () => {
    const f = await setup()
    await startedParent(f, ['child-a'])
    const snapshot = () => [
      f.head(providerStateRecordId(f.parentId)),
      f.head(actionRecordId(f.parentId)),
      f.head('attempt:attempt-1'),
      f.head(`receipt:${closeReceiptId(f.parentId)}`),
    ]
    const before = snapshot()
    const first = await f.prepared(f.parentId, 1)
    const writes = f.writes()
    await expect(complete(f, first, 'complete-1')).rejects.toMatchObject({
      failure: { detailCode: 'complete_children' },
    })
    await expect(complete(f, first, 'complete-2', { children: [f.child('child-b')] })).rejects.toMatchObject({
      failure: { detailCode: 'complete_new_actions' },
    })
    expect(f.writes()).toBe(writes)
    forge(f, actionRecordId(childId(f, 'child-a')), { state: 'unknown' })
    await expect(complete(f, first, 'complete-3')).rejects.toMatchObject({
      failure: { detailCode: 'complete_unknown' },
    })
    forge(f, actionRecordId(childId(f, 'child-a')), { state: 'settled' })
    await expect(
      complete(f, first, 'complete-4', {
        next: {
          kind: 'complete',
          output: fixtureRef({}),
          references: [{ pinId: 'pin', kind: 'blob' }],
        },
      }),
    ).rejects.toMatchObject({ failure: { code: 'internal', detailCode: 'unsupported' } })
    expect(snapshot()).toEqual(before)
  })
  it('takes no further transition once the parent completed', async () => {
    const f = await setup()
    await startedParent(f, [])
    await complete(f, await f.prepared(f.parentId, 1), 'complete-1')
    await expect(f.advance(await f.prepared(f.parentId, 1), 'step-2', { revision: 2 })).rejects.toMatchObject(
      { failure: { detailCode: 'action_state' } },
    )
    await expect(
      control(f, await f.prepared(f.parentId, 1), 'drain-1', {
        kind: 'begin_drain',
        target: { runId: runId(f), actionId: f.parentId },
        reason: ERROR,
      }),
    ).rejects.toMatchObject({ failure: { detailCode: 'action_state' } })
  })
})

describe('advanceProvider fail and finalize_composite', () => {
  it('starts the drain on fail without a receipt, and closes the wait a failing parent was parked on', async () => {
    const f = await setup()
    await f.start(await f.prepared(f.parentId, 1), f.parentId, 'start-1', 'attempt-1')
    const parked = await f.advance(await f.prepared(f.parentId, 1), 'step-1', {
      children: [f.child('child-a')],
      next: { kind: 'wait', condition: SIGNALS },
    })
    const waitId = stableId('wait', parked.commitId)
    const receipt = await fail(f, await f.prepared(f.parentId, 1), 'fail-1')
    expect(receipt.runRevision).toBe(1)
    expect(f.head(providerStateRecordId(f.parentId))?.value).toMatchObject({
      state: 'draining',
      waitId: null,
      providerRevision: 2,
      termination: { outcome: 'failed', error: { detailCode: 'composite_failed' } },
    })
    expect(f.head(waitRecordId(waitId))?.value.state).toBe('cancelled')
    expect(f.head(actionRecordId(f.parentId))?.value.state).toBe('running')
    expect(f.head(`receipt:${closeReceiptId(f.parentId)}`)).toBeUndefined()
    await reopened(f)
  })
  it('refuses a failing transition that creates children, with no write', async () => {
    const f = await setup()
    await startedParent(f, [])
    const invocation = await f.prepared(f.parentId, 1)
    const writes = f.writes()
    await expect(fail(f, invocation, 'fail-1', { children: [f.child('child-a')] })).rejects.toMatchObject({
      failure: { detailCode: 'fail_new_actions' },
    })
    expect(f.writes()).toBe(writes)
  })
  it('finishes a failed parent whose children settled, with the receipt, the signal and a cold reopen', async () => {
    const f = await setup()
    await settledParent(f, ['child-a', 'child-b'])
    await fail(f, await f.prepared(f.parentId, 1), 'fail-1')
    const invocation = await f.prepared(f.parentId, 1)
    const events = f.events()
    const receipt = await finalize(f, invocation, 'finalize-1')
    expect(f.events()).toBe(events + 1)
    expect(receipt.runRevision).toBe(1)
    const receiptId = closeReceiptId(f.parentId)
    expect(f.head(`receipt:${receiptId}`)?.value.receipt).toMatchObject({
      outcome: 'failed',
      error: { detailCode: 'composite_failed' },
      attemptId: 'attempt-1',
    })
    expect(f.head(providerStateRecordId(f.parentId))?.value).toMatchObject({
      state: 'failed',
      providerRevision: 3,
      termination: { outcome: 'failed' },
    })
    expect(f.head(actionRecordId(f.parentId))?.value.state).toBe('settled')
    expect(f.head('attempt:attempt-1')?.value.state).toBe('settled')
    expect(f.signalsFor(null)).toHaveLength(1)
    const writes = f.writes()
    expect(await finalize(f, invocation, 'finalize-1', { expectedProviderRevision: 2 })).toEqual(receipt)
    expect(f.writes()).toBe(writes)
    await reopened(f)
  })
  it('cancels a parent that began draining on request, even in a cancelled run', async () => {
    const f = await setup()
    await startedParent(f, [])
    await control(f, await f.prepared(null, 1), 'cancel-run', {
      kind: 'cancel_run',
      runId: runId(f),
      reason: 'operator',
      requestedBy: 'operator-1',
    })
    await control(f, await f.prepared(f.parentId, 1), 'drain-1', {
      kind: 'begin_drain',
      target: { runId: runId(f), actionId: f.parentId },
      reason: ERROR,
    })
    await finalize(f, await f.prepared(f.parentId, 1), 'finalize-1', {
      outcome: 'cancelled',
      error: { ...ERROR, code: 'cancelled' },
    })
    expect(f.head(`receipt:${closeReceiptId(f.parentId)}`)?.value.receipt.outcome).toBe('cancelled')
    expect(f.head(providerStateRecordId(f.parentId))?.value).toMatchObject({
      state: 'failed',
      termination: { outcome: 'cancelled' },
    })
    await reopened(f)
  })
  it('refuses a parent that did not drain, a stale revision, a different failure and a child still open', async () => {
    const f = await setup()
    await startedParent(f, ['child-a'])
    const snapshot = () => [
      f.head(providerStateRecordId(f.parentId)),
      f.head(actionRecordId(f.parentId)),
      f.head('attempt:attempt-1'),
    ]
    await expect(finalize(f, await f.prepared(f.parentId, 1), 'finalize-1')).rejects.toMatchObject({
      failure: { detailCode: 'provider_state' },
    })
    await fail(f, await f.prepared(f.parentId, 1), 'fail-1')
    const invocation = await f.prepared(f.parentId, 1)
    const before = snapshot()
    const writes = f.writes()
    await expect(
      finalize(f, invocation, 'finalize-2', { expectedProviderRevision: 1 }),
    ).rejects.toMatchObject({
      failure: { detailCode: 'provider_revision' },
    })
    await expect(finalize(f, invocation, 'finalize-3', { outcome: 'cancelled' })).rejects.toMatchObject({
      failure: { detailCode: 'termination' },
    })
    await expect(
      finalize(f, invocation, 'finalize-4', { error: { ...ERROR, message: 'other' } }),
    ).rejects.toMatchObject({ failure: { detailCode: 'termination' } })
    await expect(finalize(f, invocation, 'finalize-5')).rejects.toMatchObject({
      failure: { detailCode: 'finalize_children' },
    })
    expect(snapshot()).toEqual(before)
    expect(f.writes()).toBe(writes)
  })
  it('accepts an unresolved child only with its reconciliation owner named, and never as a success', async () => {
    const f = await setup()
    await startedParent(f, ['child-a'])
    await fail(f, await f.prepared(f.parentId, 1), 'fail-1')
    const childRecord = actionRecordId(childId(f, 'child-a'))
    forge(f, childRecord, { state: 'unknown', ownerRef: OWNER })
    const invocation = await f.prepared(f.parentId, 1)
    const writes = f.writes()
    await expect(finalize(f, invocation, 'finalize-1')).rejects.toMatchObject({
      failure: { detailCode: 'finalize_children' },
    })
    await expect(
      finalize(f, invocation, 'finalize-2', { ownerRefs: [{ kind: 'reconciliation', id: 'other' }] }),
    ).rejects.toMatchObject({ failure: { detailCode: 'finalize_children' } })
    expect(f.writes()).toBe(writes)
    forge(f, childRecord, { state: 'unknown', ownerRef: { kind: 'run', id: runId(f) } })
    await expect(finalize(f, invocation, 'finalize-3', { ownerRefs: [OWNER] })).rejects.toMatchObject({
      failure: { detailCode: 'finalize_children' },
    })
    forge(f, childRecord, { state: 'unknown', ownerRef: OWNER })
    await finalize(f, invocation, 'finalize-4', { ownerRefs: [OWNER] })
    expect(f.head(`receipt:${closeReceiptId(f.parentId)}`)?.value.receipt.outcome).toBe('failed')
    expect(f.head(actionRecordId(childId(f, 'child-a')))?.value.state).toBe('unknown')
  })
  it('refuses an owner reference that belongs to no open child', async () => {
    const f = await setup()
    await settledParent(f, ['child-a'])
    await fail(f, await f.prepared(f.parentId, 1), 'fail-1')
    await expect(
      finalize(f, await f.prepared(f.parentId, 1), 'finalize-1', { ownerRefs: [OWNER] }),
    ).rejects.toMatchObject({ failure: { detailCode: 'owner_ref' } })
  })
})

describe('settle_undispatched', () => {
  it('settles a prepared action with a zero-effect control attempt and publishes the result', async () => {
    const f = await setup()
    const invocation = await f.prepared(null, 1)
    const events = f.events()
    const receipt = await settleUndispatched(f, invocation, 'settle-1', f.leafParentId)
    expect(f.events()).toBe(events + 1)
    expect(receipt.runRevision).toBe(1)
    const controlId = stableId('ctl', `settle\0${f.leafParentId}`)
    const receiptId = stableId('rcpt', `settle\0${f.leafParentId}`)
    expect(f.head(`attempt:${controlId}`)?.value).toMatchObject({
      kind: 'control',
      number: 0,
      state: 'settled',
      requestIdentity: null,
      authorizationRef: null,
      externalRequests: [],
      receiptIds: [receiptId],
    })
    expect(f.head(`receipt:${receiptId}`)?.value.receipt).toMatchObject({
      outcome: 'failed',
      attemptId: controlId,
      error: { detailCode: 'composite_failed' },
    })
    expect(f.head(actionRecordId(f.leafParentId))?.value).toMatchObject({
      state: 'settled',
      currentAttemptId: controlId,
      firstReceiptId: receiptId,
    })
    expect(f.head(`visibility:${receiptId}`)?.value.state).toBe('ready')
    expect(f.signalsFor(null)).toHaveLength(1)
    const writes = f.writes()
    expect(
      await settleUndispatched(f, invocation, 'settle-1', f.leafParentId, { expectedActionRevision: 1 }),
    ).toEqual(receipt)
    expect(f.writes()).toBe(writes)
    await reopened(f)
  })
  it('records a cancellation as cancelled, and works in a draining run, which is how pending work is closed', async () => {
    const f = await setup()
    await control(f, await f.prepared(null, 1), 'drain-1', {
      kind: 'begin_drain',
      target: { runId: runId(f), actionId: null },
      reason: ERROR,
    })
    await settleUndispatched(f, await f.prepared(null, 1), 'settle-1', f.leafParentId, {
      outcome: 'cancelled',
      error: { ...ERROR, code: 'cancelled' },
    })
    expect(f.head(`receipt:${stableId('rcpt', `settle\0${f.leafParentId}`)}`)?.value.receipt.outcome).toBe(
      'cancelled',
    )
    await reopened(f)
  })
  it('signals the parent of a child it settles, so a parent can then complete', async () => {
    const f = await setup()
    await startedParent(f, ['child-a', 'child-b'])
    const invocation = await f.prepared(f.parentId, 1)
    await f.complete(childId(f, 'child-a'), f.child('child-a'), invocation, 'child-a')
    await settleUndispatched(f, invocation, 'settle-1', childId(f, 'child-b'))
    expect(f.signalsFor(f.parentId)).toHaveLength(2)
    expect(f.head(actionRecordId(childId(f, 'child-b')))?.value.state).toBe('settled')
    await complete(f, await f.prepared(f.parentId, 1), 'complete-1')
    expect(f.head(actionRecordId(f.parentId))?.value.state).toBe('settled')
    await reopened(f)
  })
  it('refuses a stale revision, an action that has an attempt, a settled action and a foreign action, writing nothing', async () => {
    const f = await setup()
    await f.start(await f.prepared(f.parentId, 1), f.parentId, 'start-1', 'attempt-1')
    const invocation = await f.prepared(null, 1)
    const writes = f.writes()
    await expect(
      settleUndispatched(f, invocation, 'settle-1', f.leafParentId, { expectedActionRevision: 9 }),
    ).rejects.toMatchObject({ failure: { detailCode: 'action_state' } })
    await expect(settleUndispatched(f, invocation, 'settle-2', f.parentId)).rejects.toMatchObject({
      failure: { detailCode: 'action_state' },
    })
    await expect(
      settleUndispatched(f, invocation, 'settle-3', 'no-such-action', { expectedActionRevision: 1 }),
    ).rejects.toMatchObject({ failure: { detailCode: 'action_state' } })
    expect(f.writes()).toBe(writes)
    await settleUndispatched(f, invocation, 'settle-4', f.leafParentId)
    const settled = f.writes()
    await expect(settleUndispatched(f, invocation, 'settle-5', f.leafParentId)).rejects.toMatchObject({
      failure: { detailCode: 'action_state' },
    })
    expect(f.writes()).toBe(settled)
  })
})
