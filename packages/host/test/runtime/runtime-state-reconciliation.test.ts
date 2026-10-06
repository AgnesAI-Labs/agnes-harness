import type { PreparedAction } from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { UNIMPLEMENTED_STATE_METHODS } from '../../src/runtime/providers/state.js'
import { actionRecordId, stableId } from '../../src/runtime/state/records.js'
import { fixtureRef } from './fixtures/assembly-maintenance-wire.js'
import { cleanup, reopened, setup } from './fixtures/state-composite-fixture.js'

afterEach(cleanup)

type Fixture = Awaited<ReturnType<typeof setup>>

const OWNER = { kind: 'reconciliation' as const, id: 'reconciliation-1' }
const DEADLINE = '2027-01-01T00:00:00Z'
const EFFECT = { outcome: 'succeeded' as const, externalRequests: [], usage: [], references: [] }
const FOUND = { kind: 'resolved' as const, evidence: fixtureRef({ e: 'found' }), result: EFFECT }
const MISSING = { kind: 'not_found' as const, evidence: fixtureRef({ e: 'missing' }), safeToRetry: false }
const UNKNOWN = { kind: 'unknown' as const, evidence: fixtureRef({ e: 'unknown' }), reason: 'no answer yet' }

const runId = (f: Fixture) => f.admission.runId
const childId = (f: Fixture, key: string) => stableId('act', `${runId(f)}\0${f.parentId}\0${key}`)
const checkRecord = (checkId: string) => `reconciliation:${checkId}`

function control(f: Fixture, invocation: string, commitId: string, command: unknown) {
  const revision = Number(f.head(`run:${runId(f)}`)?.value.revision)
  return f.joint.state.commitControl({ commitId, guard: f.guardFor(invocation, revision), command } as never)
}

/** A started parent with one dispatched child whose attempt is marked unknown with the real command. */
async function unknownChild(f: Fixture) {
  await f.start(await f.prepared(f.parentId, 1), f.parentId, 'start-1', 'attempt-1')
  const child = f.child('child-a')
  const invocation = await f.prepared(f.parentId, 1)
  await f.advance(invocation, 'step-1', { children: [child] })
  const admitted = await f.dispatch(childId(f, 'child-a'), child as PreparedAction, invocation, 'child-a')
  if (admitted.state !== 'admitted') throw Error('child dispatch was refused')
  const open = await f.prepared(null, 1)
  await control(f, open, 'unknown-a', {
    kind: 'mark_unknown',
    attemptId: 'attempt-child-a',
    expectedAttemptRevision: 1,
    evidence: [],
    reconciliationOwnerRef: OWNER,
    reason: 'the answer was lost',
  })
  return { action: childId(f, 'child-a'), invocation: open }
}

const begin = (f: Fixture, invocationId: string, action: string, patch: Record<string, unknown> = {}) =>
  f.joint.state.beginReconciliation({
    requestId: 'begin-1',
    checkId: 'check-1',
    actionId: action,
    expectedActionRevision: Number(f.head(actionRecordId(action))?.revision),
    bindingId: f.joint.binding.bindingId,
    invocationId,
    lookupMethod: 'reconcile',
    input: fixtureRef({ lookup: 'receipt' }),
    deadline: DEADLINE,
    ...patch,
  } as never)

const complete = (f: Fixture, result: unknown, patch: Record<string, unknown> = {}) =>
  f.joint.state.completeReconciliation({
    requestId: 'complete-1',
    checkId: 'check-1',
    result,
    evidence: [fixtureRef({ e: 'lookup' })],
    ...patch,
  } as never)

/** Rewrites the stored body of the current version. Used only to reach states no command produces. */
function forge(f: Fixture, recordId: string, patch: Record<string, unknown>) {
  const head = f.head(recordId)
  if (!head) throw Error(`no record ${recordId}`)
  f.joint.db
    .prepare('UPDATE runtime_version_bodies SET value_json=? WHERE record_id=? AND record_revision=?')
    .run(JSON.stringify({ ...head.value, ...patch }), recordId, head.revision)
}

describe('beginReconciliation', () => {
  it('is a real State method through the store, and refuses input that breaks its schema', async () => {
    expect(UNIMPLEMENTED_STATE_METHODS).not.toContain('beginReconciliation')
    expect(UNIMPLEMENTED_STATE_METHODS).not.toContain('completeReconciliation')
    const f = await setup()
    const { store, context } = f.joint
    const writes = f.writes()
    for (const refused of [
      await store.beginReconciliation({ requestId: 'x' } as never, context()),
      await store.completeReconciliation({ requestId: 'x' } as never, context()),
    ]) {
      expect(refused.ok).toBe(false)
      if (!refused.ok) expect(refused.error).toMatchObject({ code: 'invalid_input', detailCode: 'schema' })
    }
    expect(f.writes()).toBe(writes)
    const { action, invocation } = await unknownChild(f)
    const opened = await store.beginReconciliation(
      {
        requestId: 'begin-1',
        checkId: 'check-1',
        actionId: action,
        expectedActionRevision: Number(f.head(actionRecordId(action))?.revision),
        bindingId: f.joint.binding.bindingId,
        invocationId: invocation,
        lookupMethod: 'reconcile',
        input: fixtureRef({ lookup: 'receipt' }),
        deadline: DEADLINE,
      } as never,
      context(),
    )
    expect(opened.ok && opened.value.state).toBe('admitted')
    const done = await store.completeReconciliation(
      { requestId: 'complete-1', checkId: 'check-1', result: UNKNOWN, evidence: [] } as never,
      context(),
    )
    expect(done.ok && done.value.state).toBe('unknown')
  })
  it('persists the check, moves the action to reconciling in one commit, and replays', async () => {
    const f = await setup()
    const { action, invocation } = await unknownChild(f)
    const events = f.events()
    const revision = Number(f.head(actionRecordId(action))?.revision)
    const check = await begin(f, invocation, action)
    expect(check).toEqual({
      checkId: 'check-1',
      actionId: action,
      bindingId: f.joint.binding.bindingId,
      invocationId: invocation,
      lookupMethod: 'reconcile',
      input: fixtureRef({ lookup: 'receipt' }),
      state: 'admitted',
      deadline: DEADLINE,
      result: null,
      evidenceRefs: [],
    })
    expect(f.events()).toBe(events + 1)
    expect(f.head(checkRecord('check-1'))?.value).toEqual(check)
    expect(f.head(actionRecordId(action))?.value).toMatchObject({ state: 'reconciling', ownerRef: OWNER })
    expect(f.head('attempt:attempt-child-a')?.value.state).toBe('unknown')
    expect(f.head(`run:${runId(f)}`)?.value.revision).toBe(1)
    const writes = f.writes()
    expect(await begin(f, invocation, action, { expectedActionRevision: revision })).toEqual(check)
    expect(await begin(f, invocation, action, { requestId: 'begin-again' })).toEqual(check)
    expect(f.writes()).toBe(writes)
    await reopened(f)
  })
  it('opens a second check for an action that is already reconciling without moving it again', async () => {
    const f = await setup()
    const { action, invocation } = await unknownChild(f)
    await begin(f, invocation, action)
    const revision = f.head(actionRecordId(action))?.revision
    await begin(f, invocation, action, { requestId: 'begin-2', checkId: 'check-2' })
    expect(f.head(actionRecordId(action))?.revision).toBe(revision)
    expect(f.head(checkRecord('check-2'))?.value.state).toBe('admitted')
    await reopened(f)
  })
  it('refuses a stale revision, a settled action, another binding, a bad lookup, a foreign invocation and a past deadline', async () => {
    const f = await setup()
    const { action, invocation } = await unknownChild(f)
    const before = [f.head(actionRecordId(action)), f.head(checkRecord('check-1'))]
    const writes = f.writes()
    const refused = (patch: Record<string, unknown>, detail: string, target = action) =>
      expect(begin(f, invocation, target, patch)).rejects.toMatchObject({ failure: { detailCode: detail } })
    await refused({ expectedActionRevision: 9 }, 'action_state')
    await refused({}, 'action_state', f.parentId)
    await refused({ bindingId: 'another-binding' }, 'binding')
    await refused({ lookupMethod: 'nothing' }, 'lookup_method')
    await refused({ lookupMethod: 'invoke' }, 'lookup_method')
    await refused({ lookupMethod: 'describe' }, 'lookup_method')
    await refused({ invocationId: 'no-invocation' }, 'invocation_absent')
    await refused({ deadline: '2020-01-01T00:00:00Z' }, 'deadline')
    await refused({ expectedActionRevision: 1 }, 'action_absent', 'no-such-action')
    expect([f.head(actionRecordId(action)), f.head(checkRecord('check-1'))]).toEqual(before)
    expect(f.writes()).toBe(writes)
    const other = f.head(`invocation:${invocation}`)
    forge(f, `invocation:${invocation}`, { runId: 'another-run' })
    const forged = f.writes()
    await refused({}, 'invocation_state')
    expect(f.writes()).toBe(forged)
    forge(f, `invocation:${invocation}`, { runId: other?.value.runId })
    await begin(f, invocation, action)
    await complete(f, FOUND)
    expect(await begin(f, invocation, action, { requestId: 'begin-4' })).toMatchObject({ state: 'completed' })
    await refused({ requestId: 'begin-2', input: fixtureRef({ lookup: 'other' }) }, 'check_exists')
    await refused(
      { requestId: 'begin-3', lookupMethod: 'reconcile', deadline: '2027-06-01T00:00:00Z' },
      'check_exists',
    )
    await refused({ requestId: 'begin-1', input: fixtureRef({ lookup: 'other' }) }, 'idempotency_conflict')
  })
})

describe('completeReconciliation', () => {
  it('stores a resolved answer and its evidence once, and leaves the action to resolve_action', async () => {
    const f = await setup()
    const { action, invocation } = await unknownChild(f)
    await begin(f, invocation, action)
    const events = f.events()
    const done = await complete(f, FOUND, { evidence: [fixtureRef({ e: 'lookup' }), FOUND.evidence] })
    expect(f.events()).toBe(events + 1)
    expect(done).toMatchObject({ state: 'completed', result: FOUND })
    expect(done.evidenceRefs).toEqual([fixtureRef({ e: 'lookup' }), FOUND.evidence])
    expect(f.head(checkRecord('check-1'))?.value).toEqual(done)
    expect(f.head(actionRecordId(action))?.value.state).toBe('reconciling')
    expect(f.head('attempt:attempt-child-a')?.value.state).toBe('unknown')
    const writes = f.writes()
    expect(await complete(f, FOUND, { evidence: [fixtureRef({ e: 'lookup' }), FOUND.evidence] })).toEqual(
      done,
    )
    expect(
      await complete(f, FOUND, { requestId: 'complete-2', evidence: [fixtureRef({ e: 'lookup' })] }),
    ).toEqual(done)
    expect(f.writes()).toBe(writes)
    await expect(complete(f, MISSING, { requestId: 'complete-3' })).rejects.toMatchObject({
      failure: { detailCode: 'check_state' },
    })
    await expect(
      complete(
        f,
        { ...MISSING, evidence: FOUND.evidence },
        { requestId: 'complete-5', evidence: [fixtureRef({ e: 'lookup' })] },
      ),
    ).rejects.toMatchObject({ failure: { detailCode: 'check_state' } })
    await expect(
      complete(f, FOUND, { requestId: 'complete-4', evidence: [fixtureRef({ e: 'other' })] }),
    ).rejects.toMatchObject({ failure: { detailCode: 'check_state' } })
    expect(f.writes()).toBe(writes)
    await reopened(f)
  })
  it('keeps an unknown answer unknown and puts the action back, and a not-found answer proves nothing', async () => {
    const f = await setup()
    const { action, invocation } = await unknownChild(f)
    await begin(f, invocation, action)
    const unknown = await complete(f, UNKNOWN)
    expect(unknown).toMatchObject({ state: 'unknown', result: UNKNOWN })
    expect(f.head(actionRecordId(action))?.value.state).toBe('unknown')
    await begin(f, invocation, action, { requestId: 'begin-2', checkId: 'check-2' })
    expect(f.head(actionRecordId(action))?.value.state).toBe('reconciling')
    const missing = await complete(f, MISSING, { requestId: 'complete-2', checkId: 'check-2' })
    expect(missing).toMatchObject({ state: 'completed', result: { kind: 'not_found', safeToRetry: false } })
    expect(f.head(actionRecordId(action))?.value.state).toBe('reconciling')
    expect(f.head('attempt:attempt-child-a')?.value.state).toBe('unknown')
    expect(f.head(`resolution:${stableId('res', action)}`)?.value.state).toBe('unresolved')
    await control(f, invocation, 'resolve-1', {
      kind: 'resolve_action',
      actionId: action,
      expectedActionRevision: Number(f.head(actionRecordId(action))?.revision),
      selectedReceiptId: null,
      evidence: [MISSING.evidence],
      state: 'unresolved',
      ownerRef: OWNER,
      nextCheckAt: '2026-11-01T00:00:00Z',
    })
    expect(f.head(`resolution:${stableId('res', action)}`)?.value).toMatchObject({
      state: 'unresolved',
      nextCheckAt: '2026-11-01T00:00:00Z',
    })
    await reopened(f)
  })
  it('refuses to write without a live writer lease', async () => {
    const f = await setup()
    const { action, invocation } = await unknownChild(f)
    await begin(f, invocation, action)
    f.joint.db.prepare('UPDATE runtime_leases SET lease_until=1').run()
    const writes = f.writes()
    await expect(complete(f, UNKNOWN)).rejects.toMatchObject({ failure: { detailCode: 'writer_lease' } })
    await expect(
      begin(f, invocation, action, { requestId: 'begin-2', checkId: 'check-2' }),
    ).rejects.toMatchObject({ failure: { detailCode: 'writer_lease' } })
    expect(f.writes()).toBe(writes)
  })
  it('refuses a check that does not exist, writing nothing', async () => {
    const f = await setup()
    await unknownChild(f)
    const writes = f.writes()
    await expect(complete(f, FOUND, { checkId: 'no-such-check' })).rejects.toMatchObject({
      failure: { detailCode: 'check_absent' },
    })
    expect(f.writes()).toBe(writes)
  })
  it('keeps the late answer as evidence when the action no longer needs it', async () => {
    const f = await setup()
    const { action, invocation } = await unknownChild(f)
    await begin(f, invocation, action)
    forge(f, actionRecordId(action), { state: 'settled' })
    const done = await complete(f, UNKNOWN)
    expect(done.state).toBe('unknown')
    expect(f.head(actionRecordId(action))?.value.state).toBe('settled')
  })
})
